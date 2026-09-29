# Registered runtime automations v1

This is the current CYPACK-1546 / CYHOST-1321 implementation contract, agreed through
issue comments after Connor's September 29 architecture and `/mcp` direction. It
supersedes the standalone customer-runtime URL/global-model product path and crossed
storage proposals. No release/minimum published version, production enablement or
live provider authority is implied. Historical 269e containment evidence is retained;
it does not accept this redesign.

## One owner per concern

| Concern | Authority |
| --- | --- |
| Generic definitions, applied revisions/tombstones, instruction dedup, clock occurrences, execution leases | CYPACK `AutomationLedger`, private SQLite in `automation-ledger-v1/<workspace hash>.sqlite`; BEGIN IMMEDIATE and synchronous FULL persist before execution |
| Tick generation, queue draining, attempts and execution | CYPACK `AutomationRuntime`; one scheduling algorithm, periodic 15s wake and explicit authenticated wake |
| Private execution checkpoint, pending immutable tool/result | CYPACK `AutomationCheckpointStore`, separate `automation-checkpoints-v1`, never a native session/memory path |
| Customer binding/desired revision, operator/provider inbox, reliable definition/enqueue delivery | CYHOST binding/outbox; outbox retries preserve the original event ID/body |
| Registered supervisor ownership across machines/copies | CYHOST 90s owner lease/generation, random runtime instanceId per boot; no live-owner takeover |
| Customer scope, coordinator write fence, policy/approval, provider credentials, operation receipts | CYHOST existing authority/action ledger, reused by admission and `/mcp` |

Hosted cron may deliver/reconcile an outbox and wake the runtime; it must not create
clock occurrences or run a competing model loop for migrated automations. No CYPACK
module imports customer tables. Non-customer work uses the same generic definition,
ledger and authority adapter. SQLite is the generic durable store, not a replica of
a second hosted automation scheduler.

## Registered transport

Routes mount on `SharedApplicationServer`, both active EdgeWorker and repository-less
WorkerService setup/idle modes. Existing cloud droplet/self-host tunnel registration
and `Authorization: Bearer <CYRUS_API_KEY>` are reused. Hosted resolves that endpoint
through its existing registered-runtime infrastructure/webhook resolver. No new
hostname, port, customer-runtime URL or model key is required.

| Route | Request / response |
| --- | --- |
| GET `/api/automations/v1/capabilities` | Authenticated readiness, exact configured target/adapter, contract 1 and isolation flags |
| POST `/api/automations/v1/definitions` | `{contractVersion:1,definition}` -> `{contractVersion:1,automationId,revision,state}` |
| POST `/api/automations/v1/occurrences` | `{contractVersion:1,automationId,revision,eventId,input}` -> `{contractVersion:1,occurrenceId,status}` |
| POST `/api/automations/v1/wake` | Exactly `{contractVersion:1}` -> 202 accepted; never accepts customer/scope/model selectors |
| GET `/api/automations/v1/status/:automationId` | Applied definition and persisted occurrence statuses; supervisor-authenticated, not an agent tool |

Registration is a strict object: `id,workspaceId,ownerId,namespace,scopeRef,revision,
state,role,instruction,schedule,target`. Identity fields are immutable after first
registration. `scopeRef` is opaque. It does not grant customer access: Hosted must
match an assigned binding, current desired revision, role, namespace and authorized
event before admission. Definitions contain no grants/provider tokens/MCP configs.
Target is `{harness,model}` and must match the compatible configured runtime.

State is enabled/paused/deleted. Same revision+same body is idempotent; same revision
with different body or lower revision rejects. Pause/delete/edit are new revisions
that invalidate queued/running old work. Delete retains a tombstone and cannot be
resurrected. Enqueue rejects changed payload under an existing event identity.

## Scheduling, recovery and bounds

Initial schedules are null or `{intervalSeconds,anchorAt,timezone}`. Interval is
60..31536000 seconds, anchor is ISO8601 UTC, timezone must be valid IANA. Timezone is
descriptive for this elapsed-time schedule; no calendar/DST cron promise. Manual and
provider events carry durable event IDs. SHA256 occurrence identity binds workspace,
automation, revision, trigger and event ID or interval slot. The original payload is
persisted before claim; a model cannot choose clock/occurrence identities.

