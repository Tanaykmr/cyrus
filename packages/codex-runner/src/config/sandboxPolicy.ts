import { isAbsolute } from "node:path";
import type { SandboxMode } from "@openai/codex-sdk";
import type {
	CodexFileSystemAccess,
	ResolvedCodexSandbox,
} from "../backend/types.js";

/** Stable id for the per-thread permission profile Cyrus builds. */
export const CYRUS_SANDBOX_PROFILE_ID = "cyrus-sandbox";

/**
 * Cyrus filesystem sandbox intent (subset of the agent SDK `SandboxSettings`).
 * Paths are expected absolute by the time they reach here (the EdgeWorker layer
 * resolves `~`/`.`/relative entries before plumbing them in).
 *
 * Reads are an allow-list: a path is readable only if it is the worktree
 * (`:workspace_roots`), a platform default (`:minimal`), or appears in
 * `allowRead`/`allowWrite`. Anything else (e.g. the home directory) is denied.
 * `denyRead` is honored by omission — a denied path simply never appears in the
 * allow-list. Sub-path denies inside an allowed root are not expressible (and
 * not needed by Cyrus's deny-broad / allow-narrow posture).
 */
export interface CyrusSandboxFilesystem {
	allowRead?: string[];
	allowWrite?: string[];
	denyRead?: string[];
}

export interface SandboxResolveInput {
	/** Coarse Codex sandbox mode (defaults to workspace-write upstream). */
	mode: SandboxMode;
	/** Session working directory (the worktree; maps to `:workspace_roots`). */
	workingDirectory?: string;
	/** Extra writable roots (e.g. multi-repo sub-worktrees), already absolute. */
	writableRoots: string[];
	networkAccess: boolean;
	/** When present, produces a granular `profile`; otherwise a `workspace-mode`. */
	sandboxSettings?: CyrusSandboxFilesystem;
	/**
	 * Name of a permission profile defined in the repository's own
	 * `.codex/config.toml`. In workspace-write mode it is selected for the
	 * thread instead of the coarse mode or the generated Cyrus profile.
	 */
	permissionsProfile?: string;
}

function uniqueAbsolute(paths: string[]): string[] {
	return [...new Set(paths.filter((p) => p && isAbsolute(p)))];
}

/**
 * Resolve the per-thread sandbox decision.
 *
 * - Explicit read-only/full-access modes or no `sandboxSettings` use the
 *   corresponding native Codex mode.
 * - Workspace-write with a repository `permissionsProfile` selects that
 *   `named-profile`, layering Cyrus's writable roots on top of it.
 * - Workspace-write with `sandboxSettings` uses a granular `profile` that restricts
 *   reads to an allow-list (worktree + platform defaults + explicit reads) and
 *   writes to the worktree + explicit writable roots.
 */
export function resolveCodexSandbox(
	input: SandboxResolveInput,
): ResolvedCodexSandbox {
	const { mode, workingDirectory, writableRoots, networkAccess } = input;

	// A repository-defined profile owns filesystem and network policy (e.g. its
	// domain allowlist). Cyrus only adds the roots a session must write to, such
	// as the main repository's `.git` that worktree commits land in.
	if (input.permissionsProfile && mode === "workspace-write") {
		return {
			kind: "named-profile",
			profileId: input.permissionsProfile,
			writableRoots: uniqueAbsolute(writableRoots).filter(
				(p) => p !== workingDirectory,
			),
		};
	}

	// Explicit native modes take precedence over generated filesystem profiles.
	// A root-writable profile still applies OS sandbox restrictions on macOS.
	if (!input.sandboxSettings || mode !== "workspace-write") {
		return {
			kind: "workspace-mode",
			mode,
			writableRoots: uniqueAbsolute([
				...(workingDirectory ? [workingDirectory] : []),
				...writableRoots,
			]),
			networkAccess,
		};
	}

	const { allowRead = [], allowWrite = [] } = input.sandboxSettings;
	const cwd = workingDirectory;
	// Extra writable roots beyond the worktree (cwd is covered by :workspace_roots).
	const writableAbs = uniqueAbsolute([...writableRoots, ...allowWrite]).filter(
		(p) => p !== cwd,
	);
	// Readable-only roots: explicit reads not already writable / the worktree.
	const readableAbs = uniqueAbsolute(allowRead).filter(
		(p) => p !== cwd && !writableAbs.includes(p),
	);

	const filesystem: Record<string, CodexFileSystemAccess> = {
		":minimal": "read",
		":workspace_roots": "write",
		":tmpdir": "write",
		":slash_tmp": "write",
		...Object.fromEntries(writableAbs.map((p) => [p, "write" as const])),
		...Object.fromEntries(readableAbs.map((p) => [p, "read" as const])),
	};

	return {
		kind: "profile",
		profileId: CYRUS_SANDBOX_PROFILE_ID,
		filesystem,
		networkAccess,
	};
}
