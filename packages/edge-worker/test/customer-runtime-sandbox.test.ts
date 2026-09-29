import { describe, expect, it } from "vitest";
import { DockerSandbox } from "../src/customer-runtime/DockerSandbox.js";

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
			expect(await sandbox.execute("cat sum.js", signal)).toBe(
				"export const sum = (a,b) => a-b;",
			);
			expect(
				await sandbox.execute(
					"printf 'export const sum = (a,b) => a+b;' > sum.js; bun -e \"import {sum} from './sum.js'; if(sum(2,3)!==5) process.exit(1); console.log('passed')\"",
					signal,
				),
			).toBe("passed\n");
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
			expect(proof).toBe("isolated\n");
		} finally {
			if (prior === undefined) delete process.env.CYRUS_SCOPED_HOST_SECRET;
			else process.env.CYRUS_SCOPED_HOST_SECRET = prior;
			await sandbox.stop();
		}
	}, 30_000);
});