Missed intervals coalesce to the latest one, with at most one queued tick. Explicit
instructions keep FIFO order. Paused intervals are not replayed after a revisioned
resume. SQLite transactions serialize duplicate ticks/claims across connections.
Limits: 32 queued per definition, 2 executing per workspace, one executing per namespace
in this initial conservative implementation, 3 attempts, 90s local lease, 5s authority
renewal, 5s then 10s retry delay, 24 model/tool steps. Storage is bounded to 1000 definitions
and 16MB ledger state; capacity rejects new writes, never evicts dedup/tombstones silently.

Every process generates a fresh nonpersisted `instanceId`. SQLite fences protect one
store; they cannot protect copies on other machines. Hosted must enforce its registered
workspace/runtime owner lease on every admission/callback/MCP request. A different live
instance is denied. Expired/explicitly relinquished ownership advances Hosted generation
and invalidates old grants. Registration-key replacement also revokes previous ownership.
The supervisor supplies identity; only Hosted can grant current ownership. This prevents
accidental duplicate instances, not a compromised host administrator with runtime secrets.

An unavailable authority/model/MCP endpoint interrupts execution; no offline effects or
legacy fallback. Expired claims receive new attempt/fence. Resume always reauthorizes.
Checkpoint identity binds definition, namespace/workspace, revision, occurrence and input;
it excludes attempts, renewable leases and MCP credentials. Pending tool/result and its
immutable key persist before send. Uncertain effects reconcile with that key on another
attempt, never a new send identity. Completed-result recovery opens no model/progress/MCP
session. Missing terminal checkpoints fail closed. Bound retry exhaustion stays blocked.

## Supervisor admission and callbacks

Fixed existing `CYRUS_APP_URL`, HTTPS only, no redirects. Each callback uses existing
runtime Bearer plus `X-Cyrus-Team-Id`; neither enters model messages or MCP transport.
There is no Hosted generic `/claim` or HTTP `/tool` endpoint in this final contract.

POST `/api/automations/v1/authorize`:

```text
{contractVersion:1,instanceId,automationId,revision,occurrenceId,attemptId,fence,
 definition:<registration>,
 occurrence:{id,trigger:"instruction"|"tick",scheduledAt,input},
 phase:"admit"|"renew"}
```

Hosted compares against assigned durable work and current configuration; it MUST NOT
mint arbitrary scopes from these fields. Response is exactly:

```text
{authority:{contractVersion:1,definition:<registration plus grants>,occurrenceId,
 attemptId,fence,leaseUntil,phase:"execute"|"reconcile",input},
 mcp:{token,audience:"/mcp",expiresAt,grantId}}
```

Lease/token times are ISO8601 UTC; token cannot outlive lease. Authority identity/input
must match registration/claim. Each resource grant is `{id,connectionId,accountId,
resource,permissions}`. `id` is stable per occurrence and equals `mcp.grantId` and returned `items[].grantId`.
Only the token hash/expiry rotates; a grant identity change during renewal is denied.
Resource is `{provider:"linear",teamId,issueId}` or
`{provider:"slack",channelId,threadTs}`. First slice supports 0/1 bound resource;
multi-resource references are not implemented/advertised. Permissions read/write do
not bypass coordinator role or Hosted approval. Hosted renews only current ownership,
revision, policy/account state. Changing authority requires a new definition revision.

POST `/api/automations/v1/progress` carries `{contractVersion:1,instanceId,
automationId,revision,occurrenceId,attemptId,fence,status:"running"}`.
POST `/api/automations/v1/result` carries the same identity plus `{idempotencyKey,text}`
instead of status. Ack is exactly `{contractVersion:1,acknowledged:true,occurrenceId,
idempotencyKey}`. Hosted stores the immutable receipt and may admit phase reconcile
after result commit/ACK loss; no model reopening or renewed provider rights.

## Real MCP, fixed authority parameters

