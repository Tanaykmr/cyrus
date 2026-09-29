# Customer runtime v1 (CYPACK-1546 / CYHOST-1321)

Status: hosted owner is integrating the v1 wire contract; the renewal/result
clarifications below are coordinated in CYHOST-1321. No published minimum
`cyrus-ai` version exists yet. Do not infer support from the current package version.
Hosted must require successful versioned capability discovery; a 404, old runtime,
unknown version, or unavailable isolation backend must fail dispatch closed.

## Entry-point audit

The general runtime remains unscoped. These paths must **never** receive private
customer jobs or serve as fallback dispatch for scoped runs:

| Entry | Existing path/state |
| --- | --- |
| `cyrus start` | `Application` loads global `.env`, `WorkerService` creates `EdgeWorker` |
| CLI/F1 RPC | `CLIRPCServer`: start/prompt/stopSession, issue/comment creation |
| Linear | AgentSession created/prompted, issue update, assignment, parked reprompt |
| GitHub | PR comments/reviews, queued follow-ups and push events |
| GitLab | MR comments/reviews and resumed sessions |
| Slack | `ChatSessionHandler`, thread-key lookup, streaming injection, continuation |
| Zulip | Same handler via `ZulipChatAdapter`, topic/message cursor |
| F1 synthetic Slack | `EdgeWorker.dispatchChatTestEvent` |
| Delegation | Cyrus-tools child session mapping, feedback delivery, parent resume |
| Recovery | `restoreMappings`, `GlobalSessionRegistry`, remote Claude session store, warmup, `resumeAgentSession` |
| Native execution | Claude, Codex, Gemini, Cursor and OpenCode runners |

`RunnerConfigBuilder.buildChatConfig` intentionally retains legacy platform-wide
memory and connector configuration for unscoped workflows. Scoped execution uses
a separate service, has no import/lookup into those session stores, never invokes
a native CLI and never reads their settings, plugins or auto-memory. Ticket text,
description selectors, environment markers, model output and repository routing
cannot create scope.

## Trust boundary

The hosted gateway is the authority. The runtime introspects an opaque bearer
capability over HTTPS to a statically configured gateway origin; it never decodes
unsigned claims or accepts identity fields from launch input. Gateway responses
are strict and versioned. Every model turn/tool/callback revalidates lease,
generation, revision, pause and revocation. Gateway writes must check again in
their own transaction; preflight authorization alone is not write authorization.

Customer worker results are only their own run output. Customer writes (support,
billing, tenant, authoritative memory and decisions) are coordinator-only and
gateway-mediated. Engineering is a distinct capability. Shared engineering
receives only a gateway-supplied, operator-reviewed technical brief, synthetic
reproduction and repository snapshot. It has no customer-read capability.

Engineering code executes in an operator-reviewed immutable container image with
no host mounts, no network, no account credentials, no Docker socket, empty command
environment, non-root UID, read-only root, bounded tmpfs, dropped capabilities and
resource/time/output limits. Only the trusted broker can reach the fixed model
API and hosted gateway. Repository code cannot call either. Images must contain
no secrets or private customer data; the local Docker daemon and image are part
of the trusted computing base. No automatic image pull or dependency installation.

## Proposed endpoints

- Runtime `GET /customer-runtime/v1/capabilities`
- Runtime `POST /customer-runtime/v1/runs` with `{contractVersion: 1, token}`
- Runtime `POST /customer-runtime/v1/resume` with the same body; no session ID
- Runtime `POST /customer-runtime/v1/interrupt` with the same body
- Hosted `POST /api/customer-runtime/v1/authorize`
- Hosted `POST /api/customer-runtime/v1/read`, `/action`, `/engineering`,
  `/delegate`, `/progress`, `/result`

All hosted requests use `Authorization: Bearer <opaque capability>` and have
`contractVersion: 1`. Credentials and request bodies must not be logged. Redirects
are forbidden. No callback URL, database connection, connector token or SQL is
accepted from a launch or model. Exact operation schemas are being coordinated
in CYHOST-1321 before hosted integration relies on them.

## Recovery

Scope includes workspace, customer, run, role, generation, policy revision,
expiration and engineering assignment. No unscoped session identifier is accepted.
Persisted authoritative memory stays behind hosted reads/writes. Runtime
checkpoints and run output are scoped, non-authoritative and cannot be read by
other runs or engineering containers. Resume must reauthenticate current scope;
changing generation/revision never revives revoked state. Gateway journals exact
external-action parameters and idempotency keys and reconciles uncertain outcomes
before retry. Stopping cannot retract a provider request already in flight.

## Configuration and launch

This service is separate from `cyrus start`. It does not load `~/.cyrus/.env`,
`config.json`, platform memory, repository setup scripts, native MCP configuration
or provider CLI sessions. Keep its configuration private (mode 0600), use a
dedicated process user and checkpoint directory, and expose its loopback listener
only through the hosted authenticated TLS transport.

```json
{
  "gatewayOrigin": "https://your-hosted-gateway.example",
  "checkpointDirectory": "/private/runtime/customer-checkpoints",
  "apiKey": "EXPLICIT_MODEL_API_KEY",
  "model": "OPERATOR_SELECTED_MODEL",
  "port": 3457,
  "docker": {
    "dockerPath": "/usr/local/bin/docker",
    "dockerHost": "unix:///var/run/docker.sock",
    "image": "sha256:OPERATOR_REVIEWED_LOCAL_IMAGE_ID"
  }
}
```

```sh
cyrus customer-runtime --config /private/runtime/customer-runtime.json
```

