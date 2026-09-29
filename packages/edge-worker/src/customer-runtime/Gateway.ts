import {
	type Authorization,
	authorizationSchema,
	CONTRACT_VERSION,
} from "./contract.js";

export type GatewayEndpoint =
	| "authorize"
	| "read"
	| "action"
	| "engineering"
	| "delegate"
	| "progress"
	| "result";
export interface ScopedGateway {
	call(
		endpoint: GatewayEndpoint,
		token: string,
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** Fixed origin, fixed paths, no redirects, no caller-selected credentials or URLs. */
export class HostedGateway implements ScopedGateway {
	private readonly origin: string;
	constructor(origin: string) {
		const url = new URL(origin);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/"
		) {
			throw new Error("Customer gateway must be an HTTPS origin");
		}
		this.origin = url.origin;
	}

	async call(
		endpoint: GatewayEndpoint,
		token: string,
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		const response = await fetch(
			`${this.origin}/api/customer-runtime/v1/${endpoint}`,
			{
				method: "POST",
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ ...body, contractVersion: CONTRACT_VERSION }),
			},
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(
				`Customer gateway denied ${endpoint} (${response.status})`,
			);
		}
		return readBoundedJson(response, 10_000_000);
	}
}

export async function readBoundedJson(
	response: Response,
	maxBytes: number,
): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty gateway response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new Error("Response exceeds limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function authenticate(
	gateway: ScopedGateway,
	token: string,
	executionId: string,
	phase: "launch" | "resume" | "operation" | "interrupt" | "result",
	signal: AbortSignal,
): Promise<Authorization> {
	return authorizationSchema.parse(
		await gateway.call("authorize", token, { executionId, phase }, signal),
	);
}
