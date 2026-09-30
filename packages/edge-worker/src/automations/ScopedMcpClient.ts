import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
	type AutomationAuthority,
	type AutomationToolCall,
	authorizeTool,
	isCustomerReadSet,
	type McpCredential,
	permittedToolNames,
	scopedToolResult,
} from "./contract.js";
import {
	engineeringPublicationResult,
	publicationMetadata,
} from "./Engineering.js";

export interface ScopedAutomationTools {
	call(
		call: AutomationToolCall,
		idempotencyKey: string,
		signal: AbortSignal,
		engineeringFiles?: Record<string, string>,
	): Promise<unknown>;
	/** Serialize server-side credential rotation with complete MCP operations. */
	renew(operation: () => Promise<void>): Promise<void>;
	/** Current authority check on the admitted SDK session; never extends its lease. */
	revalidate?(): Promise<void>;
	close(): Promise<void>;
}

/** One client per admitted attempt. Never reads global MCP config or supervisor credentials. */
export class ScopedAutomationMcpClient implements ScopedAutomationTools {
	private client?: Client;
	private transport?: StreamableHTTPClientTransport;
	private names = new Set<string>();
	private connectedCredential?: McpCredential;
	private readonly references = new Set<string>();
	private queue: Promise<unknown> = Promise.resolve();
	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation);
		this.queue = next.catch(() => {});
		return next;
	}
	renew(operation: () => Promise<void>): Promise<void> {
		return this.exclusive(operation);
	}
	private readonly url: URL;
	constructor(
		origin: string,
		private readonly authority: () => AutomationAuthority,
		private readonly credential: () => McpCredential,
		private readonly signal: AbortSignal,
	) {
		const url = new URL(origin);
		if (
			url.protocol !== "https:" ||
			url.pathname !== "/" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new Error("Invalid scoped MCP origin");
		this.url = new URL("/mcp", url);
	}
	private async connect(credential: McpCredential): Promise<Client> {
		if (
			this.client &&
			(this.connectedCredential?.token !== credential.token ||
				this.connectedCredential?.grantId !== credential.grantId)
		)
			await this.disconnect();
		if (this.client) return this.client;
		const client = new Client({
			name: "cyrus-contained-automation",
			version: "1",
		});
		const transport = new StreamableHTTPClientTransport(this.url, {
			reconnectionOptions: {
				maxRetries: 0,
				initialReconnectionDelay: 1000,
				maxReconnectionDelay: 1000,
				reconnectionDelayGrowFactor: 1,
			},
			fetch: async (url, init) => {
				if (String(url) !== this.url.href)
					throw new Error("MCP transport origin changed");
				if (
					credential.audience !== "/mcp" ||
					Date.parse(credential.expiresAt) <= Date.now()
				)
					throw new Error("Scoped MCP credential expired");
				this.signal.throwIfAborted();
				const headers = new Headers(init?.headers);
				headers.set("Authorization", `Bearer ${credential.token}`);
				const response = await fetch(this.url, {
					...init,
					redirect: "error",
					headers,
					signal: AbortSignal.any([
						this.signal,
						...(init?.signal ? [init.signal] : []),
						AbortSignal.timeout(20_000),
					]),
				});
				if (!response.body) return response;
				// This contract uses JSON responses, not a background SSE stream. Buffer
				// bounded bytes before handing the response to the SDK: cancelling a
				// transformed undici stream can otherwise reject outside the SDK request.
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let bytes = 0;
				try {
					if (
						response.headers.get("content-type")?.includes("text/event-stream")
					)
						throw new Error("Scoped MCP requires JSON responses");
					for (;;) {
						const part = await reader.read();
						if (part.done) break;
						bytes += part.value.byteLength;
						if (bytes > 2_000_000)
							throw new Error("Scoped MCP response limit exceeded");
						chunks.push(part.value);
					}
				} catch (error) {
					await reader.cancel(error).catch(() => {});
					throw error;
				} finally {
					reader.releaseLock();
				}
				const body = Buffer.concat(chunks);
				return new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			},
		});
		try {
			await client.connect(transport, { signal: this.signal, timeout: 20_000 });
			const list = await client.listTools(undefined, {
				signal: this.signal,
				timeout: 20_000,
			});
			this.admitCatalog(list);
			this.client = client;
			this.transport = transport;
			this.connectedCredential = credential;
			return client;
		} catch {
			await client.close().catch(() => {});
			throw new Error("Scoped MCP initialization denied");
		}
	}

	private admitCatalog(list: {
		nextCursor?: string;
		tools: { name: string }[];
	}) {
		if (
			list.nextCursor ||
			list.tools.length >
				permittedToolNames(this.authority()).filter(
					(name) => name !== "execute",
				).length ||
			list.tools.some(
				(tool) =>
					tool.name === "execute" ||
					!permittedToolNames(this.authority()).includes(tool.name),
			)
		)
			throw new Error("Unscoped MCP tool catalog");
		this.names = new Set(list.tools.map((tool) => tool.name));
	}
	revalidate(): Promise<void> {
		return this.exclusive(async () => {
			try {
				const client = await this.connect({ ...this.credential() });
				this.admitCatalog(
					await client.listTools(undefined, {
						signal: this.signal,
						timeout: 20_000,
					}),
				);
			} catch {
				await this.disconnect();
				throw new Error("Scoped MCP authority unavailable");
			}
		});
	}

	async call(
		call: AutomationToolCall,
		idempotencyKey: string,
		signal: AbortSignal,
		engineeringFiles?: Record<string, string>,
	): Promise<unknown> {
		return this.exclusive(async () => {
			const authority = this.authority();
			const credential = { ...this.credential() };
			authorizeTool(authority, call);
			if (
				!authority.engineering &&
				authority.definition.grants[0]?.id !== credential.grantId
			)
				throw new Error("MCP grant identity mismatch");
			if (call.name === "execute")
				throw new Error(
					"Engineering commands require the local isolated executor",
				);
			if (engineeringFiles && call.name !== "publish_artifact")
				throw new Error("Engineering metadata on a non-publication tool");
			const metadata =
				call.name === "publish_artifact"
					? publicationMetadata(
							authority.engineering!,
							idempotencyKey,
							engineeringFiles,
						)
					: { idempotencyKey };
			try {
				const client = await this.connect(credential);
				if (!this.names.has(call.name))
					throw new Error("MCP tool absent from scoped catalog");
				// Pure reads can safely return a re-list instruction after reconnect.
				// Uncertain delegation is never rewritten or assigned another operation key.
				if (
					isCustomerReadSet(authority) &&
					call.name === "get_issue" &&
					!(
						"reference" in call.arguments &&
						this.references.has(call.arguments.reference)
					)
				)
					return {
						items: [
							{
								text: "This reference was not issued by the current MCP session. Call list_issues and use a newly returned reference before reading.",
							},
						],
						nextCursor: null,
					};
				const result = await client.callTool(
					{ ...call, _meta: metadata },
					undefined,
					{ signal, timeout: 20_000 },
				);
				if (result.isError || !result.structuredContent)
					throw new Error("Scoped MCP tool denied");
				if (call.name === "publish_artifact")
					return engineeringPublicationResult(
						authority.engineering!,
						result.structuredContent,
					);
				const output = scopedToolResult(
					authority,
					call,
					result.structuredContent,
				);
				if (isCustomerReadSet(authority) && call.name === "list_issues") {
					const listed = z
						.object({
							issues: z
								.array(
									z
										.object({
											reference: z.string().uuid(),
											identifier: z.string().max(300),
										})
										.strict(),
								)
								.max(100),
							held: z.number().int().nonnegative(),
						})
						.strict();
					for (const item of output.items)
						for (const issue of listed.parse(JSON.parse(item.text)).issues)
							this.references.add(issue.reference);
				}
				return output;
			} catch {
				// Uncertain operations remain checkpointed. Next admitted attempt reconnects
				// with the same operation key; it never retries a send under broader authority.
				await this.disconnect();
				throw new Error("Scoped MCP operation interrupted");
			}
		});
	}
	async close(): Promise<void> {
		return this.exclusive(() => this.disconnect());
	}
	private async disconnect(): Promise<void> {
		this.references.clear();
		const transport = this.transport;
		this.transport = undefined;
		const client = this.client;
		this.client = undefined;
		// Local close only. Completion/revocation may already prohibit protocol DELETE.
		await client?.close().catch(() => {});
		await transport?.close().catch(() => {});
	}
}