The image must already be present and include `/usr/bin/env`, `/bin/sh`, and
`/usr/local/bin/bun`. Install required test dependencies into a clean reviewed
image ahead of dispatch; runtime network installation is deliberately unavailable.
The current artifact format is a bounded UTF-8 file snapshot (up to 800 KB for
published/checkpointed artifacts), not an arbitrary repository archive. Symlinks,
special files and binary artifacts fail closed. Larger/binary repositories need a
future versioned artifact transport, not a fallback to host filesystem access.
Deployments are denied in v1. GitHub credentials and PR publication stay in hosted.

Launch/resume bodies are strict `{contractVersion:1,token}`. The runtime derives
all identity from `/authorize`, and rejects unsupported fields, unknown versions
and unavailable isolation. Resume loads only the authenticated scope hash; it
does not accept a session identifier. Tokens are never checkpointed. Checkpoints
are atomically replaced and fsynced before external actions; pending artifacts
and result callbacks retain their exact payload/idempotency key across retry.

Hosted must serialize admission using the runtime-generated `executionId`, deny
a second active owner, and permit a fresh resume owner only after the prior lease
has expired or been explicitly interrupted. Interrupt authentication validates
scope without replacing the active execution owner. Every operation endpoint
must recheck the owner/current generation/revision/pause/lease in the same
transaction as its action claim. `execute` only mutates an offline sandbox and
can be replayed from the preceding file checkpoint; external operations must be
deduplicated/reconciled by hosted. A lost result acknowledgement resends the
persisted result without another model turn.

Revocation is checked before each model turn, tool and callback and polled every
two seconds during work. The current lease and original token expiration also abort locally. A
gateway outage stops execution. Already-in-flight provider requests must be
reconciled by hosted. Abrupt host termination can leave an offline container;
operators must reap orphan `cyrus-scoped-*` containers before restarting the
service. No container is reused by another run.

### Owner fencing, renewable leases and terminal receipts

Every launch/resume attempt creates a **new** `executionId`. This deliberately
does not reuse the owner stored in a previous attempt. Hosted `/authorize` must
perform atomic admission: a live different owner denies takeover; an expired
owner or an explicitly interrupted owner permits it. Every tool/callback checks
the current owner again. `phase: "interrupt"` is an authenticated control request,
not a new execution owner; it fences the old owner and may return an already
expired `leaseUntil`. Runtime still stops that local run and returns interrupted.
Admission authenticates before local checkpoint lookup. If local admission then
fails (for example, no checkpoint exists), hosted must explicitly interrupt that
admission or wait for its lease to expire before attempting a new owner. A failed
local request is not permission to bypass the gateway's current-owner fence.

`phase: "operation"` revalidates and may renew the **same owner's** lease. Runtime
serializes these checks and updates its local timer from the response. A reduced
lease takes effect too. The local deadline is the earlier of the latest lease and
the original token expiration (or any tighter expiration subsequently returned).
Renewal cannot extend the bearer token lifetime. A late renewal after the previous
deadline cannot resurrect an attempt. Revoked, stale, paused or mismatched scopes
abort; they are not lease renewals. Hosted must not silently accept unknown phases.

`phase: "result"` is an additional `/authorize` phase using the same v1 envelope.
It authorizes delivery/reconciliation of the run's result. Hosted must allow a
still-authenticated completed run to enter receipt-only recovery through
`phase: "resume"` and `phase: "result"`, without reopening ordinary operations or
progress updates. Scope, token expiration and the receipt-recovery owner/lease
remain validated. If a result acknowledgement was lost, runtime sends the exact
persisted result and key, with the new attempt ID. It does not invoke the model,
create an engineering sandbox, or post progress, even if the sandbox backend is
now unavailable. A locally acknowledged completed checkpoint returns completed
without repeating any operation or result callback.

For idempotency, namespace the receipt by authenticated scope and idempotency key,
and bind the immutable operation parameters/files or result text. **Exclude
`executionId` from the immutable payload digest**: it is validated separately as
the current attempt, and changes on recovery. Changed immutable content under
the same key must be rejected; uncertain external effects must be reconciled.
Capability discovery now also advertises `leaseRenewal` and `resultReconciliation`.

### Shared engineering sponsorship

For `role: "engineering"`, `customerId` is immutable sponsoring provenance. The
assignment is workspace-owned; top-level `generation` and `policyRevision` bind
the **assignment's** fence/revision, independently of the sponsoring coordinator.
This uses the existing strict v1 schema, without optional unrecognized fields.
The gateway must not apply customer-coordinator pause/revocation to the shared
assignment merely because that customer withdraws while other customers still
require it. Keep the run's sponsoring identity stable; changing it creates a new
scope and cannot attach to the old checkpoint. Assignment revocation or revision
changes must still deny the old engineering run. Engineering scope always has
zero customer reads, no customer action authority and only the reviewed technical
input. Customer-specific results/decisions remain each coordinator's responsibility.

## Validation boundaries

`test/customer-runtime.test.ts` covers authorization and recovery. The opt-in
`test/customer-runtime-sandbox.test.ts` uses a real preinstalled Docker image to
verify edit/test success and denied network, host files, credentials and root
writes. `apps/f1/scoped-runtime-drive.ts` exercises production HTTP dispatch,
delegation, real isolated engineering, callbacks, interruption/resume and
revocation with deterministic model/gateway fixtures. These fixtures are confined
to tests/F1 and are not selectable in the production CLI. They do not establish
live hosted/provider integration; that remains a separate CYHOST-1321 acceptance
gate against the agreed contract and exact runtime head.
