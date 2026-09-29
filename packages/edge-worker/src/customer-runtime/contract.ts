import { createHash } from "node:crypto";
import { z } from "zod";

export const CONTRACT_VERSION = 1 as const;
const id = z.string().min(1).max(128);
const text = z.string().max(100_000);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
export const providerSchema = z.enum([
	"intercom",
	"linear",
	"github",
	"stripe",
	"tenant",
	"slack",
	"mixpanel",
	"memory",
	"thread",
]);
const readGrant = z
	.object({
		provider: providerSchema,
		recordIds: z.array(id).max(1000),
		fields: z.array(id).max(100),
	})
	.strict();
export const engineeringSchema = z
	.object({
		assignmentId: id,
		repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
		baseSha: sha,
		headBranch: z.string().min(1).max(200),
		reviewId: id,
		operations: z.array(z.enum(["execute", "publish"])).max(2),
		environment: z.literal("isolated"),
		deployment: z.literal("deny"),
	})
	.strict();
export const scopeSchema = z
	.object({
		workspaceId: id,
		// For engineering this is stable sponsoring provenance, not customer authority.
		customerId: id,
		runId: id,
		role: z.enum(["coordinator", "worker", "engineering"]),
		// Engineering uses the workspace assignment's independent fence/revision.
		generation: z.number().int().nonnegative(),
		policyRevision: z.number().int().nonnegative(),
		expiresAt: z.string().datetime(),
		leaseUntil: z.string().datetime(),
		reads: z.array(readGrant).max(100),
		engineering: engineeringSchema.optional(),
	})
	.strict()
	.superRefine((scope, ctx) => {
		if (
			scope.role === "engineering" &&
			(!scope.engineering || scope.reads.length)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Engineering runs require an assignment and cannot read customer records",
			});
		}
		if (scope.role !== "engineering" && scope.engineering) {
			ctx.addIssue({
				code: "custom",
				message: "Engineering authority requires a separate engineering run",
			});
		}
	});
export type ExecutionScope = z.infer<typeof scopeSchema>;
export const filesSchema = z
	.record(
		z
			.string()
			.min(1)
			.max(300)
			.refine(
				(path) =>
					!path.startsWith("/") &&
					!path.includes("\\") &&
					!path.includes("\0") &&
					path
						.split("/")
						.every((part) => part !== ".." && part !== "." && part !== ""),
				"Unsafe repository path",
			),
		z.string().max(1_000_000),
	)
	.refine(
		(files) =>
			Object.keys(files).length <= 1000 &&
			JSON.stringify(files).length <= 8_000_000,
		"Snapshot exceeds limit",
	);
export const inputSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("customer"), prompt: text }).strict(),
	z
		.object({
			kind: z.literal("engineering"),
			reviewId: id,
			technicalBrief: text,
			syntheticReproduction: text,
			files: filesSchema,
		})
		.strict(),
]);
export const authorizationSchema = z
	.object({
		contractVersion: z.literal(CONTRACT_VERSION),
		scope: scopeSchema,
		input: inputSchema,
	})
	.strict()
	.superRefine(({ scope, input }, ctx) => {
		if (
			(scope.role === "engineering") !== (input.kind === "engineering") ||
			(input.kind === "engineering" &&
				input.reviewId !== scope.engineering?.reviewId)
		) {
			ctx.addIssue({
				code: "custom",
				message: "Input does not match execution authority",
			});
		}
	});
export type Authorization = z.infer<typeof authorizationSchema>;
export const launchSchema = z
	.object({
		contractVersion: z.literal(CONTRACT_VERSION),
		token: z.string().min(32).max(8192),
	})
	.strict();

export const operationSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("read"),
			provider: providerSchema,
			recordId: id,
			fields: z.array(id).min(1).max(100),
		})
		.strict(),
	// Only existing immutable hosted actions can be executed, never arbitrary URLs/SQL.
	z.object({ kind: z.literal("action"), actionId: id }).strict(),
	z.object({ kind: z.literal("delegate"), assignmentId: id }).strict(),
	z
		.object({
			kind: z.literal("execute"),
			command: z.string().min(1).max(32_000),
		})
		.strict(),
	z
		.object({
			kind: z.literal("publish"),
			title: z.string().min(1).max(200),
			summary: text,
		})
		.strict(),
]);
export type Operation = z.infer<typeof operationSchema>;

/** Stable identity for storage and continuation, never a native runner session ID. */
export function scopeKey(scope: ExecutionScope): string {
	const { expiresAt: _expiresAt, leaseUntil: _leaseUntil, ...identity } = scope;
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function assertLive(scope: ExecutionScope, now = Date.now()): void {
	if (
		Date.parse(scope.expiresAt) <= now ||
		Date.parse(scope.leaseUntil) <= now
	) {
		throw new Error("Execution capability expired");
	}
}

export function authorizeOperation(
	scope: ExecutionScope,
	operation: Operation,
): void {
	assertLive(scope);
	switch (operation.kind) {
		case "read":
			if (
				scope.role !== "engineering" &&
				scope.reads.some(
					(grant) =>
						grant.provider === operation.provider &&
						grant.recordIds.includes(operation.recordId) &&
						operation.fields.every((field) => grant.fields.includes(field)),
				)
			)
				return;
			break;
		case "action":
		case "delegate":
			if (scope.role === "coordinator") return;
			break;
		case "execute":
		case "publish":
			if (
				scope.role === "engineering" &&
				scope.engineering?.operations.includes(operation.kind)
			)
				return;
	}
	throw new Error("Operation is outside execution capability");
}
