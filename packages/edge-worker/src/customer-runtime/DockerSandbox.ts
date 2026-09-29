import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { filesSchema } from "./contract.js";

/** Trusted, operator-selected immutable image; never supplied by a run/model. */
export interface DockerSandboxConfig {
	dockerPath: string;
	dockerHost: string;
	image: string;
}

export interface EngineeringSandbox {
	start(files: Record<string, string>, signal: AbortSignal): Promise<void>;
	execute(command: string, signal: AbortSignal): Promise<string>;
	snapshot(signal: AbortSignal): Promise<Record<string, string>>;
	stop(): Promise<void>;
}

/**
 * Disposable engineering computer. No host mounts, credentials, network, plugins,
 * git credentials or host repository checkout ever enter this container.
 * The trusted image must provide /usr/bin/env, /bin/sh and /usr/local/bin/bun.
 */
export class DockerSandbox implements EngineeringSandbox {
	private readonly name = `cyrus-scoped-${randomUUID()}`;
	private created = false;

	constructor(private readonly config: DockerSandboxConfig) {
		if (!/^sha256:[a-f0-9]{64}$/.test(config.image)) {
			throw new Error("Scoped engineering requires a local immutable image ID");
		}
		if (
			!config.dockerPath.startsWith("/") ||
			!config.dockerHost.startsWith("unix:///")
		) {
			throw new Error(
				"Scoped engineering requires an absolute Docker binary and local Unix socket",
			);
		}
	}

	private command(
		args: string[],
		signal?: AbortSignal,
		input?: string,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn(
				this.config.dockerPath,
				["--host", this.config.dockerHost, ...args],
				{
					env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
					stdio: ["pipe", "pipe", "pipe"],
					signal,
				},
			);
			let output = "";
			let size = 0;
			const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
			const consume = (chunk: Buffer) => {
				size += chunk.length;
				if (size > 1_048_576) child.kill("SIGKILL");
				else output += chunk.toString();
			};
			child.stdout.on("data", consume);
			child.stderr.on("data", consume);
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0 && size <= 1_048_576) resolve(output);
				else
					reject(
						new Error(
							"Isolated engineering command failed or exceeded its limit",
						),
					);
			});
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		});
	}

	async start(
		files: Record<string, string>,
		signal: AbortSignal,
	): Promise<void> {
		const info = JSON.parse(
			await this.command(["image", "inspect", this.config.image], signal),
		);
		if (Object.keys(info[0]?.Config?.Volumes ?? {}).length) {
			throw new Error("Scoped engineering images cannot declare volumes");
		}
		// Mark before launch so interruption/timeout still removes a created container.
		this.created = true;
		try {
			await this.command(
				[
					"run",
					"--detach",
					"--rm",
					"--pull=never",
					"--name",
					this.name,
					"--network=none",
					"--read-only",
					"--no-healthcheck",
					"--cap-drop=ALL",
					"--security-opt=no-new-privileges",
					"--pids-limit=64",
					"--memory=512m",
					"--cpus=1",
					"--user=1000:1000",
					"--workdir=/work",
					"--tmpfs=/work:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700",
					"--tmpfs=/tmp:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700",
					"--entrypoint=/usr/bin/env",
					this.config.image,
					"-i",
					"PATH=/usr/local/bin:/usr/bin:/bin",
					"HOME=/work/home",
					"/usr/local/bin/bun",
					"-e",
					"setInterval(()=>{}, 1000000)",
				],
				signal,
			);
			await this.command(
				[
					"exec",
					"-i",
					this.name,
					"/usr/bin/env",
					"-i",
					"PATH=/usr/local/bin:/usr/bin:/bin",
					"HOME=/work/home",
					"/usr/local/bin/bun",
					"-e",
					`const fs = require('node:fs'); const path = require('node:path');
const files = JSON.parse(await Bun.stdin.text());
for (const [name, content] of Object.entries(files)) {
 if (!name || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..') || name.includes('\\\\') || name.includes('\\0')) throw Error('Invalid path');
 const target = path.join('/work', name); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, content, {flag:'wx'});
}`,
				],
				signal,
				JSON.stringify(files),
			);
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	async execute(command: string, signal: AbortSignal): Promise<string> {
		if (!this.created) throw new Error("Engineering sandbox is not running");
		try {
			return await this.command(
				[
					"exec",
					this.name,
					"/usr/bin/env",
					"-i",
					"PATH=/usr/local/bin:/usr/bin:/bin",
					"HOME=/work/home",
					"/bin/sh",
					"-c",
					command,
				],
				signal,
			);
		} catch (error) {
			// Killing only the docker client would leave an exec process alive.
			await this.stop();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.created) {
			await this.command(["rm", "--force", this.name]);
			this.created = false;
		}
	}

	async snapshot(signal: AbortSignal): Promise<Record<string, string>> {
		const result = await this.execute(
			`bun -e '
const fs = require("node:fs"), path = require("node:path");
const files = Object.create(null); let bytes = 0;
function visit(dir) {
 for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
  const name = path.join(dir, entry.name);
  if (entry.isSymbolicLink()) throw Error("Symlinks cannot be published");
  if (entry.isDirectory()) visit(name);
  else if (entry.isFile()) {
   const stat = fs.statSync(name);
   bytes += stat.size;
   if(bytes > 800000 || Object.keys(files).length >= 1000) throw Error("Artifact limit");
   const data = fs.readFileSync(name);
   const text = new TextDecoder("utf-8", {fatal:true}).decode(data);
   files[path.relative("/work", name)] = text;
  } else throw Error("Non-regular artifact");
 }
}
visit("/work"); console.log(JSON.stringify(files));'`,
			signal,
		);
		return filesSchema.parse(JSON.parse(result));
	}
}
