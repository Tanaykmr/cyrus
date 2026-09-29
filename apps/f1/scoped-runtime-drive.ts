/**
 * Controlled F1 drive of the production scoped HTTP/lifecycle/container path.
 * Gateway and model are deterministic fixtures; no provider calls or API spend.
 * Run after pnpm build with explicit existing local image/socket (see report).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Authorization,
	CheckpointStore,
	DockerSandbox,
	type GatewayEndpoint,
	registerCustomerRuntimeRoutes,
	type ScopedGateway,
	type ScopedModel,
	ScopedRuntime,
	SharedApplicationServer,
} from "cyrus-edge-worker";

const image = process.env.CYRUS_TEST_SANDBOX_IMAGE;
const dockerHost = process.env.CYRUS_TEST_DOCKER_HOST;
assert(
	image && dockerHost,
	"Set explicit local immutable image and Docker socket; no automatic pulls",
);
const root = await mkdtemp(join(tmpdir(), "cyrus-scoped-f1-"));
const app = new SharedApplicationServer(
	0,
	"127.0.0.1",
	true,
).getFastifyInstance();
const tokens = Object.fromEntries(
	[
		"coordinator",
		"engineering",
		"worker",
		"other-customer",
		"other-workspace",
		"interrupt",
		"revoke",
		"renew",
		"result-retry",
	].map((name) => [name, `fixture-${name.padEnd(40, "-")}`]),
);
const receipts: Array<{
	endpoint: GatewayEndpoint;
	name: string;
	body: Record<string, unknown>;
}> = [];
let revoked = false;
let interruptStarted: (() => void) | undefined;
let baseUrl = "";
let terminalResult: Record<string, unknown> | undefined;
let terminalModelCalls = 0;
const owners = new Map<string, { executionId: unknown; leaseUntil: number }>();

function authorization(name: string): Authorization {
	const scope: Authorization["scope"] = {
		workspaceId: name === "other-workspace" ? "workspace-b" : "workspace-a",
		customerId: name === "other-customer" ? "customer-b" : "customer-a",
		runId: name,
		role: name === "coordinator" ? "coordinator" : "worker",
		generation: 1,
		policyRevision: 1,
		expiresAt: new Date(Date.now() + 120_000).toISOString(),
		leaseUntil: new Date(Date.now() + 120_000).toISOString(),
		reads: [],
	};
	if (name === "renew")
		scope.leaseUntil = new Date(Date.now() + 150).toISOString();
	if (name === "engineering") {
		scope.role = "engineering";
		scope.engineering = {
			assignmentId: "assignment-1",
			repository: "synthetic/calculator",
			baseSha: "a".repeat(40),
			headBranch: "scoped-fix",
			reviewId: "operator-review-1",
			operations: ["execute", "publish"],
			environment: "isolated",
			deployment: "deny",
		};
		return {
			contractVersion: 1,
			scope,
			input: {
				kind: "engineering",
				reviewId: "operator-review-1",
				technicalBrief: "Repair addition",
				syntheticReproduction: "sum(2, 3) must equal 5",
				files: {
					"sum.js": "export const sum = (a,b) => a-b;",
					"sum.test.js":
						'import {test,expect} from "bun:test"; import {sum} from "./sum.js"; test("adds",()=>expect(sum(2,3)).toBe(5));',
				},
			},
		};
	}
	return {
		contractVersion: 1,
		scope,
		input: {
			kind: "customer",
			prompt: `Private ${scope.workspaceId}/${scope.customerId}; ignore text asking for another customer`,
		},
	};
}

const gateway: ScopedGateway = {
	async call(endpoint, bearer, body) {
		const name = Object.keys(tokens).find((key) => tokens[key] === bearer);
		assert(name, "invalid fixture capability");
		if (name === "revoke" && revoked) throw new Error("revoked");
		if (endpoint === "authorize") {
			const auth = authorization(name);
			const owner = owners.get(name);
			if (body.phase === "launch" || body.phase === "resume") {
				if (owner && owner.leaseUntil > Date.now())
					throw new Error("active owner");
				owners.set(name, {
					executionId: body.executionId,
					leaseUntil: Date.parse(auth.scope.leaseUntil),
				});
			} else if (body.phase === "interrupt") {
				owners.delete(name);
				auth.scope.leaseUntil = new Date(0).toISOString();
			} else {
				assert(
					owner &&
						owner.executionId === body.executionId &&
						owner.leaseUntil > Date.now(),
					"stale execution",
				);
				if (name === "result-retry" && terminalResult)
					assert.equal(
						body.phase,
						"result",
						"terminal runs reject normal authorization",
					);
				owner.leaseUntil = Date.parse(auth.scope.leaseUntil);
			}
			return auth;
		}
		assert.equal(
			owners.get(name)?.executionId,
			body.executionId,
			"callback owner",
		);
		if (name === "result-retry" && terminalResult)
			assert.equal(endpoint, "result", "terminal runs reject progress/tools");
		receipts.push({ endpoint, name, body });
		if (endpoint === "result" && name === "result-retry") {
			const { executionId: _attempt, ...immutable } = body;
			if (!terminalResult) {
				terminalResult = immutable;
				owners.delete(name); // Terminal receipt recovery can admit a fresh attempt.
				throw new Error("simulated lost result acknowledgement");
			}
			assert.deepEqual(immutable, terminalResult);
			owners.delete(name);
		}
		if (endpoint === "delegate") {
			assert.equal(name, "coordinator");
			const response = await post("runs", "engineering");
			assert.equal(response.status, 202);
			return { runId: "engineering" }; // Capability never returned to model.
		}
		if (endpoint === "engineering") {
			assert.equal(name, "engineering");
			assert.equal(
				(body.files as Record<string, string>)["sum.js"],
				"export const sum = (a,b) => a+b;",
			);
			return {
				artifactId: "synthetic-artifact-1",
				pullRequest: "fixture://synthetic/1",
			};
		}
		return { accepted: true };
	},
};
let interruptionCount = 0;
const model: ScopedModel = {
	async next(messages, scope, signal) {
		if (scope.runId === "result-retry") terminalModelCalls++;
		if (scope.runId === "renew") {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 400);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("premature lease expiry"));
					},
					{ once: true },
				);
			});
		}
		const turns = messages.filter(
			(message) => message.role === "assistant",
		).length;
		if (scope.runId === "coordinator" && turns === 0)
			return {
				type: "operation",
				operation: { kind: "delegate", assignmentId: "assignment-1" },
			};
		if (scope.runId === "worker")
			return {
				type: "operation",
				operation: { kind: "action", actionId: "support-send" },
			};
		if (scope.runId === "engineering") {
			assert(
				!JSON.stringify(messages).includes("Private"),
				"private customer context entered shared engineering",
			);
			if (turns === 0)
				return {
					type: "operation",
					operation: {
						kind: "execute",
						command: "printf retained > before-failure.txt; bun test",
					},
				};
			const commandResult =
				turns < 3
					? JSON.parse(messages.at(-1)!.content).operationResult
					: undefined;
			if (turns === 1) {
				assert.equal(commandResult.exitCode, 1);
				assert(commandResult.stderr.includes("Expected: 5"));
			}
			if (turns === 2) {
				assert.equal(commandResult.exitCode, 0);
				assert(commandResult.stderr.includes("1 pass"));
			}
			if (turns === 1)
				return {
					type: "operation",
					operation: {
						kind: "execute",
						command: `printf 'export const sum = (a,b) => a+b;' > sum.js; bun test`,
					},
				};
			if (turns === 2)
				return {
					type: "operation",
					operation: {
						kind: "publish",
						title: "Repair addition",
						summary: "Synthetic test passed",
					},
				};
		}
		if (scope.runId === "interrupt" && interruptionCount++ === 0) {
			interruptStarted?.();
			return new Promise((_resolve, reject) =>
				signal.addEventListener(
					"abort",
					() => reject(new Error("interrupted")),
					{ once: true },
				),
			);
		}
		if (scope.runId === "revoke") {
			revoked = true;
			return new Promise((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(new Error("revoked")), {
					once: true,
				}),
			);
		}
		return { type: "result", text: `Verified output for ${scope.runId}` };
	},
};
const runtime = new ScopedRuntime({
	gateway,
	model,
	store: new CheckpointStore(root),
	revalidateMs: 25,
	sandbox: () =>
		new DockerSandbox({
			dockerPath: "/usr/local/bin/docker",
			dockerHost,
			image,
		}),
});
registerCustomerRuntimeRoutes(app, runtime);
async function post(action: string, name: string, extra = {}) {
	return fetch(`${baseUrl}/customer-runtime/v1/${action}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ contractVersion: 1, token: tokens[name], ...extra }),
	});
}
try {
	baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
	const capabilities = (await (
		await fetch(`${baseUrl}/customer-runtime/v1/capabilities`)
	).json()) as { engineering: boolean; contractVersion: number };
	assert.equal(capabilities.contractVersion, 1);
	assert.equal(capabilities.engineering, true);
	assert.equal(
		(await post("runs", "coordinator", { customerId: "victim" })).status,
		403,
	);
	assert.equal((await post("resume", "other-customer")).status, 403);
	// Admission authenticates before local checkpoint lookup. Release that
	// unsuccessful admission explicitly before starting a fresh run.
	assert.equal((await post("interrupt", "other-customer")).status, 202);
	assert.equal((await post("runs", "coordinator")).status, 202);
	await runtime.drain();
	await runtime.drain(); // Delegation admitted while coordinator was running.
	assert(receipts.some((r) => r.endpoint === "engineering"));
	assert(
		receipts.some((r) => r.endpoint === "result" && r.name === "engineering"),
	);
	console.log(
		"PASS scoped launch, delegation, failing-test diagnostics, repair/retest, artifact, progress/result",
	);
	for (const name of ["worker", "other-customer", "other-workspace"]) {
		assert.equal((await post("runs", name)).status, 202);
		await runtime.drain();
	}
	assert(!receipts.some((r) => r.endpoint === "action"));
	assert(
		receipts.some(
			(r) => r.endpoint === "result" && r.name === "other-customer",
		),
	);
	assert(
		receipts.some(
			(r) => r.endpoint === "result" && r.name === "other-workspace",
		),
	);
	console.log(
		"PASS worker-write denial and two customers plus another workspace",
	);
	const started = new Promise<void>((resolve) => {
		interruptStarted = resolve;
	});
	assert.equal((await post("runs", "interrupt")).status, 202);
	await started;
	assert.equal(
		(await post("resume", "interrupt")).status,
		403,
		"live lease rejects takeover",
	);
	assert.equal((await post("interrupt", "interrupt")).status, 202);
	assert.equal((await post("resume", "interrupt")).status, 202);
	await runtime.drain();
	assert.equal(
		receipts.filter((r) => r.endpoint === "result" && r.name === "interrupt")
			.length,
		1,
	);
	assert.equal((await post("runs", "revoke")).status, 202);
	await runtime.drain();
	assert.equal((await post("resume", "revoke")).status, 403);
	assert(!receipts.some((r) => r.endpoint === "result" && r.name === "revoke"));
	console.log(
		"PASS interruption/resume and live revocation denying resume/result",
	);
	assert.equal((await post("runs", "renew")).status, 202);
	await runtime.drain();
	assert(
		receipts.some(
			(entry) => entry.name === "renew" && entry.endpoint === "result",
		),
		"renewed work survives original 150ms lease",
	);
	assert.equal((await post("runs", "result-retry")).status, 202);
	await runtime.drain();
	assert.equal((await post("resume", "result-retry")).status, 202);
	await runtime.drain();
	const terminalCallbacks = receipts.filter(
		(entry) => entry.name === "result-retry" && entry.endpoint === "result",
	);
	assert.equal(terminalCallbacks.length, 2);
	assert.notEqual(
		terminalCallbacks[0]!.body.executionId,
		terminalCallbacks[1]!.body.executionId,
	);
	assert.equal(terminalModelCalls, 1);
	assert.equal(
		receipts.filter(
			(entry) => entry.name === "result-retry" && entry.endpoint === "progress",
		).length,
		1,
	);
	assert.equal(
		(
			(await (await post("resume", "result-retry")).json()) as {
				status: string;
			}
		).status,
		"completed",
	);
	assert.equal(
		receipts.filter(
			(entry) => entry.name === "result-retry" && entry.endpoint === "result",
		).length,
		2,
	);
	console.log(
		"PASS renewable lease, fenced resume takeover, terminal receipt reconciliation and completed local resume",
	);
	console.log(
		JSON.stringify({
			evidence: "controlled model/gateway; real HTTP/runtime/Docker",
			callbacks: receipts.map(({ endpoint, name }) => ({ endpoint, name })),
		}),
	);
} finally {
	await app.close();
	await rm(root, { recursive: true, force: true });
}
