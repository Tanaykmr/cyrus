import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationCheckpointStore } from "../src/automations/CheckpointStore.js";
import {
	type AutomationAuthority,
	type AutomationRegistration,
	authorizeTool,
	checkpointKey,
	definitionSchema,
	scopedToolResult,
	toolCallSchema,
} from "../src/automations/contract.js";
import { AutomationLedger } from "../src/automations/Ledger.js";
import { modelReadiness } from "../src/automations/Model.js";
import { registerConfiguredAutomations } from "../src/automations/register.js";
import { latestTick } from "../src/automations/scheduling.js";

const dirs: string[] = [];
const ledgers: AutomationLedger[] = [];
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "cyrus-automation-test-"));
	dirs.push(dir);
	return dir;
}
function definition(
	overrides: Partial<AutomationRegistration> = {},
): AutomationRegistration {
	return {
		id: "generic-daily-review",
		workspaceId: "workspace-a",
		ownerId: "operator",
		namespace: "general-ops",
		scopeRef: "operations-review",
		revision: 1,
		state: "enabled",
		role: "coordinator",
		instruction: "Review the assigned issue",
		schedule: null,
		target: { harness: "claude", model: "claude-fixture" },
		...overrides,
	};
}
function authority(
	overrides: Partial<AutomationAuthority> = {},
): AutomationAuthority {
	return {
		contractVersion: 1,
		definition: {
			...definition(),
			grants: [
				{
					id: "bound-grant",
					connectionId: "connected-linear",
					accountId: "account-a",
					resource: {
						provider: "linear",
						teamId: "team-a",
						issueId: "issue-a",
					},
					permissions: ["read", "write"],
				},
			],
		},
		occurrenceId: "occurrence-a",
		attemptId: "attempt-a",
		fence: 1,
		leaseUntil: new Date(Date.now() + 90000).toISOString(),
		phase: "execute",
		input: "Instruction",
		...overrides,
	};
}
async function ledger(now: () => number = Date.now) {
	const result = new AutomationLedger(await directory(), "workspace-a", now);
	ledgers.push(result);
	return result;
}
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const db of ledgers.splice(0)) db.close();
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("registered runtime transport", () => {
	it("uses existing pairing and configured model, rejects wrong key and cross-workspace re-pairing", async () => {
		vi.stubEnv("CYRUS_TEAM_ID", "workspace-a");
		vi.stubEnv("CYRUS_API_KEY", "supervisor-fixture");
		vi.stubEnv("CYRUS_APP_URL", "https://hosted.fixture");
		vi.stubEnv("ANTHROPIC_API_KEY", "model-fixture");
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
		vi.stubEnv("CYRUS_DEFAULT_RUNNER", "claude");
		vi.stubEnv("CYRUS_CLAUDE_DEFAULT_MODEL", "claude-fixture");
		const app = Fastify();
		registerConfiguredAutomations(app, await directory(), () => ({}));
		try {
			await app.ready();
			expect(
				(await app.inject({ url: "/api/automations/v1/capabilities" }))
					.statusCode,
			).toBe(401);
			const headers = { authorization: "Bearer supervisor-fixture" };
			const capabilities = (
				await app.inject({ url: "/api/automations/v1/capabilities", headers })
			).json();
			expect(capabilities.available).toBe(true);
			expect(capabilities.capabilities.nativeTools).toBe(false);
			expect(capabilities.target).toEqual({
				harness: "claude",
				model: "claude-fixture",
				adapter: "anthropic-messages-contained-v1",
			});
			vi.stubEnv("CYRUS_TEAM_ID", "workspace-b");
			expect(
				(await app.inject({ url: "/api/automations/v1/capabilities", headers }))
					.statusCode,
			).toBe(401);
		} finally {
			await app.close();
		}
	});
	it("does not break legacy HTTP setups or misreport incompatible harness readiness", async () => {
		vi.stubEnv("CYRUS_TEAM_ID", "workspace-a");
		vi.stubEnv("CYRUS_API_KEY", "supervisor-fixture");
		vi.stubEnv("CYRUS_APP_URL", "http://localhost:3000");
		vi.stubEnv("CYRUS_DEFAULT_RUNNER", "codex");
		const app = Fastify();
		registerConfiguredAutomations(app, await directory(), () => ({}));
		try {
			await app.ready();
			const headers = { authorization: "Bearer supervisor-fixture" };
			const result = await app.inject({
				url: "/api/automations/v1/capabilities",
				headers,
			});
			expect(result.statusCode).toBe(200);
			expect(result.json().available).toBe(false);
			expect(result.json().reason).toMatch(/HTTPS/);
		} finally {
			await app.close();
		}
	});
});