Only `https://<same configured hosted origin>/mcp`, never `/api/mcp`. Real MCP SDK
Streamable HTTP performs initialize, initialized notification, tools/list, tools/call.
Authorization is the short-lived scoped Bearer on **every** HTTP request; session ID
is protocol state, never authorization. No OAuth/browser login, global MCP config,
provider token, native fallback or model-selected endpoint. Renewal rotates the token
hash/expiry under a stable grantId. Runtime serializes the entire initialize/list/call
operation with supervisor renewal, including the server-side rotation request. Each
transport pins its admitted credential; after rotation the next operation initializes
a new session. No token/session ID is checkpointed. The lease abort deadline remains
active while renewal waits (each MCP request is bounded to 20s); expired/revoked
credentials are never kept valid for a pending call. Server authorization on every
request remains mandatory. Interrupted writes keep the same pending operation key
for reconciliation, with no transparent retry.

Thread-bound catalog: `read_messages({limit?,cursor?})`, `reply({text})`.
Issue-bound catalog: `get_issue({})`, `add_comment({text})`.
Read limit is 1..100, cursor bounded 2000 chars, text 1..10000 chars. All objects strict.
No workspace/customer/account/connection/channel/thread/issue/role/run/grant/action
or resource-ref argument. Search/list, aliases, HTTP/shell and absent tools deny.
Future multiple-resource support needs explicit reviewed session-bound opaque references.

Supervisor attaches `_meta:{idempotencyKey}` to tools/call. Hosted owns approval/action
selection and exact approved payload comparison. Worker writes deny regardless of token
account breadth. Hosted validates current registration owner, run/attempt/grant, audience,
expiry, lease, revision, role, connected account and exact resource before every call,
including existing sessions. Cursor/pagination can only narrow the bound resource.
Completion, pause, revocation, account disconnect or owner takeover denies further tools.

Tool `structuredContent` is `{items:[{grantId,connectionId,accountId,resource,text}],
nextCursor:null|string,receiptId?}`. Runtime validates all returned identities against
the single admitted binding, then exposes only `{items:[{text}],nextCursor}` to the model.
MCP descriptions/server schemas are not allowed to add callable authority. Provider
credential brokerage and existing Linear/Slack signature verification remain Hosted-owned.

## Containment and configured model readiness

First supported target is configured harness `claude` with an explicit `claude-*`
Anthropic model ID and the runtime's existing ANTHROPIC_API_KEY connection. Discovery
explicitly names adapter `anthropic-messages-contained-v1`; this is not a claim of
Claude Code OAuth/Codex login equivalence. OAuth, other harnesses, aliases and missing
keys report unavailable, never silently select a provider/model or accept global
customer-feature keys. No model call occurs merely from registration/discovery.

The model receives scoped messages and strict JSON tool choices only. No native
subprocess, filesystem, shell, network, connector, config/plugin loader, auto-memory,
SDK session or model-provided credential exists in this interpreter. Supervisor model
transport is fixed Anthropic Messages; MCP transport is fixed Hosted /mcp. Private
checkpoint/ledger data are not mounted into any agent. This boundary protects against
malicious model output, not the administrator controlling the runtime host.

Engineering advertises false in this first generic slice. Historical offline Docker
execution and receipt handling are retained for subsequent same-lifecycle delegation;
there is no fallback from generic automation to standalone or native engineering.

## Verification and remaining gate

Run `pnpm --filter cyrus-edge-worker exec vitest run test/automations.test.ts test/automation-mcp.test.ts`, build
the edge-worker, then `node apps/f1/automation-drive.mjs`. F1 uses production runtime,
durable SQLite, model adapter and actual MCP SDK HTTP sessions with controlled authority,
provider/model transports and denied external network. It covers instruction+real tick,
non-customer work, persisted results, lost-ACK restart without reopening work, strict
arguments, open-session expiry/revocation, reconnect, copied-instance denial and secrets
absent from checkpoints. This is not the joint Hosted implementation acceptance.
Independent actual Hosted admission/SQL/MCP, connected-account denial, visible customer
result and current-head UI verification remain required. No production enablement,
live provider/model effects, publication or merge are authorized by these tests.
