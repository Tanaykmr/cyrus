import { z } from "zod";
import { readBoundedJson } from "../customer-runtime/Gateway.js";
import type { AutomationMessage } from "./CheckpointStore.js";
import {
	type AutomationAuthority,
	type AutomationStep,
	modelStepSchema,
	permittedToolNames,
	toolCallSchema,
} from "./contract.js";

export interface AutomationModel {
	next(
		messages: AutomationMessage[],
		authority: AutomationAuthority,
		signal: AbortSignal,
	): Promise<AutomationStep>;
}
export interface ConfiguredAutomationModel {
	harness: string;
	model: string;
	apiKey?: string;
	oauthToken?: string;
}
export function modelReadiness(
	config: ConfiguredAutomationModel,
): string | null {
	if (config.harness !== "claude")
		return "Configured harness has no contained automation adapter";
	if (config.oauthToken)
		return "Claude Code OAuth is not supported by the contained Messages adapter";
	if (!config.apiKey)
		return "Configured runtime has no Anthropic API connection";
	if (!/^claude-[a-zA-Z0-9._-]+$/.test(config.model))
		return "Configure an explicit Anthropic model ID; CLI aliases are unsupported";
	return null;
}

/** Reuses only the configured runtime API connection, without native tools or CLI state. */
export class ConfiguredAutomationMessagesModel implements AutomationModel {
	constructor(
		private readonly configuration: () => ConfiguredAutomationModel,
	) {}
	async next(
		messages: AutomationMessage[],
		authority: AutomationAuthority,
		signal: AbortSignal,
	): Promise<AutomationStep> {
		const config = this.configuration();
		if (
			modelReadiness(config) ||
			authority.definition.target.harness !== config.harness ||
			authority.definition.target.model !== config.model
		) {
			throw new Error(
				"Configured model is incompatible with automation authority",
			);
		}
		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
			headers: {
				"Content-Type": "application/json",
				"x-api-key": config.apiKey!,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: config.model,
				max_tokens: 4096,
				messages,
				system: `Execute the assigned automation. Return only JSON: {"type":"result","text":"findings"} or {"type":"tool","call":...}. Tools follow the scoped MCP call schema ${JSON.stringify(z.toJSONSchema(toolCallSchema))}. Available names: ${JSON.stringify(permittedToolNames(authority))}. The connection is bound to one resource. Role: ${authority.definition.role}. The server enforces write approval and exact payload. Report limitations honestly.`,
			}),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Automation model failed (${response.status})`);
		}
		const body = z
			.object({
				content: z.array(
					z.object({ type: z.string(), text: z.string().optional() }),
				),
			})
			.parse(await readBoundedJson(response, 1_000_000));
		return modelStepSchema.parse(
			JSON.parse(
				body.content
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join(""),
			),
		);
	}
}
