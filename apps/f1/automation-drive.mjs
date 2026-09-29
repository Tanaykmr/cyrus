// Controlled transports only. Production runtime, SQLite, Messages adapter and MCP SDK.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AutomationRuntime } from "../../packages/edge-worker/dist/automations/AutomationRuntime.js";
import { AutomationCheckpointStore } from "../../packages/edge-worker/dist/automations/CheckpointStore.js";
import {
	authorizeTool,
	digest,
	permittedToolNames,
	toolCallSchema,
} from "../../packages/edge-worker/dist/automations/contract.js";
import { AutomationHttpGateway } from "../../packages/edge-worker/dist/automations/Gateway.js";
import { AutomationLedger } from "../../packages/edge-worker/dist/automations/Ledger.js";
import { ConfiguredAutomationMessagesModel } from "../../packages/edge-worker/dist/automations/Model.js";
import { registerAutomationRoutes } from "../../packages/edge-worker/dist/automations/register.js";
import { ScopedAutomationMcpClient } from "../../packages/edge-worker/dist/automations/ScopedMcpClient.js";

import { HttpSessionDeliveryTransport } from "../../packages/edge-worker/dist/sinks/SessionDeliveryTransport.js";
import {
	parseSessionDeliveryEnvelope,
	sessionDeliveryDigest,
} from "../../packages/edge-worker/dist/sinks/session-delivery.js";

const require = createRequire(
	new URL("../../packages/edge-worker/package.json", import.meta.url),
);
const Fastify = require("fastify");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
	StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const supervisorKey = "f1-supervisor-not-a-live-credential";
const modelKey = "f1-model-not-a-live-credential";
const target = { harness: "claude", model: "claude-fixture" };

