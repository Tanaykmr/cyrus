import { z } from "zod";
import type { ModelMessage } from "./CheckpointStore.js";
import { type ExecutionScope, operationSchema } from "./contract.js";
import { readBoundedJson } from "./Gateway.js";

export const modelStepSchema = z.discriminatedUnion("type", [
	z
		.object({ type: z.literal("operation"), operation: operationSchema })
		.strict(),
	z
		.object({ type: z.literal("result"), text: z.string().min(1).max(100_000) })
		.strict(),
]);
export type ModelStep = z.infer<typeof modelStepSchema>;
export interface ScopedModel {
	next(
		messages: ModelMessage[],
		scope: ExecutionScope,
		signal: AbortSignal,
	): Promise<ModelStep>;
}

/** Direct Messages API: no SDK agent runtime, tools, connectors, settings or plugins. */
export class CustomerRuntimeModel implements ScopedModel {
	constructor(
		private readonly apiKey: string,
		private readonly model: string,
	) {}
	async next(
		messages: ModelMessage[],
		scope: ExecutionScope,
		signal: AbortSignal,
	): Promise<ModelStep> {
		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: this.model,
				max_tokens: 4096,
				messages,
				system: `Perform the assigned work using the available operations. Respond with exactly one JSON object, no markdown. Return {"type":"result","text":"your findings, proposed actions and evidence"} when done, or {"type":"operation","operation":...}. Operations: ${JSON.stringify(z.toJSONSchema(operationSchema))}. Your role is ${scope.role}; allowed reads: ${JSON.stringify(scope.reads)}; engineering authority: ${JSON.stringify(scope.engineering ?? null)}. Customer actions reference existing immutable hosted action IDs. Engineering commands run in an offline disposable /work directory. Report blockers honestly.`,
			}),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Scoped model request failed (${response.status})`);
		}
		const body = z
			.object({
				content: z.array(
					z.object({ type: z.string(), text: z.string().optional() }),
				),
			})
			.parse(await readBoundedJson(response, 1_000_000));
		const output = body.content
			.filter((item) => item.type === "text")
			.map((item) => item.text ?? "")
			.join("");
		return modelStepSchema.parse(JSON.parse(output));
	}
}
