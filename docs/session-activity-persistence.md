# Cyrus session/activity persistence dependency

This extends CYPACK-1546 / PR1507 and CYHOST-1321 / PR1102. It does not replace
the [automation contract](runtime-automations-v1.md), its single SQLite scheduler,
current-authority checks, contained MCP connections or terminal receipt recovery.
The transport below is a proposal awaiting the hosted owner's acknowledgement;
there is no enabled hosted activity transport in this runtime milestone.

## Identity and delegation

Both direct and ticket-backed delegation are supported acceptance requirements.
They share `CyrusAgentSession`, `AgentSessionManager` and `AgentActivityContent`.
A direct child has its own Cyrus ID and `parentSessionId`; no Linear issue,
Linear session or Linear credentials are required. A ticket-backed child also
has optional `issueContext` and `externalSessionId` associations. Ticket assignment
remains useful for ownership, review and tracking. Existing production associations
are not removed, migrated or detached by this change.

Harness-native resume identity remains separate (`codexSessionId`,
`claudeSessionId`, `geminiSessionId`, `cursorSessionId`, `opencodeSessionId`). A
native thread ID is neither the Cyrus session ID nor a credential. Resume must
validate the original execution scope and current authority before loading native
state; presenting a persisted ID never authorizes resumption.

`ICyrusSessionSink` extends the activity-posting portion of `IActivitySink` and
adds `createCyrusSession(descriptor)`. It does not require the legacy
`createAgentSession(issueId)` method. Existing `LinearActivitySink` and its
interface remain compatible. The descriptor contains a supervisor-admitted
`scopeRef`, role, Cyrus ID, optional parent and optional external associations.
The sink must independently authorize these against its bound scope, including
the parent's visibility and child-role permissions. Parameters never mint scope.

`AgentSessionManager.createOwnedSession` awaits that admission before tracking a
runner. Its explicit `activitySinkBinding` survives serialization and selects the
Cyrus destination instead of an optional Linear association. Rebinding to another
sink ID is rejected. This internal API does not expose a launch/delegation route,
grant native tools, or by itself implement hosted authorization or durability.

## Inspected baseline and normalization coverage

| Harness | Normalized events already present | Persistence limitations |
| --- | --- | --- |
| Claude | SDK messages, tool use/result, final result/error through AgentSessionManager | Optional `HttpSessionStore` mirrors SDK-native entries to hosted `claude_session_entries`; this is not the normalized session/activity timeline. |
| Codex | SDK/app-server backends normalize thread, item start/completion, turn completion/failure; `CodexEventMapper` emits tool use/result and terminal messages | Native thread identity and local Cyrus state exist; no equivalent hosted normalized replay adapter is wired. Reasoning items are not used to fabricate timeline content. |
| Gemini | `geminiEventToSDKMessage` maps tool use/result and success/error; runner accumulates text deltas before normalized delivery | Existing formatter/adapter tests are not hosted persistence or live-session evidence. |
| Cursor | SDK tool_call plus assistant/user blocks map tool use/result; status and exposed thinking have existing handlers; runner produces terminal outcomes | Coverage concerns emitted SDK content only, not inaccessible reasoning. No hosted ordered acknowledgement/replay wired. |
| OpenCode | step_start, tool_use, text, step_finish map init, tool lifecycle and result; runtime failure path emits error outcome | Existing replay/manager tests cover mappings, not a real hosted resumed session. |

Baseline `AgentSessionManager` serializes message handling in memory. Both
normalized-entry delivery and convenience activity posting previously skipped
any session without `externalSessionId`, even with a sink. They catch and log
delivery errors. Buffered final assistant text, activity acknowledgement and
parent-return delivery are not one durable transaction. `LinearActivitySink`
also returns an empty result for unsuccessful activity creation. These are
persistence gaps; do not mistake the presence of a normalizer for reliable
delivery or treat a logged failure as an acknowledgement.

## Proposed shared delivery contract and ownership

CYPACK owns normalized emission, a private scope-bound durable outbox, ordered
replay, lifecycle emission and reconnect. CYHOST owns session/activity rows,
authorization, idempotent ingestion, retention/redaction policy and timeline UI.
The existing linked issues are the shared dependency; no second customer-only
transcript ontology or scheduling ledger is needed.

Before wiring HTTP, agree an additive sink capability/version and exact path.
Proposed supervisor transport is POST `/api/agent-sessions/v1/deliver` on the
existing registered connection. Supervisor credentials remain outside model,
MCP context and checkpoints. Each request carries current attempt/fence authority
plus a stable session-bound delivery item; refreshed attempt credentials must
not change the item's identity or payload. This route is a proposal, not a claim
that it exists or is authorized merely by runtime registration.

Proposed delivery item: `{sessionId, sequence, kind, payload}`; sequence starts at
1, is allocated durably by the runtime, and is immutable across retries. Kinds
are session creation, activity (existing `AgentActivityContent` and
`ActivityPostOptions`), and lifecycle update (existing `AgentSessionStatus`,
optional harness/native identity). Parent creation precedes child creation.
Hosted must reject a sequence gap and a reused sequence with changed payload;
an exact duplicate returns the same durable acknowledgement. Runtime deletes
pending items only after matching acknowledgement. This queue is transport
state, not an alternative work scheduler.

Current authority is checked on every ingest/reconnect. A bounded, explicitly
authorized terminal-receipt path can reconcile already-committed records after
execution stops; it cannot append new tool work or resume a revoked harness.
Workspace/customer namespace and parent access are resolved from admission,
not arbitrary payload IDs. Read/list/UI access applies the same tenancy rules.
Persist only approved normalized display fields: no raw config, environment,
provider tokens, MCP authentication headers or opaque full SDK objects. Apply
redaction before local durable storage and revalidate at hosted ingestion.

Ephemeral activities retain existing semantics: ordered delivery with dedup,
but only the latest ephemeral display state is shown; it is replaced by a later
activity and is not promoted into permanent narrative history. Signals keep
the existing auth/select/stop/continue vocabulary. A lifecycle update must not
pretend to be an assistant thought. Parent results/findings/PR references use
the same activity/session relationship and require durable idempotent handoff.

## Acceptance still required

- Direct parent plus investigator/engineering children: no Linear creation or
  credential dependency, bounded child scope, separate native identity, durable
  activities/result and current-authority resume.
- Assigned-ticket delegation: preserved issue/parent linkage, same containment,
  returned findings/PR, existing Linear activity regressions.
- Lost activity ACK, reconnect/restart, duplicate/out-of-order delivery, revoked
  authority, cross-customer/workspace reads, rejected parent links, redaction,
  ephemeral replacement and terminal/error ordering.
- Real Codex tool activities and final response persisted by CYHOST and visible
  after UI reload/runtime reconnect. Normalizer replay cannot satisfy this gate.
  Other supported harnesses need their corresponding coverage; current scoped
  automation model readiness remains limited as documented, with no fallback.
- Instruction/tick and admitted Slack/Linear event acceptance remain required.
  No release, production enablement or unrelated live provider effects follow
  from the addition of these shared interfaces.
