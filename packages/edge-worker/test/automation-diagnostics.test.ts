import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AutomationRuntime } from "../src/automations/AutomationRuntime.js";
import { AutomationCheckpointStore } from "../src/automations/CheckpointStore.js";
import type { AutomationRegistration } from "../src/automations/contract.js";
import {
	AutomationDiagnosticError,
	safeDiagnostic,
} from "../src/automations/Diagnostics.js";
import { AutomationHttpGateway } from "../src/automations/Gateway.js";
import { AutomationLedger } from "../src/automations/Ledger.js";

it.each([
	"http",
	"schema",
	"identity",
	"mcp",
])("persists safe %s failure before checkpoint, through retry exhaustion and restart", async (kind) => {
	const root = await mkdtemp(join(tmpdir(), "automation-diagnostic-"));
	let now = Date.now();
	let db = new AutomationLedger(join(root, "ledger"), "workspace", () => now);
	const d: AutomationRegistration = {
		id: "binding",
		workspaceId: "workspace",
		ownerId: "operator",
		namespace: "private",
		scopeRef: "scope",
		revision: 2,
		state: "enabled",
		role: "coordinator",
		instruction: "private input must never be diagnostics",
		schedule: null,
		target: { harness: "codex", model: "gpt-5.5" },
	};
	db.upsert(d);
	db.enqueue(d.id, 2, "event", "private customer content");
	const next = vi.fn();
	const runtime = new AutomationRuntime({
		workspaceId: () => "workspace",
		ledger: db,
		store: new AutomationCheckpointStore(join(root, "checkpoints")),
		readiness: () => ({ ...d.target, reason: null }),
		model: { next },
		tools: () => ({
			call: vi.fn(),
			close: async () => {},
			renew: async (op) => {
				await op();
			},
			revalidate: async () => {
				throw new AutomationDiagnosticError(
					{ phase: "mcp", code: "http_denied", httpStatus: 403 },
					"sensitive provider response",
				);
			},
		}),
		gateway: {
			async call(endpoint, body) {
				if (endpoint !== "authorize") throw Error("Unexpected callback");
				if (kind === "http")
					throw new AutomationDiagnosticError(
						{ phase: "authorize", code: "http_denied", httpStatus: 403 },
						"Bearer private-secret",
					);
				if (kind === "schema")
					return {
						mcp: { token: "private-secret", audience: "evil-private-host" },
						"sensitive-key": "private value",
					};
				return {
					authority: {
						contractVersion: 1,
						definition: {
							...d,
							grants: [
								{
									id: "grant",
									connectionId: "connection",
									accountId: "account",
									resource: {
										provider: "linear",
										customerId: "00000000-0000-4000-8000-000000000001",
									},
									permissions: ["read"],
								},
							],
						},
						occurrenceId: kind === "identity" ? "foreign" : body.occurrenceId,
						attemptId: body.attemptId,
						fence: body.fence,
						leaseUntil: new Date(Date.now() + 90000).toISOString(),
						phase: "execute",
						input: "private customer content",
					},
					mcp: {
						token: "fixture-credential-not-a-live-secret",
						audience: "/mcp",
						grantId: "grant",
						expiresAt: new Date(Date.now() + 60000).toISOString(),
					},
				};
			},
		},
	});
	try {
		for (let n = 0; n < 3; n++) {
			await runtime.wake();
			now += 11000;
		}
		const expected =
			kind === "http"
				? { phase: "authorize", code: "http_denied", httpStatus: 403 }
				: kind === "schema"
					? { phase: "admission", code: "admission_invalid" }
					: kind === "identity"
						? { phase: "admission", code: "identity_mismatch" }
						: { phase: "mcp", code: "http_denied", httpStatus: 403 };
		const occurrence = db.status(d.id).occurrences[0]!;
		expect(occurrence).toMatchObject({
			status: "blocked",
			attempts: 3,
			lastFailure: expected,
		});
		expect(JSON.stringify(occurrence.lastFailure)).not.toMatch(
			/private|Bearer|sensitive|evil/,
		);
		expect(next).not.toHaveBeenCalled();
		expect(await readdir(join(root, "checkpoints")).catch(() => [])).toEqual(
			[],
		);
		db.close();
		db = new AutomationLedger(join(root, "ledger"), "workspace", () => now);
		expect(db.status(d.id).occurrences[0]!.lastFailure).toEqual(
			occurrence.lastFailure,
		);
	} finally {
		await runtime.stop();
		db.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("fences late failure writers and clears a recovered failure on success", async () => {
	const root = await mkdtemp(join(tmpdir(), "automation-diagnostic-fence-"));
	let now = Date.now();
	const db = new AutomationLedger(root, "workspace", () => now);
	expect(safeDiagnostic(Error("constructor"), "execute")).toEqual({
		phase: "execute",
		code: "execution_interrupted",
	});
	try {
		db.upsert({
			id: "binding",
			workspaceId: "workspace",
			ownerId: "operator",
			namespace: "private",
			scopeRef: "scope",
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction: "Review",
			schedule: null,
			target: { harness: "codex", model: "gpt-5.5" },
		});
		db.enqueue("binding", 1, "event", "input");
		const first = db.claim(1)[0]!.occurrence;
		db.finish(first, false, {
			phase: "authorize",
			code: "http_denied",
			httpStatus: 403,
		});
		now += 6000;
		const second = db.claim(1)[0]!.occurrence;
		db.finish(first, false, {
			phase: "execute",
			code: "execution_interrupted",
		});
		expect(db.status("binding").occurrences[0]!.lastFailure?.code).toBe(
			"http_denied",
		);
		db.finish(second, true);
		expect(db.status("binding").occurrences[0]!.lastFailure).toBeUndefined();
		expect(
			safeDiagnostic(Error("private input Bearer credential"), "execute"),
		).toEqual({ phase: "execute", code: "execution_interrupted" });
	} finally {
		db.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("records HTTP status only, never authority response bodies or network errors", async () => {
	const gateway = new AutomationHttpGateway("https://fixture.invalid", () => ({
		apiKey: "private",
		workspaceId: "workspace",
	}));
	try {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response("private SQL error and credential", { status: 403 }),
		);
		await expect(
			gateway.call("authorize", {}, new AbortController().signal),
		).rejects.toMatchObject({
			diagnostic: { phase: "authorize", code: "http_denied", httpStatus: 403 },
		});
		vi.stubGlobal("fetch", async () => {
			throw Error("private proxy credentials");
		});
		await expect(
			gateway.call("authorize", {}, new AbortController().signal),
		).rejects.toMatchObject({
			diagnostic: { phase: "authorize", code: "transport_failed" },
		});
	} finally {
		vi.unstubAllGlobals();
	}
});
