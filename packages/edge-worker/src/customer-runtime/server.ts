import { lstat, readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { CheckpointStore } from "./CheckpointStore.js";
import { DockerSandbox } from "./DockerSandbox.js";
import { HostedGateway } from "./Gateway.js";
import { CustomerRuntimeModel } from "./Model.js";
import { ScopedRuntime } from "./ScopedRuntime.js";

export const runtimeConfigSchema = z
	.object({
		gatewayOrigin: z.string().url(),
		checkpointDirectory: z.string().min(1),
		apiKey: z.string().min(1),
		model: z.string().min(1),
		port: z.number().int().min(1).max(65535).default(3457),
		docker: z
			.object({
				dockerPath: z.string(),
				dockerHost: z.string(),
				image: z.string(),
			})
			.strict()
			.optional(),
	})
	.strict();

export function registerCustomerRuntimeRoutes(
	app: FastifyInstance,
	runtime: ScopedRuntime,
): void {
	app.get("/customer-runtime/v1/capabilities", async (_req, reply) =>
		reply.header("Cache-Control", "no-store").send(runtime.capabilities()),
	);
	for (const action of ["runs", "resume", "interrupt"] as const) {
		app.post(
			`/customer-runtime/v1/${action}`,
			{ bodyLimit: 16_384 },
			async (request, reply) => {
				try {
					const result =
						action === "interrupt"
							? await runtime.interrupt(request.body)
							: await runtime.launch(request.body, action === "resume");
					return reply
						.code(202)
						.header("Cache-Control", "no-store")
						.send({ contractVersion: 1, ...result });
				} catch {
					// Never echo capabilities, gateway responses or private request data.
					return reply
						.code(403)
						.send({ contractVersion: 1, error: "Scoped execution denied" });
				}
			},
		);
	}
	app.addHook("onClose", async () => runtime.stop());
}

/** Standalone service: deliberately does not construct EdgeWorker or Application. */
export async function startCustomerRuntime(
	configFile: string,
): Promise<FastifyInstance> {
	const stat = await lstat(configFile);
	if (
		!stat.isFile() ||
		(stat.mode & 0o077) !== 0 ||
		stat.uid !== process.getuid?.()
	) {
		throw new Error(
			"Runtime configuration must be private and owned by the runtime user",
		);
	}
	const config = runtimeConfigSchema.parse(
		JSON.parse(await readFile(configFile, "utf8")),
	);
	const gateway = new HostedGateway(config.gatewayOrigin);
	if (config.docker) {
		// Fail startup before advertising support if the actual backend cannot launch.
		const probe = new DockerSandbox(config.docker);
		try {
			await probe.start({}, AbortSignal.timeout(30_000));
		} finally {
			await probe.stop();
		}
	}
	const runtime = new ScopedRuntime({
		gateway,
		model: new CustomerRuntimeModel(config.apiKey, config.model),
		store: new CheckpointStore(config.checkpointDirectory),
		...(config.docker
			? { sandbox: () => new DockerSandbox(config.docker!) }
			: {}),
	});
	const app = Fastify({ logger: false, bodyLimit: 16_384 });
	registerCustomerRuntimeRoutes(app, runtime);
	await app.listen({ port: config.port, host: "127.0.0.1" });
	return app;
}
