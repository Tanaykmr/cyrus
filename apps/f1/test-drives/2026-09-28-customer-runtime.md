# Customer-scoped runtime F1 drive

Date: 2026-09-28 (America/Vancouver)
Tested implementation commit: `fc16b5a95fefeef8ce35a05faa26c7adf3936e0b`
PR: https://github.com/cyrusagents/cyrus/pull/1507
Issue: CYPACK-1546, dependency of CYHOST-1321

## Scope and evidence source

The changed workflow is the standalone `cyrus customer-runtime` service, not a
legacy Linear/Slack native runner. This drive exercises the production scoped
HTTP routes, scope/lifecycle enforcement, checkpoint store and Docker executor.
The model and hosted gateway are deterministic F1 fixtures. The engineering
container, code edit, test command and HTTP requests are real. There are no live
model API calls, customer contacts, provider PR writes, merges or deployments.

The local preinstalled `oven/bun:1.3.14` image was selected by immutable image ID.
No image was pulled. Temporary checkpoint state and containers were removed by
the drive. No credentials are included in this report.

## Reproduction

```sh
pnpm build
CYRUS_TEST_SANDBOX_IMAGE=sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 \
CYRUS_TEST_DOCKER_HOST=unix:///Users/agentops/.docker/run/docker.sock \
bun run apps/f1/scoped-runtime-drive.ts
```

Use the actual local Docker socket and an explicitly reviewed, preinstalled
image on another host. The runner does not automatically provision either.

## Assertions and results

- PASS: versioned capability discovery advertises the separate scoped runtime.
- PASS: launch rejects an additional malicious customer ID.
- PASS: another customer's resume cannot load a checkpoint.
- PASS: authenticated coordinator delegates an assignment; fixture hosted
  dispatch launches a separately authenticated engineering run. The model never
  receives the delegated run token.
- PASS: shared engineering model input contains only technical brief and
  synthetic reproduction, without the customer's private prompt.
- PASS: a real offline container changes `sum(a,b)` from subtraction to addition
  and runs a Bun assertion that `sum(2,3) === 5`.
- PASS: the engineering publication callback contains the repaired file;
  progress and final run results are delivered.
- PASS: a worker's support-send action never reaches the gateway action endpoint.
- PASS: two customers in one workspace and a customer in another workspace
  execute under distinct authenticated namespaces.
- PASS: interrupt aborts in-flight model work, and authenticated resume produces
  exactly one final result.
- PASS: live gateway revocation aborts in-flight work and denies both resume and
  result posting.

Output:

```text
PASS scoped launch, delegation, isolated edit/test, artifact, progress/result
PASS worker-write denial and two customers plus another workspace
PASS interruption/resume and live revocation denying resume/result
```

Additional verification: 60 scoped-runtime, real sandbox and legacy
chat/Zulip/resume regression tests; 160 CLI tests; build, typecheck and changed-file
Biome passed. The sandbox test actually asserts non-root UID, absence of host
paths and a synthetic inherited secret, denied root writes and denied external
network access. Recovery tests retain exact publication/result payloads and
idempotency keys after lost acknowledgements.

## Remaining integration gates

This is controlled runtime evidence, not live CYHOST-1321 hosted/provider proof.
The exact gateway schema was posted to that existing session for agreement.
Hosted must implement current-owner lease/CAS, action serialization and
idempotency/reconciliation, scoped provider reads, reviewed repository snapshots
and real engineering publication. The PR remains a draft pending that contract
and integration gate. No minimum published `cyrus-ai` version exists yet.
