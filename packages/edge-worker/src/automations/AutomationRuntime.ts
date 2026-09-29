import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
	AutomationCheckpoint,
	AutomationCheckpointStore,
} from "./CheckpointStore.js";
import {
	type AutomationAdmission,
	type AutomationAuthority,
	type AutomationRegistration,
	admissionSchema,
	authorizeTool,
	checkpointKey,
	digest,
	identity,
	type McpCredential,
	modelStepSchema,
	registrationSchema,
} from "./contract.js";
import type { AutomationGateway } from "./Gateway.js";
import type { AutomationLedger, AutomationOccurrence } from "./Ledger.js";
import type { AutomationModel } from "./Model.js";
import type { ScopedAutomationTools } from "./ScopedMcpClient.js";
import { AUTOMATION_LIMITS } from "./scheduling.js";

export interface AutomationRuntimeOptions {
	workspaceId: () => string;
	gateway: AutomationGateway;
	model: AutomationModel;
	store: AutomationCheckpointStore;
	ledger?: AutomationLedger;
	tools: (
		authority: () => AutomationAuthority,
		credential: () => McpCredential,
		signal: AbortSignal,
	) => ScopedAutomationTools;
	readiness: () => { reason: string | null; harness: string; model: string };
	pollMilliseconds?: number;
	renewMilliseconds?: number;
}

