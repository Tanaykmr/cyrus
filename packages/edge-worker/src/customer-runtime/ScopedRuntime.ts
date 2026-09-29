import { randomUUID } from "node:crypto";
import type { Checkpoint, CheckpointStore } from "./CheckpointStore.js";
import {
	type Authorization,
	assertLive,
	authorizeOperation,
	type ExecutionScope,
	launchSchema,
	type Operation,
	scopeKey,
} from "./contract.js";
import type { EngineeringSandbox } from "./DockerSandbox.js";
import {
	authenticate,
	type GatewayEndpoint,
	type ScopedGateway,
} from "./Gateway.js";
import { modelStepSchema, type ScopedModel } from "./Model.js";

interface ActiveRun {
	scope: ExecutionScope;
	controller: AbortController;
	done: Promise<void>;
}
export interface ScopedRuntimeOptions {
	gateway: ScopedGateway;
	model: ScopedModel;
	store: CheckpointStore;
	sandbox?: () => EngineeringSandbox;
	maxTurns?: number;
	/** A bounded poll stops in-flight work when the gateway revokes a lease. */
	revalidateMs?: number;
}

export class ScopedRuntime {
	private readonly active = new Map<string, ActiveRun>();
	private readonly admitting = new Set<string>();
	private healthy = true;
	constructor(private readonly options: ScopedRuntimeOptions) {}

	capabilities() {
		return {
			contractVersion: 1,
			available: this.healthy,
			authenticatedScope: true,
			nativeTools: false,
			customerReads: true,
			coordinatorActions: true,
			engineering: Boolean(this.options.sandbox),
			sharedMemory: false,
			scopedResume: true,
			minimumPublishedVersion: null,
		};
	}

	async launch(
		raw: unknown,
		resume = false,
	): Promise<{ runId: string; status: string }> {
		if (!this.healthy || this.active.size + this.admitting.size >= 8)
			throw new Error("Scoped runtime unavailable");
		const { token } = launchSchema.parse(raw);
		const executionId = randomUUID();
		const controller = new AbortController();
		const authorization = await authenticate(
			this.options.gateway,
			token,
			executionId,
			resume ? "resume" : "launch",
			controller.signal,
		);
		assertLive(authorization.scope);
		if (this.active.size + this.admitting.size >= 8)
			throw new Error("Scoped runtime at capacity");
		if (authorization.scope.engineering && !this.options.sandbox)
			throw new Error("Engineering isolation unavailable");
		const key = scopeKey(authorization.scope);
		if (this.active.has(key) || this.admitting.has(key))
			throw new Error("Run already active");
		this.admitting.add(key);
		try {
			const previous = await this.options.store.load(key);
			if (resume && !previous)
				throw new Error("No checkpoint for authenticated scope");
			if (!resume && previous)
				throw new Error("Existing run requires authenticated resume");
			if (previous?.status === "completed")
				return { runId: authorization.scope.runId, status: "completed" };
			const state: Checkpoint = previous ?? {
				version: 1,
				scopeKey: key,
				sequence: 0,
				status: "running",
				messages: [
					{
						role: "user",
						content:
							authorization.input.kind === "customer"
								? authorization.input.prompt
								: JSON.stringify({
										technicalBrief: authorization.input.technicalBrief,
										syntheticReproduction:
											authorization.input.syntheticReproduction,
									}),
					},
				],
				...(authorization.input.kind === "engineering"
					? { files: authorization.input.files }
					: {}),
			};
			state.status = "running";
			await this.options.store.save(state);
			const run: ActiveRun = {
				scope: authorization.scope,
				controller,
				done: Promise.resolve(),
			};
			this.active.set(key, run);
			run.done = this.execute(
				authorization,
				token,
				executionId,
				state,
				controller,
			)
				.catch(() => {
					this.healthy = false;
				})
				.finally(() => this.active.delete(key));
			return { runId: authorization.scope.runId, status: "running" };
		} finally {
			this.admitting.delete(key);
		}
	}

	async interrupt(raw: unknown): Promise<{ runId: string; status: string }> {
		const { token } = launchSchema.parse(raw);
		const auth = await authenticate(
			this.options.gateway,
			token,
			randomUUID(),
			"interrupt",
			new AbortController().signal,
		);
		assertLive(auth.scope);
		const run = this.active.get(scopeKey(auth.scope));
		if (run) {
			run.controller.abort();
			await run.done;
		}
		return { runId: auth.scope.runId, status: "interrupted" };
	}

	async stop(): Promise<void> {
		for (const run of this.active.values()) run.controller.abort();
		await Promise.all([...this.active.values()].map((run) => run.done));
	}

	/** For embedding/controlled F1 evidence; never expose unauthenticated session lookup over HTTP. */
	async drain(): Promise<void> {
		await Promise.all([...this.active.values()].map((run) => run.done));
	}

