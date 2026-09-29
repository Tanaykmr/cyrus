import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { filesSchema, operationSchema } from "./contract.js";

export const messageSchema = z
	.object({
		role: z.enum(["user", "assistant"]),
		content: z.string().max(1_100_000),
	})
	.strict();
const checkpointSchema = z
	.object({
		version: z.literal(1),
		scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
		messages: z.array(messageSchema).max(200),
		sequence: z.number().int().nonnegative(),
		files: filesSchema.optional(),
		pending: z
			.object({
				operation: operationSchema,
				idempotencyKey: z.string(),
				files: filesSchema.optional(),
			})
			.strict()
			.optional(),
		status: z.enum(["running", "interrupted", "completed"]),
		result: z.string().optional(),
	})
	.strict();
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type ModelMessage = z.infer<typeof messageSchema>;

/** Runtime-owned non-authoritative state. Never mounted into an engineering container. */
export class CheckpointStore {
	constructor(private readonly directory: string) {
		if (!isAbsolute(directory))
			throw new Error("Checkpoint directory must be absolute");
	}
	private async path(key: string): Promise<string> {
		if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid scope key");
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const stat = await lstat(this.directory);
		if (
			!stat.isDirectory() ||
			(stat.mode & 0o077) !== 0 ||
			stat.uid !== process.getuid?.()
		) {
			throw new Error(
				"Checkpoint store must be private and owned by the runtime user",
			);
		}
		return join(this.directory, `${key}.json`);
	}
	async load(key: string): Promise<Checkpoint | undefined> {
		const path = await this.path(key);
		try {
			const stat = await lstat(path);
			if (!stat.isFile() || stat.size > 30_000_000 || (stat.mode & 0o077) !== 0)
				throw new Error("Unsafe checkpoint");
			const value = checkpointSchema.parse(
				JSON.parse(await readFile(path, "utf8")),
			);
			if (value.scopeKey !== key) throw new Error("Checkpoint scope mismatch");
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	async save(checkpoint: Checkpoint): Promise<void> {
		const parsed = checkpointSchema.parse(checkpoint);
		const path = await this.path(parsed.scopeKey);
		const temp = `${path}.${randomUUID()}.tmp`;
		const serialized = JSON.stringify(parsed);
		if (Buffer.byteLength(serialized) > 30_000_000)
			throw new Error("Checkpoint exceeds limit");
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(serialized);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temp, path);
			const directory = await open(this.directory, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} finally {
			await unlink(temp).catch(() => {});
		}
	}
}
