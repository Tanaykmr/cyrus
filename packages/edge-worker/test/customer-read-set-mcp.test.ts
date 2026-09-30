import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { AutomationAuthority } from "../src/automations/contract.js";
import { ScopedAutomationMcpClient } from "../src/automations/ScopedMcpClient.js";

it("lists and reads session references through SDK transport; rejects cross-session, rotated, revoked and cross-customer access", async () => {
	const customerId = randomUUID();
	const resource = { provider: "linear" as const, customerId };
	const grant = {
		id: "stable-grant",
		connectionId: "connection",
		accountId: "account",
		resource,
		permissions: ["read" as const],
	};
	const authority: AutomationAuthority = {
		contractVersion: 1,
		definition: {
			id: "automation",
			workspaceId: "workspace",
			ownerId: "operator",
			namespace: "private",
			scopeRef: "customer",
			revision: 1,
			state: "enabled",
			role: "coordinator",
			instruction: "Review",
			schedule: null,
			target: { harness: "codex", model: "gpt-5.5" },
			grants: [grant],
		},
		occurrenceId: "occurrence",
		attemptId: "attempt",
		fence: 1,
		leaseUntil: new Date(Date.now() + 90000).toISOString(),
		phase: "execute",
		input: "Review",
	};
	let credential = {
		grantId: grant.id,
		audience: "/mcp" as const,
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		token: "fixture-first-token",
	};
	let revoked = false,
		foreignResult = false,
		hideList = false,
		providerReads = 0;
	const sessions = new Map<
		string,
		{
			token: string;
			server: McpServer;
			transport: StreamableHTTPServerTransport;
		}
	>();
	const app = Fastify({ forceCloseConnections: true });
	app.all("/mcp", async (request, reply) => {
		if (request.method === "GET") return reply.code(405).send();
		const token = request.headers.authorization?.replace(/^Bearer /, "");
		if (revoked || token !== credential.token) return reply.code(401).send();
		const id = request.headers["mcp-session-id"] as string | undefined;
		let session = id ? sessions.get(id) : undefined;
		if (id && (!session || session.token !== token))
			return reply.code(403).send();
		if (!session) {
			if ((request.body as { method: string }).method !== "initialize")
				return reply.code(403).send();
			const references = new Map<string, string>();
			const server = new McpServer({
				name: "customer-read-set-fixture",
				version: "1",
			});
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: randomUUID,
				enableJsonResponse: true,
				onsessioninitialized: (id) => sessions.set(id, session!),
			});
			session = { token: token!, server, transport };
			const result = (text: string) => ({
				content: [],
				structuredContent: {
					items: [
						{
							grantId: grant.id,
							connectionId: grant.connectionId,
							accountId: grant.accountId,
							resource: foreignResult
								? { ...resource, customerId: randomUUID() }
								: resource,
							text,
						},
					],
					nextCursor: null,
				},
			});
			if (!hideList)
				server.registerTool(
					"list_issues",
					{ inputSchema: z.object({}).strict() },
					async () => {
						const issues = ["FIX-1", "FIX-2"].map((identifier) => {
							const reference = randomUUID();
							references.set(reference, identifier);
							return { reference, identifier };
						});
						return result(JSON.stringify({ issues, held: 1 }));
					},
				);
			server.registerTool(
				"get_issue",
				{ inputSchema: z.object({ reference: z.string().uuid() }).strict() },
				async ({ reference }) => {
					const identifier = references.get(reference);
					if (!identifier) throw Error("Unissued or expired session reference");
					providerReads++;
					return result(`Private content ${identifier}`);
				},
			);
			await server.connect(transport);
		}
		reply.hijack();
		await session.transport.handleRequest(request.raw, reply.raw, request.body);
	});
	const origin = await app.listen({ host: "127.0.0.1", port: 0 }),
		realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", (url: URL | string, init?: RequestInit) => {
		if (String(url) !== "https://read-set.fixture/mcp")
			throw Error("External request denied");
		return realFetch(`${origin}/mcp`, init);
	});
	const controller = new AbortController();
	const client = new ScopedAutomationMcpClient(
		"https://read-set.fixture",
		() => authority,
		() => credential,
		controller.signal,
	);
	const call = (
		name: "list_issues" | "get_issue",
		args: Record<string, string> = {},
	) =>
		client.call(
			{ name, arguments: args },
			"fixture-read-key",
			controller.signal,
		);
	const list = async () => {
		const result = (await call("list_issues")) as { items: { text: string }[] };
		return JSON.parse(result.items[0]!.text).issues as {
			reference: string;
			identifier: string;
		}[];
	};
	try {
		await expect(call("list_issues", { customerId })).rejects.toThrow();
		await expect(
			call("get_issue", { issueId: randomUUID() }),
		).rejects.toThrow();
		expect(sessions.size).toBe(0);
		const first = await list();
		expect(first.map((i) => i.identifier)).toEqual(["FIX-1", "FIX-2"]);
		await client.revalidate();
		expect(sessions.size).toBe(1);
		for (const item of first)
			await expect(
				call("get_issue", { reference: item.reference }),
			).resolves.toEqual({
				items: [{ text: `Private content ${item.identifier}` }],
				nextCursor: null,
			});
		expect(providerReads).toBe(2);
		await expect(
			call("get_issue", { reference: randomUUID() }),
		).resolves.toMatchObject({
			items: [{ text: expect.stringContaining("Call list_issues") }],
		});
		await client.close();
		expect(providerReads).toBe(2);
		await list();
		await expect(
			call("get_issue", { reference: first[0]!.reference }),
		).resolves.toMatchObject({
			items: [{ text: expect.stringContaining("Call list_issues") }],
		});
		expect(providerReads).toBe(2);
		const beforeRotation = await list();
		await client.renew(async () => {
			credential = { ...credential, token: "fixture-rotated-token" };
		});
		await expect(
			call("get_issue", { reference: beforeRotation[0]!.reference }),
		).resolves.toMatchObject({
			items: [{ text: expect.stringContaining("Call list_issues") }],
		});
		const current = await list();
		await call("get_issue", { reference: current[0]!.reference });
		expect(providerReads).toBe(3);
		foreignResult = true;
		await expect(call("list_issues")).rejects.toThrow("interrupted");
		foreignResult = false;
		hideList = true;
		await expect(call("list_issues")).rejects.toThrow("interrupted");
		hideList = false;
		const beforeRevocation = await list();
		revoked = true;
		await expect(client.revalidate()).rejects.toMatchObject({
			message: "Scoped MCP authority unavailable",
			diagnostic: { phase: "mcp", code: "http_denied", httpStatus: 401 },
		});
		await expect(
			call("get_issue", { reference: beforeRevocation[0]!.reference }),
		).rejects.toThrow("interrupted");
		expect(providerReads).toBe(3);
	} finally {
		controller.abort();
		await client.close();
		for (const s of sessions.values()) await s.server.close();
		await app.close();
		vi.unstubAllGlobals();
	}
});

it("negotiates customer read sets only on the authenticated authorize transport", async () => {
	const { AutomationHttpGateway } = await import(
		"../src/automations/Gateway.js"
	);
	const calls: RequestInit[] = [];
	const spy = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (_url, init) => {
			calls.push(init!);
			return new Response("{}");
		});
	try {
		const gateway = new AutomationHttpGateway(
			"https://read-set.fixture",
			() => ({ workspaceId: "workspace", apiKey: "supervisor-fixture" }),
		);
		await gateway.call(
			"authorize",
			{ phase: "admit" },
			new AbortController().signal,
		);
		await gateway.call(
			"result",
			{ text: "findings" },
			new AbortController().signal,
		);
		expect(
			new Headers(calls[0]!.headers).get("X-Cyrus-Customer-Read-Set"),
		).toBe("1");
		expect(
			new Headers(calls[1]!.headers).has("X-Cyrus-Customer-Read-Set"),
		).toBe(false);
		expect(JSON.parse(calls[0]!.body as string)).toEqual({
			phase: "admit",
			contractVersion: 1,
		});
	} finally {
		spy.mockRestore();
	}
});
