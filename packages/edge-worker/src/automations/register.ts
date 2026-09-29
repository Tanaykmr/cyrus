import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AutomationRuntime } from "./AutomationRuntime.js";
import { AutomationCheckpointStore } from "./CheckpointStore.js";
import { registrationSchema } from "./contract.js";
import { type AutomationGateway, AutomationHttpGateway } from "./Gateway.js";
import { AutomationLedger } from "./Ledger.js";
import {
	ConfiguredAutomationMessagesModel,
	type ConfiguredAutomationModel,
	modelReadiness,
} from "./Model.js";
import { ScopedAutomationMcpClient } from "./ScopedMcpClient.js";

export function registerAutomationRoutes(
	app: FastifyInstance,
	runtime: AutomationRuntime,
	getApiKey: () => string,
): void {
	const authenticated = (header: string | undefined) => {
		const key = getApiKey();
		if (!key || !header) return false;
		const expected = Buffer.from(`Bearer ${key}`);
		const supplied = Buffer.from(header);
		return (
			expected.length === supplied.length && timingSafeEqual(expected, supplied)
		);
	};
	app.get("/api/automations/v1/capabilities", async (request, reply) => {
		if (!authenticated(request.headers.authorization))
			return reply.code(401).send({ error: "Unauthorized" });
		return reply
			.header("Cache-Control", "no-store")
			.send(runtime.capabilities());
	});
	app.post(
		"/api/automations/v1/wake",
		{ bodyLimit: 1024 },
		async (request, reply) => {
			if (!authenticated(request.headers.authorization))
				return reply.code(401).send({ error: "Unauthorized" });
			if (
				!z
					.object({ contractVersion: z.literal(1) })
					.strict()
					.safeParse(request.body).success
			)
				return reply
					.code(400)
					.send({ error: "Unsupported automation request" });
			if (!runtime.capabilities().available)
				return reply.code(409).send(runtime.capabilities());
			void runtime.wake().catch(() => {});
			return reply
				.code(202)
				.header("Cache-Control", "no-store")
				.send({ contractVersion: 1, status: "accepted" });
		},
	);
	app.post(
		"/api/automations/v1/definitions",
		{ bodyLimit: 120_000 },
		async (request, reply) => {
			if (!authenticated(request.headers.authorization))
				return reply.code(401).send({ error: "Unauthorized" });
			try {
				const body = z
					.object({
						contractVersion: z.literal(1),
						definition: registrationSchema,
					})
					.strict()
					.parse(request.body);
				const definition = runtime.upsert(body.definition);
				return {
					contractVersion: 1,
					automationId: definition.id,
					revision: definition.revision,
					state: definition.state,
				};
			} catch {
				return reply
					.code(409)
					.send({ error: "Automation definition rejected" });
			}
		},
	);
	app.post(
		"/api/automations/v1/occurrences",
		{ bodyLimit: 120_000 },
		async (request, reply) => {
			if (!authenticated(request.headers.authorization))
				return reply.code(401).send({ error: "Unauthorized" });
			try {
				const body = z
					.object({
						contractVersion: z.literal(1),
						automationId: z.string().min(1).max(200),
						revision: z.number().int().positive(),
						eventId: z.string().min(1).max(200),
						input: z.string().max(100_000),
					})
					.strict()
					.parse(request.body);
				const occurrence = runtime.enqueue(
					body.automationId,
					body.revision,
					body.eventId,
					body.input,
				);
				void runtime.wake().catch(() => {});
				return {
					contractVersion: 1,
					occurrenceId: occurrence.id,
					status: occurrence.status,
				};
			} catch {
				return reply
					.code(409)
					.send({ error: "Automation occurrence rejected" });
			}
		},
	);
	app.get<{ Params: { automationId: string } }>(
		"/api/automations/v1/status/:automationId",
		async (request, reply) => {
			if (!authenticated(request.headers.authorization))
				return reply.code(401).send({ error: "Unauthorized" });
			try {
				return reply.header("Cache-Control", "no-store").send({
					contractVersion: 1,
					...runtime.status(request.params.automationId),
				});
			} catch {
				return reply.code(409).send({ error: "Automation state unavailable" });
			}
		},
	);
	app.addHook("onReady", async () => runtime.start());
	app.addHook("onClose", async () => runtime.stop());
}

/** Registered in active AND repository-less runtimes; no extra listener/config/key. */
export function registerConfiguredAutomations(
	app: FastifyInstance,
	cyrusHome: string,
	getConfig: () => {
		defaultRunner?: string;
		claudeDefaultModel?: string;
		defaultModel?: string;
	},
): AutomationRuntime {
	const pairedWorkspace = process.env.CYRUS_TEAM_ID || "";
	const origin = getCyrusAppUrl();
	const configuration = (): ConfiguredAutomationModel => {
		const config = getConfig();
		return {
			harness:
				process.env.CYRUS_DEFAULT_RUNNER || config.defaultRunner || "claude",
			model:
				process.env.CYRUS_CLAUDE_DEFAULT_MODEL ||
				process.env.CYRUS_DEFAULT_MODEL ||
				config.claudeDefaultModel ||
				config.defaultModel ||
				"",
			apiKey: process.env.ANTHROPIC_API_KEY,
			oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
		};
	};
	let gateway: AutomationGateway;
	let gatewayError: string | null = null;
	try {
		gateway = new AutomationHttpGateway(origin, () => ({
			apiKey: process.env.CYRUS_API_KEY || "",
			workspaceId: pairedWorkspace,
		}));
	} catch {
		gatewayError =
			"Configured control plane requires HTTPS for contained automations";
		gateway = {
			async call() {
				throw new Error("Automation gateway unavailable");
			},
		};
	}
	let ledger: AutomationLedger | undefined;
	if (process.env.CYRUS_TEAM_ID && process.env.CYRUS_API_KEY) {
		try {
			ledger = new AutomationLedger(
				join(cyrusHome, "automation-ledger-v1"),
				process.env.CYRUS_TEAM_ID,
			);
		} catch {
			gatewayError = "Private durable automation storage is unavailable";
		}
	}
	const runtime = new AutomationRuntime({
		workspaceId: () => pairedWorkspace,
		gateway,
		ledger,
		tools: (authority, credential, signal) =>
			new ScopedAutomationMcpClient(origin, authority, credential, signal),
		model: new ConfiguredAutomationMessagesModel(configuration),
		store: new AutomationCheckpointStore(
			join(cyrusHome, "automation-checkpoints-v1"),
		),
		readiness: () => {
			const config = configuration();
			return {
				harness: config.harness,
				model: config.model,
				reason:
					(process.env.CYRUS_TEAM_ID !== pairedWorkspace
						? "Workspace pairing changed; restart required"
						: null) ||
					gatewayError ||
					(!process.env.CYRUS_API_KEY
						? "Runtime is not paired"
						: modelReadiness(config)),
			};
		},
	});
	registerAutomationRoutes(app, runtime, () =>
		process.env.CYRUS_TEAM_ID === pairedWorkspace
			? process.env.CYRUS_API_KEY || ""
			: "",
	);
	app.addHook("onClose", async () => {
		await runtime.stop();
		ledger?.close();
	});
	return runtime;
}