async function until(predicate, timeout = 10000) {
	const end = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("F1 condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
export async function runAutomationDrive() {
	const directory = await mkdtemp(join(tmpdir(), "cyrus-automation-f1-"));
	const checkpoints = join(directory, "checkpoints");
	const definitions = new Map(),
		grants = new Map(),
		sessions = new Map(),
		results = new Map(),
		operationReceipts = new Map();
	const activityReceipts = new Map();
	let lostActivityAck = false;
	const counts = {
		sessionDeliveries: 0,
		initialize: 0,
		list: 0,
		tools: 0,
		models: 0,
		progress: 0,
		resultTransmissions: 0,
		resultCommits: 0,
		denied: 0,
	};
	let owner,
		lostAck = false;
	let holdEventModel = false,
		eventModelStarted = false;
	let releaseEventModel;
	const eventModelGate = new Promise((resolve) => {
		releaseEventModel = resolve;
	});
	const app = Fastify({ logger: false });
	function definition(
		id,
		namespace,
		provider = "linear",
		workspaceId = "workspace-a",
		schedule = null,
	) {
		const d = {
			id,
			workspaceId,
			ownerId: "operator",
			namespace,
			scopeRef: `binding-${id}`,
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction: `Read the assigned ${provider} resource then report findings.`,
			schedule,
			target,
		};
		definitions.set(id, d);
		return d;
	}
	function denied(reply, status = 403) {
		counts.denied++;
		return reply.code(status).send({ error: "Denied" });
	}
	app.post("/api/automations/v1/:operation", async (request, reply) => {
		if (
			request.headers.authorization !== `Bearer ${supervisorKey}` ||
			request.headers["x-cyrus-team-id"] !== "workspace-a"
		)
			return denied(reply, 401);
		const b = request.body,
			d =
				results.get(b.occurrenceId)?.definition ??
				definitions.get(b.automationId);
		if (
			!d ||
			d.state !== "enabled" ||
			d.revision !== b.revision ||
			!b.instanceId
		)
			return denied(reply);
		if (owner && owner.id !== b.instanceId && owner.until > Date.now())
			return denied(reply);
		owner = { id: b.instanceId, until: Date.now() + 90000 };
		if (request.params.operation === "authorize") {
			if (
				digest(b.definition) !== digest(d) ||
				b.occurrenceId !== b.occurrence.id
			)
				return denied(reply);
			const previous = [...grants.values()].find(
				(g) => g.authority.occurrenceId === b.occurrenceId && !g.revoked,
			);
			if (
				previous &&
				previous.authority.attemptId !== b.attemptId &&
				previous.until > Date.now()
			)
				return denied(reply);
			const provider = d.instruction.includes("slack") ? "slack" : "linear";
			const resource =
				provider === "linear"
					? { provider, teamId: "team-a", issueId: `issue-${d.namespace}` }
					: { provider, channelId: "channel-a", threadTs: "123.456" };
			const resourceGrant = {
				id: `grant-${b.occurrenceId}`,
				connectionId: `connected-${provider}`,
				accountId: "installed-account",
				resource,
				permissions: ["read"],
			};
			const authority = {
				contractVersion: 1,
				definition: { ...d, grants: [resourceGrant] },
				occurrenceId: b.occurrenceId,
				attemptId: b.attemptId,
				fence: b.fence,
				leaseUntil: new Date(Date.now() + 90000).toISOString(),
				phase: results.has(b.occurrenceId) ? "reconcile" : "execute",
				input: b.occurrence.input,
			};
			const grantId = resourceGrant.id,
				token = `fixture-${randomUUID()}-${randomUUID()}`,
				until = Date.now() + 60000;
			if (previous) previous.revoked = true;
			grants.set(token, {
				authority,
				grantId,
				until,
				instanceId: b.instanceId,
				revoked: false,
			});
			return {
				authority,
				...(request.headers["x-cyrus-session-delivery"] === "1" && {
					sessionDelivery: {
						contractVersion: 1,
						path: "/api/agent-sessions/v1/deliver",
						session: {
							id: `automation:${d.id}:${b.occurrenceId}`,
							scopeRef: d.scopeRef,
							role: d.role,
						},
					},
				}),
				mcp: {
					token,
					audience: "/mcp",
					expiresAt: new Date(until).toISOString(),
					grantId,
				},
			};
		}
		if (request.params.operation === "progress") {
			counts.progress++;
			return { ok: true };
		}
		if (request.params.operation === "result") {
			counts.resultTransmissions++;
			const sessionItems = [...activityReceipts.values()].filter(
				(entry) =>
					entry.item.sessionId === `automation:${d.id}:${b.occurrenceId}`,
			);
			assert.equal(sessionItems.length, 6);
			assert.equal(sessionItems.at(-1).item.payload.status, "complete");
			const previous = results.get(b.occurrenceId);
			if (previous) assert.equal(previous.key, b.idempotencyKey);
			else {
				results.set(b.occurrenceId, {
					key: b.idempotencyKey,
					text: b.text,
					definition: d,
				});
				counts.resultCommits++;
				await writeFile(
					join(directory, "results.json"),
					JSON.stringify([...results.values()]),
					{ mode: 0o600 },
				);
			}
			if (d.id === "lost-ack" && !lostAck) {
				lostAck = true;
				return reply.code(503).send({ error: "Controlled lost ACK" });
			}
			return {
				contractVersion: 1,
				acknowledged: true,
				occurrenceId: b.occurrenceId,
				idempotencyKey: b.idempotencyKey,
			};
		}
		return denied(reply);
	});
	app.post("/api/agent-sessions/v1/deliver", async (request, reply) => {
		if (
			request.headers.authorization !== `Bearer ${supervisorKey}` ||
			request.headers["x-cyrus-team-id"] !== "workspace-a"
		)
			return denied(reply, 401);
		const envelope = parseSessionDeliveryEnvelope(request.body);
		const current = [...grants.values()].find(
			(g) =>
				!g.revoked &&
				g.until > Date.now() &&
				g.instanceId === envelope.instanceId &&
				g.authority.occurrenceId === envelope.occurrenceId &&
				g.authority.attemptId === envelope.attemptId &&
				g.authority.fence === envelope.fence,
		);
		if (!current) return denied(reply);
		const d = current.authority.definition;
		const item = envelope.item;
		assert.equal(item.sessionId, `automation:${d.id}:${envelope.occurrenceId}`);
		if (item.kind === "session")
			assert.deepEqual(item.payload, {
				id: item.sessionId,
				scopeRef: d.scopeRef,
				role: d.role,
			});
		const key = `${item.sessionId}:${item.sequence}`,
			hash = sessionDeliveryDigest(item);
		const previous = activityReceipts.get(key);
		if (previous) assert.equal(previous.digest, hash);
		else {
			assert.equal(results.has(envelope.occurrenceId), false);
			assert.equal(
				item.sequence,
				[...activityReceipts.values()].filter(
					(e) => e.item.sessionId === item.sessionId,
				).length + 1,
			);
			activityReceipts.set(key, { item, digest: hash });
		}
		counts.sessionDeliveries++;
		if (
			!lostActivityAck &&
			item.kind === "activity" &&
			item.payload.content.type === "response"
		) {
			lostActivityAck = true;
			return reply.code(503).send({ error: "Controlled lost activity ACK" });
		}
		return {
			contractVersion: 1,
			sessionId: item.sessionId,
			sequence: item.sequence,
			digest: hash,
		};
	});
	app.post("/model", async (request) => {
		counts.models++;
		assert.equal(request.headers["x-api-key"], modelKey);
		const text = JSON.stringify(request.body);
		if (holdEventModel && text.includes("event-live-slack")) {
			eventModelStarted = true;
			await eventModelGate;
		}
		assert.ok(
			["event-live-slack", "event-late-slack", "event-live-linear"].filter(
				(marker) => text.includes(marker),
			).length <= 1,
		);
		assert.ok(!text.includes(supervisorKey));
		assert.ok(!text.includes('"token"'));
		assert.ok(!text.includes('"grantId"'));
		const replied = request.body.messages.some((m) => m.role === "assistant");
		const name = request.body.system.includes(
			'Available names: ["read_messages"]',
		)
			? "read_messages"
			: "get_issue";
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						replied
							? {
									type: "result",
									text: "Verified assigned resource. No customer effect performed.",
								}
							: { type: "tool", call: { name, arguments: {} } },
					),
				},
			],
		};
	});
	app.all("/mcp", async (request, reply) => {
		if (request.method === "GET")
			return reply.code(405).send({ error: "Streaming unavailable" });
		const token = request.headers.authorization?.replace(/^Bearer /, "");
		const grant = grants.get(token);
		if (
			!grant ||
			grant.revoked ||
			grant.until <= Date.now() ||
			owner?.id !== grant.instanceId ||
			results.has(grant.authority.occurrenceId)
		)
			return denied(reply, 401);
		const d = definitions.get(grant.authority.definition.id);
		if (
			!d ||
			d.state !== "enabled" ||
			d.revision !== grant.authority.definition.revision
		)
			return denied(reply, 401);
		const sessionId = request.headers["mcp-session-id"];
		let session = sessionId && sessions.get(sessionId);
		if (sessionId && (!session || session.grantId !== grant.grantId))
			return denied(reply, 404);
		if (!session) {
			if (request.body?.method !== "initialize") return denied(reply);
			counts.initialize++;
			const server = new McpServer({
				name: "f1-scoped-hosted-mcp",
				version: "1",
			});
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: randomUUID,
				enableJsonResponse: true,
				onsessioninitialized: (id) => sessions.set(id, session),
			});
			session = { server, transport, grantId: grant.grantId };
			for (const name of permittedToolNames(grant.authority)) {
				const schema =
					name === "read_messages"
						? z
								.object({
									limit: z.number().int().min(1).max(100).optional(),
									cursor: z.string().optional(),
								})
								.strict()
						: z.object({}).strict();
				server.registerTool(
					name,
					{ inputSchema: schema },
					async (args, extra) => {
						authorizeTool(grant.authority, { name, arguments: args });
						const key = extra._meta?.idempotencyKey;
						assert.match(key, /^[a-f0-9]{64}$/);
						const payload = digest({ name, args });
						if (operationReceipts.has(key))
							assert.equal(operationReceipts.get(key), payload);
						else {
							operationReceipts.set(key, payload);
							counts.tools++;
						}
						const g = grant.authority.definition.grants[0];
						const structuredContent = {
							items: [
								{
									grantId: grant.grantId,
									connectionId: g.connectionId,
									accountId: g.accountId,
									resource: g.resource,
									text: `Private result for ${d.namespace}`,
								},
							],
							nextCursor: null,
						};
						return {
							content: [
								{ type: "text", text: JSON.stringify(structuredContent) },
							],
							structuredContent,
						};
					},
				);
			}
			await server.connect(transport);
		}
		if (request.body?.method === "tools/list") counts.list++;
		if (
			request.body?.method === "tools/call" &&
			!toolCallSchema.safeParse(
				request.body.params && {
					name: request.body.params.name,
					arguments: request.body.params.arguments,
				},
			).success
		)
			return denied(reply);
		reply.hijack();
		await session.transport.handleRequest(request.raw, reply.raw, request.body);
	});
	await app.listen({ host: "127.0.0.1", port: 0 });
	const origin = `http://127.0.0.1:${app.server.address().port}`;
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, options) => {
		const value = String(url);
		if (value.startsWith("https://automation.fixture/"))
			return realFetch(
				value.replace("https://automation.fixture", origin),
				options,
			);
		if (value === "https://api.anthropic.com/v1/messages")
			return realFetch(`${origin}/model`, options);
		if (value.startsWith(`${origin}/`)) return realFetch(url, options);
		throw new Error("F1 external network denied");
	};
	let runtimeApp, runtime, runtimeOrigin;
	let modelEnabled = true;
	const ledger = new AutomationLedger(join(directory, "ledger"), "workspace-a");
	function makeRuntime() {
		runtime = new AutomationRuntime({
			workspaceId: () => "workspace-a",
			ledger,
			gateway: new AutomationHttpGateway(
				"https://automation.fixture",
				() => ({
					apiKey: supervisorKey,
					workspaceId: "workspace-a",
				}),
				true,
			),
			sessions: {
				directory: join(directory, "session-journal"),
				secrets: () => [supervisorKey, modelKey],
				transport: new HttpSessionDeliveryTransport(
					"https://automation.fixture",
					() => ({ workspaceId: "workspace-a", apiKey: supervisorKey }),
				),
			},
			model: new ConfiguredAutomationMessagesModel(() => ({
				...target,
				apiKey: modelKey,
			})),
			store: new AutomationCheckpointStore(checkpoints),
			readiness: () => ({
				...target,
				reason: modelEnabled ? null : "Configured model unavailable",
			}),
			pollMilliseconds: 50,
			tools: (authority, credential, signal) =>
				new ScopedAutomationMcpClient(
					"https://automation.fixture",
					authority,
					credential,
					signal,
				),
		});
		runtimeApp = Fastify({ logger: false });
		registerAutomationRoutes(runtimeApp, runtime, () => supervisorKey);
		return runtimeApp;
	}
	try {
		runtimeOrigin = await makeRuntime().listen({ host: "127.0.0.1", port: 0 });
		const call = async (path, body, key = supervisorKey) => {
			const response = await realFetch(
				`${runtimeOrigin}/api/automations/v1/${path}`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${key}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);
			const result = await response.json();
			return { statusCode: response.status, json: () => result };
		};
		assert.equal(
			(await realFetch(`${runtimeOrigin}/api/automations/v1/capabilities`))
				.status,
			401,
		);
		assert.equal(
			(await call("wake", { contractVersion: 1, customerId: "evil" }))
				.statusCode,
			400,
		);
		assert.equal(
			(
				await call("definitions", {
					contractVersion: 1,
					definition: definition("foreign", "other", "linear", "workspace-b"),
				})
			).statusCode,
			409,
		);
		const manual = definition("operator-instruction", "customer-a"),
			tick = definition("scheduled", "customer-b", "slack", "workspace-a", {
				intervalSeconds: 60,
				anchorAt: new Date(Date.now() + 1500).toISOString(),
				timezone: "UTC",
			});
		for (const d of [manual, tick])
			assert.equal(
				(await call("definitions", { contractVersion: 1, definition: d }))
					.statusCode,
				200,
			);
		const event = {
			contractVersion: 1,
			automationId: manual.id,
			revision: 1,
			eventId: "operator-event-1",
			input: "Investigate assigned source",
		};
		const enqueued = await call("occurrences", event);
		assert.equal(enqueued.statusCode, 200);
		assert.equal(
			(await call("occurrences", event)).json().occurrenceId,
			enqueued.json().occurrenceId,
		);
		await until(() => counts.resultCommits === 2);
		assert.equal(ledger.status(manual.id).occurrences.length, 1);
		const visible = await realFetch(
			`${runtimeOrigin}/api/automations/v1/status/${manual.id}`,
			{ headers: { authorization: `Bearer ${supervisorKey}` } },
		);
		assert.equal(visible.status, 200);
		assert.equal((await visible.json()).occurrences.length, 1);
		await until(
			() => ledger.status(tick.id).occurrences[0]?.status === "completed",
		);
		assert.equal(counts.tools, 2);
		assert.equal(counts.models, 4);
		const generic = definition("general-automation", "non-customer-ops");
		await call("definitions", { contractVersion: 1, definition: generic });
		await call("occurrences", {
			...event,
			automationId: generic.id,
			eventId: "generic-event",
		});
		await until(() => counts.resultCommits === 3);
		const loss = definition("lost-ack", "customer-a");
		await call("definitions", { contractVersion: 1, definition: loss });
		await call("occurrences", {
			...event,
			automationId: loss.id,
			eventId: "ack-event",
		});
		await until(() => lostAck);
		const paused = { ...loss, revision: 2, state: "paused" };
		definitions.set(loss.id, paused);
		assert.equal(
			(await call("definitions", { contractVersion: 1, definition: paused }))
				.statusCode,
			200,
		);
		modelEnabled = false;
		const modelBefore = counts.models,
			progressBefore = counts.progress,
			toolsBefore = counts.tools;
		await runtimeApp.close();
		owner.until = 0;
		for (const grant of grants.values()) {
			grant.until = 0;
			grant.revoked = true;
		}
		runtimeOrigin = await makeRuntime().listen({ host: "127.0.0.1", port: 0 });
		await until(
			() => ledger.status(loss.id).occurrences[0]?.status === "completed",
			15000,
		);
		assert.equal(counts.resultCommits, 4);
		assert.equal(counts.resultTransmissions, 5);
		assert.equal(counts.models, modelBefore);
		assert.equal(counts.progress, progressBefore);
		assert.equal(counts.tools, toolsBefore);
		modelEnabled = true;
		// Real connection/session tests, using an explicitly admitted fixture authority.
		const d = definition("session-probe", "probe");
		runtime.upsert(d);
		const o = runtime.enqueue(d.id, 1, "session", "probe");
		await runtime.stop();
		const [claimed] = ledger.claim(1);
		const boot = {
			contractVersion: 1,
			instanceId: owner.id,
			automationId: d.id,
			revision: 1,
			occurrenceId: o.id,
			attemptId: claimed.occurrence.attemptId,
			fence: claimed.occurrence.fence,
			definition: d,
			occurrence: {
				id: o.id,
				trigger: "instruction",
				scheduledAt: o.scheduledAt,
				input: o.input,
			},
			phase: "admit",
		};
		const authorize = async (body) =>
			realFetch(`${origin}/api/automations/v1/authorize`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${supervisorKey}`,
					"X-Cyrus-Team-Id": "workspace-a",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
		assert.equal(
			(await authorize({ ...boot, definition: { ...d, role: "engineering" } }))
				.status,
			403,
		);
		assert.equal(
			(await authorize({ ...boot, instanceId: "copied-runtime" })).status,
			403,
		);
		const admission = await (await authorize(boot)).json();
		const probe = new ScopedAutomationMcpClient(
			"https://automation.fixture",
			() => admission.authority,
			() => admission.mcp,
			new AbortController().signal,
		);
		await probe.call(
			{ name: "get_issue", arguments: {} },
			digest("probe"),
			new AbortController().signal,
		);
		const before = counts.tools;
		for (const args of [
			{ issueId: "other" },
			{ grantId: "other-session" },
			{ resourceRef: "expired-reference" },
		])
			await assert.rejects(
				probe.call(
					{ name: "get_issue", arguments: args },
					digest(args),
					new AbortController().signal,
				),
			);
		await assert.rejects(
			probe.call(
				{ name: "search", arguments: {} },
				digest("search"),
				new AbortController().signal,
			),
		);
		grants.get(admission.mcp.token).revoked = true;
		await assert.rejects(
			probe.call(
				{ name: "get_issue", arguments: {} },
				digest("revoked"),
				new AbortController().signal,
			),
		);
		assert.equal(counts.tools, before);
		await probe.close();
		const renew = await (await authorize({ ...boot, phase: "renew" })).json();
		const reconnect = new ScopedAutomationMcpClient(
			"https://automation.fixture",
			() => renew.authority,
			() => renew.mcp,
			new AbortController().signal,
		);
		await reconnect.call(
			{ name: "get_issue", arguments: {} },
			digest("reconnect"),
			new AbortController().signal,
		);
		grants.get(renew.mcp.token).until = 0;
		await assert.rejects(
			reconnect.call(
				{ name: "get_issue", arguments: {} },
				digest("expired"),
				new AbortController().signal,
			),
		);
		await reconnect.close();
		ledger.finish(claimed.occurrence, true);
		assert.equal(
			(
				await realFetch(`${origin}/mcp`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${supervisorKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {},
					}),
				})
			).status,
			401,
		);
		// Signed-provider interpretation belongs to Hosted. These are already admitted
		// opaque inputs; exercise the generic HTTP queue while a model turn is active.
		await runtimeApp.close();
		owner.until = 0;
		runtimeOrigin = await makeRuntime().listen({ host: "127.0.0.1", port: 0 });
		const slackEvents = definition("slack-events", "event-customer-a", "slack");
		const linearEvents = definition("linear-events", "event-customer-b");
		for (const d of [slackEvents, linearEvents])
			await call("definitions", { contractVersion: 1, definition: d });
		const eventInput = (d, id, input) => ({
			contractVersion: 1,
			automationId: d.id,
			revision: 1,
			eventId: id,
			input,
			trigger: "event",
		});
		const eventBase = counts.resultCommits;
		holdEventModel = true;
		assert.equal(
			(
				await call(
					"occurrences",
					eventInput(slackEvents, "source-event-newer", "event-live-slack"),
				)
			).statusCode,
			200,
		);
		await until(() => eventModelStarted);
		const late = eventInput(
			slackEvents,
			"source-event-older",
			"event-late-slack",
		);
		const queued = await call("occurrences", late);
		assert.equal(queued.statusCode, 200);
		assert.equal(
			(await call("occurrences", late)).json().occurrenceId,
			queued.json().occurrenceId,
		);
		assert.equal(
			(await call("occurrences", { ...late, input: "changed" })).statusCode,
			409,
		);
		assert.deepEqual(
			ledger.status(slackEvents.id).occurrences.map((o) => o.status),
			["running", "queued"],
		);
		assert.equal(
			(
				await call(
					"occurrences",
					eventInput(linearEvents, "source-event-older", "event-live-linear"),
				)
			).statusCode,
			200,
		);
		await until(() => counts.resultCommits === eventBase + 1);
		await runtimeApp.close();
		holdEventModel = false;
		releaseEventModel();
		assert.equal(ledger.status(slackEvents.id).occurrences.length, 2);
		owner.until = 0;
		for (const g of grants.values()) {
			g.revoked = true;
			g.until = 0;
		}
		runtimeOrigin = await makeRuntime().listen({ host: "127.0.0.1", port: 0 });
		await until(
			() =>
				ledger
					.status(slackEvents.id)
					.occurrences.every((o) => o.status === "completed"),
			15000,
		);
		assert.equal(counts.resultCommits, eventBase + 3);
		await runtime.stop();
		assert.equal(
			(
				await call(
					"occurrences",
					eventInput(slackEvents, "paused-event", "must never run"),
				)
			).statusCode,
			200,
		);
		await call("definitions", {
			contractVersion: 1,
			definition: { ...slackEvents, revision: 2, state: "paused" },
		});
		assert.equal(
			ledger.status(slackEvents.id).occurrences.at(-1).status,
			"cancelled",
		);
		assert.equal(
			(
				await call(
					"occurrences",
					eventInput(slackEvents, "after-pause", "denied"),
				)
			).statusCode,
			409,
		);
		for (const filename of await readdir(checkpoints)) {
			const saved = await readFile(join(checkpoints, filename), "utf8");
			assert.ok(!saved.includes(supervisorKey));
			assert.ok(!saved.includes(modelKey));
			assert.ok(!saved.includes('"token"'));
			assert.ok(!saved.includes('"grantId"'));
		}
		assert.equal(lostActivityAck, true);
		assert.ok(activityReceipts.size >= 6);
		const summary = {
			activityReceipts: activityReceipts.size,
			passed: true,
			directory,
			counts,
			assertions: [
				"instruction through registered HTTP routes",
				"negotiated durable normalized session activities, lost activity ACK, terminal flush before result and receipt-only reconnect",
				"admitted Slack/Linear event idle wake, active-turn queue, duplicate/out-of-order delivery and restart retention",
				"event pause denial and cross-customer context separation",
				"actual scheduled tick",
				"non-customer automation",
				"durable result ACK recovery after pause and restart with model unavailable",
				"no model/tool/progress reopening",
				"real MCP SDK initialize/list/call/reconnect",
				"open-session expiry/revocation",
				"supervisor key rejected at MCP",
				"forged authority and live copied instance denied",
				"strict fixed-resource arguments",
				"private checkpoints without credentials",
			],
			limitations: [
				"Hosted authority/provider/model transports are controlled fixtures; real hosted connected gate still required",
				"No live provider or model calls; actual signature/subscription/mapping proof is Hosted-owned",
				"Single-bound Linear/Slack tools only; engineering lifecycle integration pending",
			],
		};
		await writeFile(
			join(directory, "summary.json"),
			JSON.stringify(summary, null, 2),
		);
		return summary;
	} finally {
		releaseEventModel();
		await runtimeApp?.close();
		ledger.close();
		for (const session of sessions.values()) await session.server.close();
		await app.close();
		globalThis.fetch = realFetch;
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runAutomationDrive()
		.then((summary) => console.log(JSON.stringify(summary, null, 2)))
		.catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
}