	private async execute(
		auth: Authorization,
		token: string,
		executionId: string,
		state: Checkpoint,
		controller: AbortController,
	): Promise<void> {
		const signal = controller.signal;
		let sandbox: EngineeringSandbox | undefined;
		let checking = false;
		const fresh = async () => {
			signal.throwIfAborted();
			const current = await authenticate(
				this.options.gateway,
				token,
				executionId,
				"operation",
				signal,
			);
			assertLive(current.scope);
			if (scopeKey(current.scope) !== state.scopeKey)
				throw new Error("Execution scope changed");
			return current.scope;
		};
		const callback = async (
			endpoint: GatewayEndpoint,
			body: Record<string, unknown>,
		) => {
			await fresh();
			return this.options.gateway.call(
				endpoint,
				token,
				{ executionId, ...body },
				signal,
			);
		};
		const poll = setInterval(
			async () => {
				if (checking) return;
				checking = true;
				try {
					await fresh();
				} catch {
					controller.abort();
				} finally {
					checking = false;
				}
			},
			Math.min(this.options.revalidateMs ?? 2000, 2000),
		);
		const expiry = setTimeout(
			() => controller.abort(),
			Math.max(
				0,
				Math.min(
					Date.parse(auth.scope.expiresAt),
					Date.parse(auth.scope.leaseUntil),
				) - Date.now(),
			),
		);
		try {
			if (auth.scope.engineering) {
				sandbox = this.options.sandbox!();
				await fresh();
				await sandbox.start(state.files ?? {}, signal);
			}
			await callback("progress", {
				sequence: state.sequence,
				status: "running",
				idempotencyKey: `${state.scopeKey}:${state.sequence}:running`,
			});
			if (state.result !== undefined) {
				await callback("result", {
					text: state.result,
					idempotencyKey: `${state.scopeKey}:result`,
				});
				state.status = "completed";
				await this.options.store.save(state);
				return;
			}
			for (let turn = 0; turn < (this.options.maxTurns ?? 40); turn++) {
				const scope = await fresh();
				if (!state.pending) {
					const step = modelStepSchema.parse(
						await this.options.model.next(state.messages, scope, signal),
					);
					await fresh();
					if (step.type === "result") {
						// Persist output before callback; a lost acknowledgement resumes the same result key.
						state.result = step.text;
						await this.options.store.save(state);
						await callback("result", {
							text: step.text,
							idempotencyKey: `${state.scopeKey}:result`,
						});
						state.status = "completed";
						await this.options.store.save(state);
						return;
					}
					state.messages.push({
						role: "assistant",
						content: JSON.stringify(step),
					});
					state.pending = {
						operation: step.operation,
						idempotencyKey: `${state.scopeKey}:${state.sequence}:operation`,
					};
					await this.options.store.save(state);
				}
				const { operation, idempotencyKey } = state.pending;
				authorizeOperation(await fresh(), operation);
				if (operation.kind === "publish" && !state.pending.files) {
					if (!sandbox) throw new Error("Engineering isolation unavailable");
					state.pending.files = await sandbox.snapshot(signal);
					await this.options.store.save(state);
				}
				const result = await this.operate(
					operation,
					idempotencyKey,
					sandbox,
					signal,
					callback,
					state.pending.files,
				);
				await fresh();
				if (sandbox) state.files = await sandbox.snapshot(signal);
				state.messages.push({
					role: "user",
					content: JSON.stringify({ operationResult: result }),
				});
				state.pending = undefined;
				state.sequence++;
				await this.options.store.save(state);
				await callback("progress", {
					sequence: state.sequence,
					status: "running",
					idempotencyKey: `${state.scopeKey}:${state.sequence}:running`,
				});
			}
			throw new Error("Scoped turn limit reached");
		} catch {
			state.status = "interrupted";
			await this.options.store.save(state);
			// Revoked tokens cannot post new callbacks. Hosted observes lease expiry and
			// owns recovery; never downgrade or retry through an unscoped runner.
		} finally {
			clearInterval(poll);
			clearTimeout(expiry);
			await sandbox?.stop();
		}
	}

	private async operate(
		operation: Operation,
		idempotencyKey: string,
		sandbox: EngineeringSandbox | undefined,
		signal: AbortSignal,
		callback: (
			endpoint: GatewayEndpoint,
			body: Record<string, unknown>,
		) => Promise<unknown>,
		files?: Record<string, string>,
	): Promise<unknown> {
		if (operation.kind === "execute") {
			if (!sandbox) throw new Error("Engineering isolation unavailable");
			return sandbox.execute(operation.command, signal);
		}
		if (operation.kind === "publish") {
			if (!sandbox) throw new Error("Engineering isolation unavailable");
			if (!files) throw new Error("Missing persisted artifact");
			return callback("engineering", { operation, files, idempotencyKey });
		}
		return callback(operation.kind, { operation, idempotencyKey });
	}
}
