import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type {
	AutomationAuthority,
	McpCredential,
} from "../src/automations/contract.js";
import { ScopedAutomationMcpClient } from "../src/automations/ScopedMcpClient.js";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

it("pins SDK sessions during initialize and slow writes, rotates only between operations, reconciles uncertain writes with the same key", async () => {
	const resource = {
		provider: "linear" as const,
		teamId: "team",
		issueId: "issue",
	};
	const binding = {
		id: "stable-occurrence-grant",
		connectionId: "connection",
		accountId: "account",
		resource,
		permissions: ["read", "write"] as ("read" | "write")[],
	};
	const authority: AutomationAuthority = {
		contractVersion: 1,
		definition: {
			id: "automation",
			workspaceId: "workspace",
			ownerId: "operator",
			namespace: "general",
			scopeRef: "binding",
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction: "Review",
			schedule: null,
			target: { harness: "claude", model: "claude-fixture" },
			grants: [binding],
		},
		occurrenceId: "occurrence",
		attemptId: "attempt",
		fence: 1,
		leaseUntil: new Date(Date.now() + 90000).toISOString(),
		phase: "execute",
		input: "Review",
	};
	let credential: McpCredential = {
		grantId: binding.id,
		audience: "/mcp",
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		token: "first-fixture-token-not-a-real-secret",
	};
	let currentToken = credential.token;
	let revoked = false,
		loseAck = false;
	const initialized = gate(),
		initializeRelease = gate(),
		writing = gate(),
		writeRelease = gate();
	const sessions = new Map<
		string,
		{
			transport: StreamableHTTPServerTransport;
			server: McpServer;
			token: string;
		}
	>();
	const requests: { method: string; session?: string; token: string }[] = [];
	const receipts = new Map<string, string>();
	let commits = 0,
		calls = 0;
	const app = Fastify();
	app.all("/mcp", async (request, reply) => {
		const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
		if (revoked || token !== currentToken)
			return reply.code(401).send({ error: "Denied" });
		const body = request.body as
			| { method?: string; params?: { _meta?: { idempotencyKey?: string } } }
			| undefined;
		const id = request.headers["mcp-session-id"] as string | undefined;
		let session = id ? sessions.get(id) : undefined;
		if (id && (!session || session.token !== token))
			return reply.code(403).send({ error: "Wrong session credential" });
		requests.push({
			method: body?.method ?? request.method,
			session: id,
			token,
		});
		if (!session) {
			if (body?.method !== "initialize") return reply.code(403).send();
			const server = new McpServer({ name: "renewal-fixture", version: "1" });
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: randomUUID,
				enableJsonResponse: true,
				onsessioninitialized: (id) => sessions.set(id, session!),
			});
			session = { server, transport, token };
			const result = () => ({
				content: [],
				structuredContent: {
					items: [
						{
							grantId: binding.id,
							connectionId: binding.connectionId,
							accountId: binding.accountId,
							resource,
							text: "bound result",
						},
					],
					nextCursor: null,
				},
			});
			server.registerTool(
				"get_issue",
				{ inputSchema: z.object({}).strict() },
				async () => {
					calls++;
					return result();
				},
			);
			server.registerTool(
				"add_comment",
				{ inputSchema: z.object({ text: z.string() }).strict() },
				async (args, extra) => {
					calls++;
					const key = extra._meta?.idempotencyKey as string;
					if (receipts.has(key)) expect(receipts.get(key)).toBe(args.text);
					else {
						receipts.set(key, args.text);
						commits++;
					}
					writing.release();
					await writeRelease.promise;
					return result();
				},
			);
			await server.connect(transport);
			if (sessions.size === 0) {
				initialized.release();
				await initializeRelease.promise;
			}
		}
		if (loseAck && body?.method === "tools/call") {
			// Commit once, lose HTTP acknowledgement; later call must reconcile same key.
			const key = body.params?._meta?.idempotencyKey;
			expect(key).toBe("uncertain-write");
			receipts.set(key!, "unchanged payload");
			commits++;
			loseAck = false;
			return reply.code(503).send({ error: "Lost acknowledgement" });
		}
		reply.hijack();
		await session.transport.handleRequest(request.raw, reply.raw, request.body);
	});
	const origin = await app.listen({ host: "127.0.0.1", port: 0 });
	const realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", (url: URL | string, init?: RequestInit) => {
		if (String(url) !== "https://scoped.fixture/mcp")
			throw new Error("External request denied");
		return realFetch(`${origin}/mcp`, init);
	});
	const controller = new AbortController();
	const client = new ScopedAutomationMcpClient(
		"https://scoped.fixture",
		() => authority,
		() => credential,
		controller.signal,
	);
	const rotate = async (token: string) =>
		client.renew(async () => {
			currentToken = token;
			credential = { ...credential, token };
		});
	try {
		const read = client.call(
			{ name: "get_issue", arguments: {} },
			"read-before",
			controller.signal,
		);
		await initialized.promise;
		let rotated = false;
		const rotation = rotate("second-fixture-token-not-a-real-secret").then(
			() => {
				rotated = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(rotated).toBe(false);
		initializeRelease.release();
		await expect(read).resolves.toEqual({
			items: [{ text: "bound result" }],
			nextCursor: null,
		});
		await rotation;
		const write = client.call(
			{ name: "add_comment", arguments: { text: "first write" } },
			"slow-write",
			controller.signal,
		);
		await writing.promise;
		rotated = false;
		const secondRotation = rotate("third-fixture-token-not-a-real-secret").then(
			() => {
				rotated = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(rotated).toBe(false);
		writeRelease.release();
		await write;
		await secondRotation;
		await expect(
			client.call(
				{ name: "get_issue", arguments: {} },
				"read-after",
				controller.signal,
			),
		).resolves.toEqual({ items: [{ text: "bound result" }], nextCursor: null });
		expect(requests.filter((r) => r.method === "initialize")).toHaveLength(3);
		for (const request of requests)
			if (request.session)
				expect(sessions.get(request.session)?.token).toBe(request.token);
		loseAck = true;
		const uncertain = {
			name: "add_comment" as const,
			arguments: { text: "unchanged payload" },
		};
		await expect(
			client.call(uncertain, "uncertain-write", controller.signal),
		).rejects.toThrow("interrupted");
		expect(commits).toBe(2);
		await rotate("fourth-fixture-token-not-a-real-secret");
		await client.call(uncertain, "uncertain-write", controller.signal);
		expect(commits).toBe(2);
		const before = calls;
		revoked = true;
		await expect(
			client.call(
				{ name: "get_issue", arguments: {} },
				"revoked",
				controller.signal,
			),
		).rejects.toThrow("interrupted");
		expect(calls).toBe(before);
	} finally {
		initializeRelease.release();
		writeRelease.release();
		controller.abort();
		await client.close();
		for (const session of sessions.values()) await session.server.close();
		await app.close();
		vi.unstubAllGlobals();
	}
});
