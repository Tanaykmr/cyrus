import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/customer-runtime/CheckpointStore.js";
import {
	type Authorization,
	scopeKey,
} from "../src/customer-runtime/contract.js";
import { DockerSandbox } from "../src/customer-runtime/DockerSandbox.js";
import { ScopedRuntime } from "../src/customer-runtime/ScopedRuntime.js";

// Explicit local opt-in: never pull images or contact production services.
const image = process.env.CYRUS_TEST_SANDBOX_IMAGE;
const host = process.env.CYRUS_TEST_DOCKER_HOST;
describe.skipIf(!image || !host)("real scoped engineering isolation", () => {
	it("executes a synthetic repair without host credentials, mounts or network", async () => {
		const sandbox = new DockerSandbox({
			dockerPath: "/usr/local/bin/docker",
			dockerHost: host!,
			image: image!,
		});
		const signal = new AbortController().signal;
		const prior = process.env.CYRUS_SCOPED_HOST_SECRET;
		process.env.CYRUS_SCOPED_HOST_SECRET =
			"synthetic-host-secret-must-not-inherit";
		try {
			await sandbox.start(
				{ "sum.js": "export const sum = (a,b) => a-b;" },
				signal,
			);
			expect(await sandbox.execute("cat sum.js", signal)).toEqual({
				exitCode: 0,
				stdout: "export const sum = (a,b) => a-b;",
				stderr: "",
			});
			expect(
				await sandbox.execute(
					"printf 'export const sum = (a,b) => a+b;' > sum.js; bun -e \"import {sum} from './sum.js'; if(sum(2,3)!==5) process.exit(1); console.log('passed')\"",
					signal,
				),
			).toEqual({ exitCode: 0, stdout: "passed\n", stderr: "" });
			const proof = await sandbox.execute(
				`bun -e '
const fs = require("node:fs");
if (process.getuid() === 0) throw Error("root");
for (const p of ["/var/run/docker.sock", "/Users/agentops", "/root/.aws", "/root/.config", "/root/.cyrus"]) {
 if(fs.existsSync(p)) throw Error("host path: " + p);
}
for (const k of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "LINEAR_API_KEY", "DATABASE_URL", "DOCKER_HOST", "CYRUS_SCOPED_HOST_SECRET"]) {
 if(process.env[k]) throw Error("credential: " + k);
}
try { fs.writeFileSync("/etc/cyrus-escape", "bad"); throw Error("writable root"); } catch(e) { if(e.message === "writable root") throw e; }
try { await fetch("http://1.1.1.1", {signal: AbortSignal.timeout(1000)}); throw Error("network"); } catch(e) { if(e.message === "network") throw e; }
console.log("isolated");'`,
				signal,
			);
			expect(proof).toEqual({ exitCode: 0, stdout: "isolated\n", stderr: "" });
		} finally {
			if (prior === undefined) delete process.env.CYRUS_SCOPED_HOST_SECRET;
			else process.env.CYRUS_SCOPED_HOST_SECRET = prior;
			await sandbox.stop();
		}
	}, 30_000);
});

describe.skipIf(!image || !host)("real engineering failure recovery", () => {
	const createSandbox = () =>
		new DockerSandbox({
			dockerPath: "/usr/local/bin/docker",
			dockerHost: host!,
			image: image!,
		});
	it("returns failing-test diagnostics and checkpoints preceding edits before model repair and retest", async () => {
		const root = await mkdtemp(join(tmpdir(), "cyrus-command-repair-"));
		const store = new CheckpointStore(root);
		const auth: Authorization = {
			contractVersion: 1,
			scope: {
				workspaceId: "workspace",
				customerId: "sponsor",
				runId: "repair",
				role: "engineering",
				generation: 1,
				policyRevision: 1,
				expiresAt: new Date(Date.now() + 60000).toISOString(),
				leaseUntil: new Date(Date.now() + 60000).toISOString(),
				reads: [],
				engineering: {
					assignmentId: "assignment",
					repository: "synthetic/calculator",
					baseSha: "a".repeat(40),
					headBranch: "repair",
					reviewId: "review",
					operations: ["execute"],
					environment: "isolated",
					deployment: "deny",
				},
			},
			input: {
				kind: "engineering",
				reviewId: "review",
				technicalBrief: "Fix sum",
				syntheticReproduction: "2+3=5",
				files: {
					"sum.js": "export const sum = (a,b) => a-b;",
					"sum.test.js":
						'import {test,expect} from "bun:test"; import {sum} from "./sum.js"; test("adds",()=>expect(sum(2,3)).toBe(5));',
				},
			},
		};
		let turns = 0;
		const runtime = new ScopedRuntime({
			store,
			sandbox: createSandbox,
			gateway: {
				async call(endpoint) {
					return endpoint === "authorize" ? auth : { accepted: true };
				},
			},
			model: {
				async next(messages) {
					const turn = turns++;
					if (turn === 0)
						return {
							type: "operation",
							operation: {
								kind: "execute",
								command: "printf retained > before-failure.txt; bun test",
							},
						};
					const state = await store.load(scopeKey(auth.scope));
					const result = JSON.parse(messages.at(-1)!.content).operationResult;
					expect(state?.pending).toBeUndefined();
					expect(state?.files?.["before-failure.txt"]).toBe("retained");
					if (turn === 1) {
						expect(result.exitCode).toBe(1);
						expect(result.stderr).toContain("Expected: 5");
						expect(state?.files?.["sum.js"]).toBe(
							"export const sum = (a,b) => a-b;",
						);
						return {
							type: "operation",
							operation: {
								kind: "execute",
								command:
									"printf 'export const sum = (a,b) => a+b;' > sum.js; bun test",
							},
						};
					}
					expect(result.exitCode).toBe(0);
					expect(result.stderr).toContain("1 pass");
					expect(state?.files?.["sum.js"]).toBe(
						"export const sum = (a,b) => a+b;",
					);
					return { type: "result", text: "Repaired with passing test" };
				},
			},
		});
		try {
			await runtime.launch({
				contractVersion: 1,
				token: "fixture".padEnd(40, "-"),
			});
			await runtime.drain();
			expect(turns).toBe(3);
			expect((await store.load(scopeKey(auth.scope)))?.status).toBe(
				"completed",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30000);

	it.each([
		"abort",
		"timeout",
		"output limit",
	])("stops the container on %s", async (failure) => {
		const sandbox = createSandbox();
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await sandbox.start({}, controller.signal);
			if (failure === "abort")
				timer = setTimeout(() => controller.abort(), 250);
			const command =
				failure === "output limit"
					? `bun -e 'console.log("x".repeat(2000000))'`
					: "sleep 40";
			await expect(
				sandbox.execute(command, controller.signal),
			).rejects.toThrow();
			await expect(
				sandbox.execute("echo must-not-run", new AbortController().signal),
			).rejects.toThrow("not running");
		} finally {
			clearTimeout(timer);
			await sandbox.stop();
		}
	}, 40000);
});