describe("generic durable automations", () => {
	it("persists non-customer instructions/revisions/tombstones and deduplicates redelivery", async () => {
		const path = await directory();
		const first = new AutomationLedger(path, "workspace-a");
		first.upsert(definition());
		const occurrence = first.enqueue(definition().id, 1, "event-a", "do work");
		expect(first.enqueue(definition().id, 1, "event-a", "do work")).toEqual(
			occurrence,
		);
		expect(() =>
			first.enqueue(definition().id, 1, "event-a", "changed"),
		).toThrow("payload conflict");
		first.close();
		const restarted = new AutomationLedger(path, "workspace-a");
		ledgers.push(restarted);
		expect(restarted.status(definition().id).occurrences).toHaveLength(1);
		expect(() =>
			restarted.upsert(definition({ instruction: "same revision changed" })),
		).toThrow("revision conflict");
		restarted.upsert(definition({ revision: 2, state: "paused" }));
		expect(restarted.claim(2)).toEqual([]);
		expect(() => restarted.upsert(definition())).toThrow("revision conflict");
		restarted.upsert(definition({ revision: 3, state: "deleted" }));
		expect(() => restarted.upsert(definition({ revision: 4 }))).toThrow(
			"immutable",
		);
	});
	it("coalesces offline ticks, preserves explicit FIFO and never catches up paused time", async () => {
		let now = Date.parse("2026-01-01T12:00:00Z");
		const db = await ledger(() => now);
		const d = definition({
			schedule: {
				intervalSeconds: 60,
				anchorAt: "2026-01-01T00:00:00Z",
				timezone: "UTC",
			},
		});
		db.upsert(d);
		db.enqueue(d.id, 1, "event-1", "first");
		db.enqueue(d.id, 1, "event-2", "second");
		const [one] = db.claim(2);
		expect(one?.occurrence.input).toBe("first");
		db.finish(one!.occurrence, true);
		const [two] = db.claim(2);
		expect(two?.occurrence.input).toBe("second");
		db.finish(two!.occurrence, true);
		const [tick] = db.claim(2);
		expect(tick?.occurrence.trigger).toBe("tick");
		db.finish(tick!.occurrence, true);
		expect(db.claim(2)).toEqual([]);
		db.upsert({ ...d, revision: 2, state: "paused" });
		now += 3600000;
		db.upsert({ ...d, revision: 3 });
		expect(db.claim(2)).toEqual([]);
		now += 60000;
		expect(db.claim(2)).toHaveLength(1);
	});
	it("serializes claims across SQLite connections and fences stale takeover/edited attempts", async () => {
		let now = Date.now();
		const dir = await directory();
		const a = new AutomationLedger(dir, "workspace-a", () => now);
		const b = new AutomationLedger(dir, "workspace-a", () => now);
		ledgers.push(a, b);
		a.upsert(definition());
		a.enqueue(definition().id, 1, "event", "work");
		const [first] = a.claim(2);
		expect(b.claim(2)).toEqual([]);
		now += 90001;
		const [takeover] = b.claim(2);
		expect(takeover!.occurrence.fence).toBe(2);
		expect(takeover!.occurrence.attemptId).not.toBe(
			first!.occurrence.attemptId,
		);
		expect(() => a.renew(first!.occurrence)).toThrow("Stale");
		a.finish(first!.occurrence, true);
		expect(b.status(definition().id).occurrences[0]!.status).toBe("running");
		b.upsert(definition({ revision: 2, state: "paused" }));
		expect(() => b.renew(takeover!.occurrence)).toThrow("unavailable");
	});
	it("bounds queue, workspace concurrency, per-namespace ownership and retry budget", async () => {
		let now = Date.now();
		const db = await ledger(() => now);
		for (let i = 0; i < 4; i++) {
			const d = definition({
				id: `a${i}`,
				namespace: i === 1 ? "n0" : `n${i}`,
			});
			db.upsert(d);
			db.enqueue(d.id, 1, "event", "work");
		}
		const claims = db.claim(10);
		expect(claims).toHaveLength(2);
		expect(new Set(claims.map((c) => c.definition.namespace)).size).toBe(2);
		for (const c of claims) db.finish(c.occurrence, false);
		const d = definition({ id: "queue" });
		db.upsert(d);
		for (let i = 0; i < 32; i++) db.enqueue(d.id, 1, `e${i}`, "work");
		expect(() => db.enqueue(d.id, 1, "e33", "work")).toThrow("queue full");
		const solo = await ledger(() => now);
		solo.upsert(definition());
		solo.enqueue(definition().id, 1, "e", "work");
		for (let attempt = 1; attempt <= 3; attempt++) {
			const [claim] = solo.claim(1);
			expect(claim!.occurrence.attempts).toBe(attempt);
			solo.finish(claim!.occurrence, false);
			now += 11000;
		}
		expect(solo.claim(1)).toEqual([]);
		expect(solo.status(definition().id).occurrences[0]!.status).toBe("blocked");
	});
	it("rejects cross-workspace definitions and invalid timezone; tick identity binds revision", async () => {
		const db = await ledger();
		expect(() => db.upsert(definition({ workspaceId: "workspace-b" }))).toThrow(
			"workspace",
		);
		const d = definition({
			schedule: {
				intervalSeconds: 60,
				anchorAt: "2026-01-01T00:00:00Z",
				timezone: "UTC",
			},
		});
		expect(latestTick(d, Date.parse(d.schedule!.anchorAt), null)?.key).not.toBe(
			latestTick({ ...d, revision: 2 }, Date.parse(d.schedule!.anchorAt), null)
				?.key,
		);
		expect(() =>
			db.upsert({ ...d, schedule: { ...d.schedule, timezone: "not/a/zone" } }),
		).toThrow();
	});
});