/** Runtime wake/drain engine. The storage adapter is the sole durable clock/lease authority. */
export class AutomationRuntime {
	private readonly instanceId = randomUUID();
	private readonly active = new Map<string, AbortController>();
	private draining?: Promise<void>;
	private poll?: ReturnType<typeof setInterval>;
	private stopped = false;
	constructor(private readonly options: AutomationRuntimeOptions) {}
	capabilities() {
		const configured = this.options.readiness();
		return {
			contractVersion: 1,
			available:
				!this.stopped &&
				!configured.reason &&
				!!this.options.workspaceId() &&
				!!this.options.ledger,
			reason:
				configured.reason ||
				(!this.options.workspaceId()
					? "Runtime is not paired with a workspace"
					: null),
			workspaceId: this.options.workspaceId(),
			target: {
				harness: configured.harness,
				model: configured.model,
				adapter: "anthropic-messages-contained-v1",
			},
			capabilities: {
				automations: true,
				scheduledTicks: true,
				scopedMcp: true,
				currentAuthorityResume: true,
				resultReconciliation: true,
				nativeTools: false,
				sharedMemory: false,
				engineering: false,
			},
			minimumPublishedVersion: null,
		};
	}
	start(): void {
		if (this.poll || this.stopped) return;
		this.poll = setInterval(() => {
			void this.wake().catch(() => {});
		}, this.options.pollMilliseconds ?? AUTOMATION_LIMITS.pollMilliseconds);
		this.poll.unref();
		void this.wake().catch(() => {});
	}
	wake(): Promise<void> {
		if (this.draining) return this.draining;
		if (this.stopped || !this.capabilities().available)
			return Promise.resolve();
		this.draining = this.drain().finally(() => {
			this.draining = undefined;
		});
		return this.draining;
	}
	private async drain(): Promise<void> {
		const claims = this.ledger().claim(AUTOMATION_LIMITS.workspaceConcurrency);
		await Promise.allSettled(
			claims.map(async ({ definition, occurrence }) => {
				try {
					const authority = await this.admit(
						definition,
						occurrence,
						"admit",
						AbortSignal.timeout(20_000),
					);
					await this.execute(authority, occurrence, definition);
					this.ledger().finish(occurrence, true);
				} catch {
					this.ledger().finish(occurrence, false);
				}
			}),
		);
	}
	private ledger(): AutomationLedger {
		if (!this.options.ledger) throw new Error("Automation ledger unavailable");
		return this.options.ledger;
	}
	upsert(raw: unknown) {
		return this.ledger().upsert(raw);
	}
	enqueue(
		automationId: string,
		revision: number,
		eventId: string,
		input: string,
	) {
		return this.ledger().enqueue(automationId, revision, eventId, input);
	}
	status(automationId: string) {
		return this.ledger().status(automationId);
	}
	private async admit(
		definition: AutomationRegistration,
		occurrence: AutomationOccurrence,
		phase: "admit" | "renew",
		signal: AbortSignal,
	) {
		this.ledger().renew(occurrence);
		const admission = admissionSchema.parse(
			await this.options.gateway.call(
				"authorize",
				{
					instanceId: this.instanceId,
					automationId: definition.id,
					revision: definition.revision,
					occurrenceId: occurrence.id,
					attemptId: occurrence.attemptId,
					fence: occurrence.fence,
					definition,
					occurrence: {
						id: occurrence.id,
						trigger: occurrence.trigger,
						scheduledAt: occurrence.scheduledAt,
						input: occurrence.input,
					},
					phase,
				},
				signal,
			),
		);
		const next = admission.authority;
		this.check(next);
		if (
			(next.definition.grants.length > 0 &&
				next.definition.grants[0]?.id !== admission.mcp.grantId) ||
			Date.parse(admission.mcp.expiresAt) <= Date.now() ||
			Date.parse(admission.mcp.expiresAt) > Date.parse(next.leaseUntil)
		)
			throw new Error("Invalid scoped credential deadline");
		const { grants: _grants, ...registered } = next.definition;
		if (
			digest(registrationSchema.parse(registered)) !== digest(definition) ||
			next.occurrenceId !== occurrence.id ||
			next.attemptId !== occurrence.attemptId ||
			next.fence !== occurrence.fence ||
			next.input !== occurrence.input
		)
			throw new Error("Admission identity mismatch");
		this.ledger().renew(occurrence);
		return admission;
	}
	private check(authority: AutomationAuthority): void {
		const configured = this.options.readiness();
		if (
			this.stopped ||
			authority.definition.workspaceId !== this.options.workspaceId() ||
			authority.definition.state !== "enabled" ||
			Date.parse(authority.leaseUntil) <= Date.now() ||
			configured.reason ||
			authority.definition.target.harness !== configured.harness ||
			authority.definition.target.model !== configured.model ||
			authority.definition.role === "engineering"
		)
			throw new Error("Automation authority unavailable");
	}
	private async execute(
		admission: AutomationAdmission,
		occurrence: AutomationOccurrence,
		definition: AutomationRegistration,
	): Promise<void> {
		const initial = admission.authority;
		const key = checkpointKey(initial);
		if (this.active.has(key)) return;
		const controller = new AbortController();
		this.active.set(key, controller);
		let authority = initial;
		let credential = admission.mcp;
		const tools = this.options.tools(
			() => authority,
			() => credential,
			controller.signal,
		);
		let leaseTimer: ReturnType<typeof setTimeout> | undefined;
		let renewing: Promise<void> | undefined;
		const deadline = () => {
			clearTimeout(leaseTimer);
			leaseTimer = setTimeout(
				() => controller.abort(),
				Math.max(0, Date.parse(authority.leaseUntil) - Date.now()),
			);
		};
		const fresh = (): Promise<void> => {
			if (renewing) return renewing;
			renewing = tools
				.renew(async () => {
					controller.signal.throwIfAborted();
					this.check(authority);
					const renewed = await this.admit(
						definition,
						occurrence,
						"renew",
						controller.signal,
					);
					const next = renewed.authority;
					this.check(next);
					if (
						checkpointKey(next) !== key ||
						next.attemptId !== initial.attemptId ||
						next.fence !== initial.fence ||
						next.phase !== initial.phase
					)
						throw new Error("Automation authority changed");
					authority = next;
					credential = renewed.mcp;
					deadline();
				})
				.catch((error) => {
					controller.abort();
					throw error;
				})
				.finally(() => {
					renewing = undefined;
				});
			return renewing;
		};
		deadline();
		const poll = setInterval(() => {
			void fresh().catch(() => {});
		}, this.options.renewMilliseconds ?? AUTOMATION_LIMITS.renewMilliseconds);
		try {
			await fresh();
			let state = await this.options.store.load(key);
			if (!state) {
				if (authority.phase === "reconcile")
					throw new Error("Missing terminal checkpoint");
				state = {
					version: 1,
					scopeKey: key,
					sequence: 0,
					status: "running",
					messages: [
						{
							role: "user",
							content: `${authority.definition.instruction}\n\n${authority.input}`,
						},
					],
				};
				await this.options.store.save(state);
			}
			if (
				authority.phase === "reconcile" &&
				state.pending?.step.type !== "result"
			)
				throw new Error("No terminal result to reconcile");
			// A terminal checkpoint only retransmits its immutable result. Never reopen model/progress.
			if (state.pending?.step.type !== "result") {
				await fresh();
				await this.options.gateway.call(
					"progress",
					{
						...identity(authority),
						instanceId: this.instanceId,
						status: "running",
					},
					controller.signal,
				);
			}
			while (!this.stopped) {
				await fresh();
				if (!state.pending) {
					if (state.sequence >= AUTOMATION_LIMITS.maxSteps)
						throw new Error("Automation step limit exceeded");
					const step = modelStepSchema.parse(
						await this.options.model.next(
							state.messages,
							authority,
							controller.signal,
						),
					);
					await fresh();
					if (step.type === "tool") authorizeTool(authority, step.call);
					state.pending = { key: digest([key, state.sequence, step]), step };
					await this.options.store.save(state);
				}
				await this.perform(state, authority, tools, controller.signal, fresh);
				if (state.status === "completed") return;
			}
		} finally {
			controller.abort();
			clearTimeout(leaseTimer);
			clearInterval(poll);
			await tools.close();
			this.active.delete(key);
		}
	}
	private async perform(
		state: AutomationCheckpoint,
		authority: AutomationAuthority,
		tools: ScopedAutomationTools,
		signal: AbortSignal,
		fresh: () => Promise<void>,
	): Promise<void> {
		const pending = state.pending!;
		await fresh();
		if (pending.step.type === "result") {
			const ack = z
				.object({
					contractVersion: z.literal(1),
					acknowledged: z.literal(true),
					occurrenceId: z.string(),
					idempotencyKey: z.string(),
				})
				.strict()
				.parse(
					await this.options.gateway.call(
						"result",
						{
							...identity(authority),
							instanceId: this.instanceId,
							idempotencyKey: pending.key,
							text: pending.step.text,
						},
						signal,
					),
				);
			if (
				ack.occurrenceId !== authority.occurrenceId ||
				ack.idempotencyKey !== pending.key
			)
				throw new Error("Result acknowledgement mismatch");
			state.status = "completed";
			await this.options.store.save(state);
			return;
		}
		authorizeTool(authority, pending.step.call);
		const result = await tools.call(pending.step.call, pending.key, signal);
		await fresh();
		state.messages.push(
			{ role: "assistant", content: JSON.stringify(pending.step) },
			{ role: "user", content: JSON.stringify(result) },
		);
		state.sequence++;
		delete state.pending;
		await this.options.store.save(state);
	}
	async stop(): Promise<void> {
		this.stopped = true;
		clearInterval(this.poll);
		for (const controller of this.active.values()) controller.abort();
		await this.draining?.catch(() => {});
	}
}
