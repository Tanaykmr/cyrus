import { randomUUID } from "node:crypto";
import { AgentActivityType } from "@linear/sdk";
import { AgentSessionStatus } from "cyrus-core";
import { z } from "zod";
import { DurableCyrusSessionSink } from "../sinks/DurableCyrusSessionSink.js";
import { SessionActivityJournal } from "../sinks/SessionActivityJournal.js";
import type { SessionDeliveryTransport } from "../sinks/SessionDeliveryTransport.js";
import {
	type AutomationCheckpoint,
	type AutomationCheckpointStore,
	automationToolOutputSchema,
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
	readiness: () => {
		reason: string | null;
		controlReason?: string | null;
		harness: string;
		model: string;
	};
	sessions?: {
		directory: string;
		transport: SessionDeliveryTransport;
		secrets: () => readonly string[];
	};
	pollMilliseconds?: number;
	renewMilliseconds?: number;
}

/** Runtime wake/drain engine. The storage adapter is the sole durable clock/lease authority. */
export class AutomationRuntime {
	private readonly instanceId = randomUUID();
	private readonly active = new Map<string, AbortController>();
	private readonly drains = new Set<Promise<void>>();
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
				adapter:
					configured.harness === "claude"
						? "anthropic-messages-contained-v1"
						: null,
			},
			capabilities: {
				automations: true,
				sessionActivities: !!this.options.sessions,
				scheduledTicks: true,
				eventInputs: true,
				harnessStreaming: false,
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
	canDrain(): boolean {
		return (
			!this.stopped &&
			!!this.options.workspaceId() &&
			!!this.options.ledger &&
			!this.options.readiness().controlReason
		);
	}
	wake(): Promise<void> {
		if (!this.canDrain()) return Promise.resolve();
		// SQLite claims atomically account for every running occurrence. A wake
		// during a slow turn may fill another workspace slot without exceeding it.
		const draining = this.drain();
		this.drains.add(draining);
		const done = () => this.drains.delete(draining);
		void draining.then(done, done);
		return draining;
	}
	private async drain(): Promise<void> {
		const claims = this.ledger().claim(
			AUTOMATION_LIMITS.workspaceConcurrency,
			this.capabilities().available,
		);
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
		trigger: "instruction" | "event" = "instruction",
	) {
		return this.ledger().enqueue(
			automationId,
			revision,
			eventId,
			input,
			trigger,
		);
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
		if (admission.sessionDelivery) {
			const session = admission.sessionDelivery.session;
			if (
				!this.options.sessions ||
				session.scopeRef !== next.definition.scopeRef ||
				session.role !== next.definition.role ||
				session.parentSessionId ||
				session.issueContext ||
				session.externalSessionId
			)
				throw new Error("Session delivery admission mismatch");
		}
		this.check(next, !!occurrence.receipt);
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
	private check(authority: AutomationAuthority, receiptOnly = false): void {
		const configured = this.options.readiness();
		if (
			this.stopped ||
			authority.definition.workspaceId !== this.options.workspaceId() ||
			Date.parse(authority.leaseUntil) <= Date.now() ||
			configured.controlReason ||
			(!receiptOnly &&
				(authority.definition.state !== "enabled" ||
					configured.reason ||
					authority.definition.target.harness !== configured.harness ||
					authority.definition.target.model !== configured.model ||
					authority.definition.role === "engineering"))
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
		if (occurrence.receipt && occurrence.receipt.scopeKey !== key)
			throw new Error("Receipt checkpoint identity changed");
		if (this.active.has(key)) throw new Error("Occurrence already active");
		const controller = new AbortController();
		this.active.set(key, controller);
		let authority = initial;
		let credential = admission.mcp;
		let receiptOnly = !!occurrence.receipt;
		let journal: SessionActivityJournal | undefined;
		let sink: DurableCyrusSessionSink | undefined;
		const session = admission.sessionDelivery?.session;

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
					this.check(authority, receiptOnly);
					const renewed = await this.admit(
						definition,
						occurrence,
						"renew",
						controller.signal,
					);
					const next = renewed.authority;
					this.check(next, receiptOnly);
					if (
						digest(renewed.sessionDelivery ?? null) !==
							digest(admission.sessionDelivery ?? null) ||
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
				if (receiptOnly || authority.phase === "reconcile")
					throw new Error("Missing terminal checkpoint");
				state = {
					version: 1,
					scopeKey: key,
					sequence: 0,
					status: "running",
					...(admission.sessionDelivery && {
						sessionDelivery: admission.sessionDelivery,
					}),
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
				digest(state.sessionDelivery ?? null) !==
				digest(admission.sessionDelivery ?? null)
			)
				throw new Error("Session delivery changed across checkpoint recovery");
			if (session && this.options.sessions) {
				journal = new SessionActivityJournal(
					this.options.sessions.directory,
					authority.definition.workspaceId,
					key,
				);
				sink = new DurableCyrusSessionSink(
					journal,
					this.options.sessions.transport,
					async (sessionId) => {
						if (sessionId !== session.id)
							throw new Error("Foreign session delivery denied");
						await fresh();
						return {
							contractVersion: 1,
							instanceId: this.instanceId,
							...identity(authority),
						};
					},
					() => [...this.options.sessions!.secrets(), credential.token],
				);
				await sink.createCyrusSession(session);
				await sink.flush(controller.signal);
			}
			if (
				(receiptOnly || authority.phase === "reconcile") &&
				state.pending?.step.type !== "result"
			)
				throw new Error("No terminal result to reconcile");
			// A terminal checkpoint only replays immutable session items/result. Never reopen model/progress.
			if (state.pending?.step.type !== "result") {
				if (session && sink)
					await sink.updateCyrusSession(
						session.id,
						{ status: AgentSessionStatus.Active },
						"started",
					);
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
				if (state.pending.step.type === "result") {
					this.ledger().markReceipt(occurrence, definition, key);
					occurrence.receipt ??= { definition, scopeKey: key, attempts: 1 };
					receiptOnly = true;
				}
				await this.perform(
					state,
					authority,
					tools,
					controller.signal,
					fresh,
					sink,
					session?.id,
				);
				if (state.status === "completed") return;
			}
		} finally {
			controller.abort();
			clearTimeout(leaseTimer);
			clearInterval(poll);
			try {
				await tools.close();
			} finally {
				journal?.close();
				this.active.delete(key);
			}
		}
	}
	private async perform(
		state: AutomationCheckpoint,
		authority: AutomationAuthority,
		tools: ScopedAutomationTools,
		signal: AbortSignal,
		fresh: () => Promise<void>,
		sink?: DurableCyrusSessionSink,
		sessionId?: string,
	): Promise<void> {
		const pending = state.pending!;
		await fresh();
		if (pending.step.type === "result") {
			if (sink && sessionId) {
				await sink.postActivity(
					sessionId,
					{
						type: AgentActivityType.Response,
						body: pending.step.text.slice(0, 32768),
					},
					undefined,
					`${pending.key}:response`,
				);
				await sink.updateCyrusSession(
					sessionId,
					{ status: AgentSessionStatus.Complete },
					`${pending.key}:complete`,
				);
				// An unacknowledged activity must never be stranded by hosted completion.
				await sink.flush(signal);
			}
			await fresh();
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
		if (sink && sessionId)
			await sink.postActivity(
				sessionId,
				{
					type: AgentActivityType.Action,
					action: pending.step.call.name,
					parameter: JSON.stringify(pending.step.call.arguments),
					result: null,
				},
				undefined,
				`${pending.key}:start`,
			);
		if (!pending.result) {
			pending.result = automationToolOutputSchema.parse(
				await tools.call(pending.step.call, pending.key, signal),
			);
			await this.options.store.save(state);
		}
		const result = pending.result;
		if (sink && sessionId)
			await sink.postActivity(
				sessionId,
				{
					type: AgentActivityType.Action,
					action: pending.step.call.name,
					parameter: JSON.stringify(pending.step.call.arguments),
					result: JSON.stringify(result).slice(0, 32768),
				},
				undefined,
				`${pending.key}:result`,
			);
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
		await Promise.allSettled([...this.drains]);
	}
}
