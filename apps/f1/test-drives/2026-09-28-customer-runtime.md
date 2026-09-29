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

## Orchestrator follow-up: lease renewal and completed-run recovery

Tested implementation commit: `2645f787506238aed2cc2411ccc32e83fc5a380c`
Date: 2026-09-28, approximately 19:22 America/Vancouver.
The same reproduction command above passes against this commit. The original
drive and its evidence remain recorded above.

The expanded controlled gateway now enforces execution-owner fencing. Added
HTTP/lifecycle assertions pass:

- A resume using a new execution ID is denied while the existing owner is live.
- Explicit interrupt expires/fences that owner; runtime accepts an expired lease
  in the authenticated interrupt response and a new resume owner can proceed.
- A 400ms model turn survives its initial 150ms lease through authenticated
  renewals. The runtime no longer freezes the first lease deadline.
- A simulated lost result acknowledgement leaves a completed hosted run whose
  ordinary operation/progress paths reject further work. Resume uses the new
  `result` authorization phase and replays the exact persisted result/key with
  a new execution ID, without another model turn or progress callback.
- A subsequent locally completed resume returns completed without replaying
  either the operation or result callback.
- Missing-checkpoint admission is interrupted before admitting a new owner;
  this demonstrates that local rejection does not bypass hosted lease fencing.

Additional output:

```text
PASS renewable lease, fenced resume takeover, terminal receipt reconciliation and completed local resume
```

70 focused tests pass (31 runtime authorization/recovery tests plus real Docker
and existing chat/config/Zulip/resume tests). New tests additionally verify hard
token expiration despite lease renewal, shortened leases, rejection of late
renewals, takeover only after expiration/interruption, engineering terminal
receipt recovery with no sandbox available, and assignment generation/revision
fencing independent of sponsoring-customer withdrawal. Cross-customer/workspace
checkpoint tests and the complete entry-point inventory remain in place.
Build, typecheck and changed-file Biome pass. No hosted files were changed.

Shared engineering uses stable sponsoring `customerId` with zero customer reads;
top-level generation/policyRevision refer to the workspace assignment. Hosted
must implement these role-specific fences and terminal receipt semantics. The
gateway/model remain controlled fixtures; this does not claim connected hosted
or live-provider verification, release, merge or deployment.