describe("resource-bound tools and private resume", () => {
	it.each([
		"workspaceId",
		"customerId",
		"accountId",
		"connectionId",
		"channelId",
		"threadTs",
		"issueId",
		"role",
		"runId",
		"grantId",
		"resourceRef",
		"actionId",
		"url",
	])("rejects model-selected %s even on a permitted tool", (field) => {
		expect(() =>
			authorizeTool(authority(), {
				name: "get_issue",
				arguments: { [field]: "foreign" },
			}),
		).toThrow();
	});
	it("denies aliases/search and worker escalation; coordinator writes remain exact-resource scoped", () => {
		for (const name of [
			"linear.get_issue",
			"mcp__linear__get_issue",
			"search",
			"fetch",
			"Bash",
		])
			expect(toolCallSchema.safeParse({ name, arguments: {} }).success).toBe(
				false,
			);
		const a = authority();
		expect(
			authorizeTool(a, {
				name: "add_comment",
				arguments: { text: "Approved text" },
			}),
		).toEqual(a.definition.grants[0]);
		for (const role of ["investigator", "engineering"] as const)
			expect(() =>
				authorizeTool(
					{ ...a, definition: { ...a.definition, role } },
					{ name: "add_comment", arguments: { text: "No" } },
				),
			).toThrow();
		expect(() =>
			authorizeTool(a, {
				name: "reply",
				arguments: { text: "wrong provider" },
			}),
		).toThrow();
	});
	it("rejects provider overreturn and hides fixed authority metadata in model tool results", () => {
		const a = authority(),
			grant = a.definition.grants[0]!;
		const result = {
			items: [
				{
					grantId: grant.id,
					connectionId: grant.connectionId,
					accountId: grant.accountId,
					resource: grant.resource,
					text: "Scoped issue",
				},
			],
			nextCursor: null,
		};
		expect(
			scopedToolResult(a, { name: "get_issue", arguments: {} }, result),
		).toEqual({ items: [{ text: "Scoped issue" }], nextCursor: null });
		expect(() =>
			scopedToolResult(
				a,
				{ name: "get_issue", arguments: {} },
				{ ...result, items: [{ ...result.items[0], accountId: "foreign" }] },
			),
		).toThrow();
		expect(
			definitionSchema.safeParse({ ...a.definition, grants: [grant, grant] })
				.success,
		).toBe(false);
	});
	it("isolates checkpoint keys by customer namespace, workspace, revision and occurrence, never attempt", async () => {
		const a = authority(),
			key = checkpointKey(a);
		const dir = await directory();
		const store = new AutomationCheckpointStore(dir);
		await store.save({
			version: 1,
			scopeKey: key,
			messages: [{ role: "user", content: "private" }],
			sequence: 0,
			status: "running",
		});
		for (const patch of [
			{ namespace: "customer-b" },
			{ workspaceId: "workspace-b" },
			{ revision: 2 },
		])
			expect(
				await store.load(
					checkpointKey({ ...a, definition: { ...a.definition, ...patch } }),
				),
			).toBeUndefined();
		expect(checkpointKey({ ...a, attemptId: "next", fence: 2 })).toBe(key);
		expect(
			await store.load(checkpointKey({ ...a, occurrenceId: "another" })),
		).toBeUndefined();
		expect(await readdir(dir)).toEqual([`${key}.json`]);
		expect(await readFile(join(dir, `${key}.json`), "utf8")).not.toContain(
			"token",
		);
		const other = checkpointKey({ ...a, occurrenceId: "symlink" });
		await symlink(join(dir, `${key}.json`), join(dir, `${other}.json`));
		expect(store.load(other)).rejects.toThrow();
		await writeFile(
			join(dir, `${key}.json`),
			JSON.stringify({
				version: 1,
				scopeKey: "f".repeat(64),
				messages: [],
				sequence: 0,
				status: "running",
			}),
		);
		expect(store.load(key)).rejects.toThrow("scope mismatch");
	});
	it("reports configured incompatible auth/harness/model rather than switching", () => {
		const good = {
			harness: "claude",
			model: "claude-fixture",
			apiKey: "fixture",
		};
		expect(modelReadiness(good)).toBeNull();
		for (const patch of [
			{ harness: "codex" },
			{ model: "sonnet" },
			{ apiKey: "" },
			{ oauthToken: "fixture-oauth" },
		])
			expect(modelReadiness({ ...good, ...patch })).not.toBeNull();
	});
});
