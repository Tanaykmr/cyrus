// Controlled pairing transport; actual AuthCommand, StartCommand and registered
// automation routes. No real auth code, account, tunnel or provider/model request.
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerConfiguredAutomations } from "../../packages/edge-worker/dist/automations/register.js";
import { AuthCommand } from "../cli/dist/src/commands/AuthCommand.js";
import { loadRuntimeEnv } from "../cli/dist/src/utils/loadRuntimeEnv.js";

const require = createRequire(
	new URL("../../packages/edge-worker/package.json", import.meta.url),
);
const Fastify = require("fastify");
const directory = await mkdtemp(join(tmpdir(), "cyrus-preview-pairing-f1-"));
const preview = "https://cyrus-preview-cyhost-1321.vercel.app";
const envBefore = { ...process.env };
const originalFetch = globalThis.fetch;
const consoleLog = console.log;
const output = [];
const fixture = Fastify({ forceCloseConnections: true });
let runtimeServer;
let runtimeOrigin;
let authRequests = 0;
let launchCount = 0;
try {
	console.log = (...args) => output.push(args.join(" "));
	fixture.get("/api/config", async (request) => {
		assert.equal(request.url, "/api/config");
		assert.equal(request.headers.authorization, "Bearer f1-pairing-code");
		authRequests++;
		return {
			success: true,
			config: { apiKey: "f1-runtime-key", cloudflareToken: "f1-tunnel-token" },
		};
	});
	const fixtureOrigin = await fixture.listen({ port: 0, host: "127.0.0.1" });
	globalThis.fetch = async (url, init) => {
		if (String(url) === `${preview}/api/config`) {
			assert.equal(init.redirect, "error");
			return originalFetch(`${fixtureOrigin}/api/config`, init);
		}
		if (
			runtimeOrigin &&
			String(url).startsWith(`${runtimeOrigin}/api/automations/v1/`)
		)
			return originalFetch(url, init);
		throw new Error("F1 denied unexpected external transport");
	};
	process.env.CYRUS_APP_URL = `${preview}/`;
	process.env.CYRUS_TEAM_ID = "f1-existing-workspace";
	process.env.CYRUS_DEFAULT_RUNNER = "claude";
	process.env.CYRUS_CLAUDE_DEFAULT_MODEL = "claude-fixture";
	process.env.ANTHROPIC_API_KEY = "f1-model-key";
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	await writeFile(
		join(directory, ".env"),
		"CYRUS_APP_URL=https://app.atcyrus.com\n",
	);
	loadRuntimeEnv(join(directory, ".env"));
	const logger = Object.fromEntries(
		["success", "error", "divider", "raw", "info"].map((name) => [
			name,
			(...args) => output.push(args.join(" ")),
		]),
	);
	const app = {
		cyrusHome: directory,
		version: "f1-source-build",
		logger,
		config: { load: () => ({ repositories: [] }) },
		worker: {
			startEdgeWorker: async () => {
				assert.equal(process.env.CYRUS_APP_URL, `${preview}/`);
				runtimeServer = Fastify({ forceCloseConnections: true });
				registerConfiguredAutomations(runtimeServer, directory, () => ({
					defaultRunner: "claude",
					claudeDefaultModel: "claude-fixture",
				}));
				runtimeOrigin = await runtimeServer.listen({
					port: 0,
					host: "127.0.0.1",
				});
				launchCount++;
			},
			getServerPort: () => new URL(runtimeOrigin).port,
		},
		setupSignalHandlers() {},
	};
	await new AuthCommand(app).execute(["f1-pairing-code"]);
	const response = await fetch(
		`${runtimeOrigin}/api/automations/v1/capabilities`,
		{ headers: { Authorization: "Bearer f1-runtime-key" } },
	);
	assert.equal(response.status, 200);
	const capabilities = await response.json();
	assert.equal(capabilities.available, true);
	assert.equal(capabilities.workspaceId, "f1-existing-workspace");
	assert.equal(capabilities.capabilities.scopedMcp, true);
	assert.equal(capabilities.capabilities.engineering, false);
	assert.equal(
		(await fetch(`${runtimeOrigin}/api/automations/v1/capabilities`)).status,
		401,
	);
	assert.equal((await stat(join(directory, ".env"))).mode & 0o777, 0o600);
	assert.match(
		await readFile(join(directory, ".env"), "utf8"),
		/CYRUS_APP_URL=https:\/\/cyrus-preview-cyhost-1321.vercel.app\n/,
	);
	for (const secret of [
		"f1-pairing-code",
		"f1-runtime-key",
		"f1-tunnel-token",
		"f1-model-key",
	])
		assert.equal(output.join("\n").includes(secret), false);
	assert.equal(authRequests, 1);
	assert.equal(launchCount, 1);
	const summary = {
		passed: true,
		authRequests,
		launchCount,
		previewOrigin: preview,
		registeredWorkspacePreserved: true,
		authHeaderOnly: true,
		credentialFreeLogs: true,
		privateCredentials: true,
		capabilities,
		limitations: [
			"Local HTTP fixture stands in for hosted auth; no real account pairing",
			"No live model or provider request",
			"Cyrus-owned session persistence/UI gate is separate",
		],
	};
	await writeFile(
		join(directory, "summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
		{ mode: 0o600 },
	);
	consoleLog(
		JSON.stringify(
			{ ...summary, evidence: join(directory, "summary.json") },
			null,
			2,
		),
	);
} finally {
	await runtimeServer?.close();
	await fixture.close();
	globalThis.fetch = originalFetch;
	console.log = consoleLog;
	for (const key of Object.keys(process.env))
		if (!(key in envBefore)) delete process.env[key];
	Object.assign(process.env, envBefore);
}
