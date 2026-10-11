# Relay — Native Agent Delivery PRD

**Release intent:** Make pending Relay messages reach the correct running agent through a real native delivery path, including unattended activation of an idle session where required by the rollout.

**Status:** Requirements written; implementation and native-runtime qualification pending. This is a proposed Relay/v2 increment, not evidence that wake support already exists.

**Scope:** Opt-in host-local delivery of Relay pending-state hints to exact native sessions, using the existing authoritative stores, session fencing, authenticated client, and bounded Pool/prime launch path.

**Owner:** PugzUI. Presentation copy and deployment changes remain owner-controlled.

## 1. Problem and required outcome

A semantic hook declaration can describe a wake command without executing it. A native startup callback can register a session without returning notification text to model context. Executing a prompt callback can inject context without starting a new turn in an already idle session. These are different behaviors and must not share one unsupported “wake supported” claim.

The required path is durable Relay state, one supervised delivery consumer, and a supported native runtime consumer. Event notifications are hints about committed state; they are neither a second mailbox nor evidence of execution.

For a client declared capable of unattended idle activation, a synthetic message addressed to an idle native session must cause that same session to start a turn and observe current pending state without human input. For a busy session, delivery must use a supported safe boundary and must not interrupt its running tool. Unsupported, refused, and uncertain outcomes must remain visible and must not consume work.

### Success criteria

- Registration/teardown and message notification have explicit, independently exercised ownership.
- Every enabled delivery adapter has an exact-runtime capability/evidence record.
- Pending addressed messages survive notifier, broker, and receiver interruption.
- Notifications do not claim, acknowledge, release, or complete a message/job.
- Existing worker/session/epoch, permission, lease, capacity, and launch protections remain authoritative.
- A release cannot claim unattended delivery from an instruction list, emitted stdout, signal file, HTTP success, or synthetic child alone.

## 2. Current baseline and authority

The current Relay product has explicit `{msg}` / `{work}` admission, one SQLite engine per authority, authenticated remote access, current worker sessions/epochs, at-least-once leased execution, an internal Pool, a bounded prime launch ledger, and a read-only topology view. Its public exports do not currently include a native-agent notification adapter or delivery supervisor.

The existing `src/feed.mjs` tails committed audit state. It is a bounded metadata feed whose cursor is tied to authority, permission scope, and a broker/feed instance. It is not a durable agent inbox, and restarting the feed invalidates its stream cursor. A new delivery consumer must not assume that replaying this feed alone discovers all pending addressed messages.

Existing `get`/`list` hide bodies unless separately authorized. Reads do not expire claims or otherwise mutate queue state. Inspection permission is not interchangeable with ownership of a worker session. A recipient-scoped non-consuming read must therefore be specified and authorized explicitly rather than granting a notifier broad inspection merely to find its own messages.

### Existing owning files

- `AGENTS.md`: project scope, delivery authority, private/public boundaries.
- `docs/spec.md`, `docs/contract.md`: product and frozen interfaces/invariants.
- `docs/acceptance.md`, `docs/verification.md`: qualification cases and evidence boundaries.
- `src/relay.mjs`, `src/sqlite.mjs`, `src/schema.sql`: queue/session/lease transactions and persistence.
- `src/auth.mjs`, `src/broker.mjs`, `src/client.mjs`: permissions, fixed-destination transport, and RPC recovery.
- `src/feed.mjs`: committed metadata observation and reset behavior.
- `src/pool.mjs`: assignment, capacity reservation, readiness, and owned local launch.
- `src/config.mjs`, `src/validate.mjs`, `src/cli.mjs`, `src/index.d.ts`: configuration, bounds, CLI, and declarations.

This PRD extends the current contract; it does not silently override its v1 exports or allowed wire operations. Freeze any additive API, schema, configuration, and permission changes in the implementation contract before coding them. Existing behavior remains unchanged when delivery is disabled. No legacy host hook machinery is imported as a runtime dependency.

## 3. Scope and exclusions

### In scope

- Exact native-session binding acquired from real startup/lifecycle events.
- An opt-in host-local supervisor that multiplexes permitted local and configured-hub state.
- Non-consuming, payload-free recipient pending-state reads.
- Native startup/prompt/safe-boundary context injection where supported.
- Native activation of an existing idle session where required and supported.
- Bounded reconciliation, coalescing, backoff, restart recovery, and diagnostic outcomes.
- Invocation of the existing Pool/prime path for absent workers only when explicitly configured and authorized.
- A capability matrix and real native-runtime release evidence.

### Out of scope

- A replicated queue, second SQLite database, federation, peer mesh, DAG scheduler, or task decomposition.
- Arbitrary remote execution, a new remote launch operation, callback URL supplied by message content, or a generic plugin system.
- Keyboard/mouse automation, terminal paste/send-keys masquerading as a session API, scraping a UI, or directly editing runtime session databases.
- Runtime installation, credential discovery, automatic host-service installation, firewall/proxy policy changes, or production session takeover.
- Launching a new process as proof that an existing idle session was awakened.
- Interrupting active tools or bypassing native refusal/approval controls.
- Inferring `msg` versus `work` from text, task acknowledgements inferred from notices, or exactly-once external execution claims.
- New dashboard, message composer, wake button, launch controls, or marketing assets.

### Rollout support set

The implementation must inventory every enabled managed client intended to receive Relay notifications, rather than repairing only the reported OpenCode callback. Hermes and OpenCode are priority discovery targets, not already-qualified integrations. Other enabled clients must appear in the same inventory; no automatic-wake capability is presumed for any of them.

Record the required behavior for each client before implementation. For PugzUI’s unattended rollout, idle activation is required for every client assigned unattended receiving work. An unsupported native API is a genuine rollout blocker for that client, not permission to mark it covered or silently remove it. Only an explicit owner scope change may narrow the required support set. The standalone Relay core can remain usable without notification adapters, but that is not completion of this delivery increment.

## 4. Vocabulary and evidence levels

| Term | Meaning |
|---|---|
| Accepted | Relay admission committed to its authoritative store. |
| Hint | Payload-free indication that scoped current state may need rereading. |
| Context injection | The native consumer places a notice into model-visible context at a supported boundary. |
| Idle activation | A supported native input/session operation starts a new turn in the already-bound idle session. |
| Claimed | Relay granted one exact finite lease attempt. |
| Acknowledged | Relay accepted `ack` for the current owning session/epoch and exact live attempt. |
| Completed | The application’s recorded outcome; it is not established by emitting a notification. |
| Uncertain | The native/RPC request may have been accepted but the result cannot yet be proved. |
| Binding | Exact authority, worker, Relay session/epoch, native runtime instance/session, and local binding generation. |
| Native target | Exact runtime instance/profile and native session, with its native lifecycle generation; it may have separately authorized local and hub bindings. |

Capabilities are independent: `context`, `idle`, and `launch`. A context-only adapter is not an idle-wake adapter. Launch capability means permission to request the existing local launch path, not a replacement implementation of process ownership.

Use the following evidence labels independently of capability flags:

- **Declared:** documented intent or configuration only.
- **Wired:** a concrete callback/input path and consumer have been traced in source.
- **Qualified:** the required behavior was observed on the recorded runtime version and surface.
- **Unsupported / unqualified:** honest limitations, with a precise reason.

A runtime’s own internal messaging feature or webhook documentation does not establish that an external Relay adapter can inject input into this exact existing session. Qualify that connection itself.

## 5. Functional requirements

### R1 — Exact lifecycle binding

Adopt the current native session identity from a real native startup event. Bind it to the intended Relay authority and worker session/epoch. Never infer identity from a working directory, runtime name alone, hostname, display label, or a remembered prior session.

Joining/resuming/renewing uses the existing session rules. A delivery consumer does not replace a live worker session, impersonate a prime/orchestrator, or heartbeat another agent. Session heartbeat ownership remains explicit in the existing session-owning path; notifications do not keep ended native sessions alive.

A new binding generation invalidates old queued hints and native-call completions. Teardown detaches only that exact binding. A delayed teardown or completion from an earlier generation must not affect its replacement. A recovered binding must revalidate native session existence and current Relay authority/session/epoch before use.

Local and hub bindings for the same native target share its native lifecycle generation, while their Relay sessions/epochs remain authority-specific. The native consumer binds that target to one owning host-local supervisor root and refuses a second root's competing ownership; other authorities are multiplexed through the established owner, not another supervisor.

### R2 — Recipient-scoped, non-consuming read

Add one CORE-owned recipient summary operation, provisionally named `pending(sid)`, with matching synchronous local and asynchronous Client behavior. This name is proposed, not an existing exported method. Use the existing `/v1/call` protocol if remote access is needed; add no second wire protocol.

Freeze an exact strict shape before implementation. Its minimum result is authority, exact worker/epoch, a scoped state revision, and separate counts for addressed `msg` and `work`. It must also distinguish stored pending entries from expired claimed attempts that can become claimable through the existing mutation path. It must not relabel or expire those claims during a read.

Requirements for the read:

- Validate current live session/epoch and the current authenticated principal’s exact worker rights.
- No broad topology/inspection grant or message-body grant is required merely to observe this worker’s payload-free pending summary.
- Apply permission and exact-recipient filtering before counts; no board Inbox or other worker’s data is included.
- Read summary fields and revision from one consistent database snapshot.
- Return no body, bearer token, native-session handle, filesystem path, or execution authority.
- The revision must distinguish a new admission, release/requeue, and newly recoverable expiry; an admission sequence alone is insufficient for retries of the same message.
- Preserve existing ordering, lease expiry, capability, and authority rules. A positive count is a discovery hint, never a lease or promise that a later claim will succeed.
- Do not initialize, renew, claim, purge, acknowledge, or write from the read path.

Reuse the same internal filtering/eligibility logic as existing owned operations; do not build a shadow query/permission implementation in each adapter.

### R3 — One supervised consumer

Run one explicit supervisor per host-local Relay root, multiplexing only its configured bindings/authorities. A second consumer for that root must refuse ownership or attach to the established owner; it must not create competing pollers. Ownership uses the existing store/lifecycle conventions and CORE-owned fencing, not PID alone.

Startup performs a scoped current-state reconciliation. Events then invalidate affected bindings so the consumer rereads current state. Periodic reconciliation remains required even when streaming is available. No event, heartbeat, retry, refusal, or historical receipt is itself a current pending-state assertion.

Use existing committed audit/feed semantics as optional latency hints. Do not assume a topology event grant supplies recipient/body permission. If the metadata feed is unavailable or not permitted, continue the scoped polling path within its bounds. A broker/feed reset, scope change, dropped event, stream saturation, or overflow triggers fresh current-state reads and resubscription where permitted.

The supervisor must not be spawned by module import, a read-only operation, or every prompt. Prompt callbacks use the same recipient-read/notice formatter and existing native consumer; they do not install another worker loop.

### R4 — Runtime state decision

| Observed state | Required action |
|---|---|
| Busy | Queue/coalesce a hint for a documented safe boundary. Do not interrupt a tool, overwrite an active prompt, or inject via arbitrary terminal input. |
| Idle, supported native activation | Submit bounded input to the exact existing native session; record admission separately from observed turn/context delivery. No human message is needed. |
| Idle, context-only adapter | Retain pending state and report that idle activation is unsupported. A future user prompt may consume context, but this does not pass an unattended gate. |
| Absent | Leave messages durable. Request existing Pool/prime capacity only with explicit local launch configuration, authority, and available budget. |
| Unknown / stale binding | Revalidate; do not assume idle or launch another process. |
| Held / refused by native runtime | Honor the hold/refusal and surface it. Do not bypass it through another input path. |
| Native call outcome uncertain | Reconcile native status/idempotency before retrying activation. Do not blindly start another turn. |

Do not let a notification keep a session permanently busy or prevent it from becoming idle. Native callbacks should return promptly and schedule bounded work rather than wait indefinitely for a model response.

### R5 — Coalescing and recovery

Coalesce hints by exact binding and current scoped state revision, not message text. Serialize native submissions through one dispatch gate per native target, shared by all its authorized local/hub bindings and activation paths. Combine their scoped hints into one bounded notice when possible; retain excess hints for a later safe boundary rather than dropping them. A burst of events for the same still-pending state must not produce a turn per event. Newly admitted/requeued/recoverable work must still be discoverable even when its message ID is unchanged.

Native acceptance does not itself reopen the target's dispatch gate. Accepted-but-unobserved or uncertain input keeps its slot until supported native status/observations establish a safe next submission. An idle observation taken before the preceding submission is not sufficient; reread current binding/runtime state before another activation.

Persist only minimal delivery coordination/diagnostic metadata in the existing local Relay SQLite engine. Any schema addition is an explicit backed-up migration; it is not a second inbox. Metadata may include binding generation, current-state revision, attempt identity, timestamps, retry boundary, and confirmed/uncertain outcome. Never store work/message bodies as notification records or replicate a hub queue locally.

Persist an activation attempt and acquire the target's dispatch slot before calling the native consumer. Fence submission as well as completion against consumer ownership and binding generation. WP1 must specify the held dispatch-ownership or native fencing mechanism; an ownership check followed by an unguarded external call is insufficient. Supervisor takeover carries unresolved target slots forward: expiry of the old supervisor's ownership alone does not prove its native input was cancelled. A crash after native acceptance but before confirmation produces an uncertain record, not fabricated success. If the native API supports idempotency/status inspection, reuse the original activation identity. Otherwise retain uncertainty visibly until a native observation or explicit operator reconciliation establishes the outcome; do not claim exactly-once turn creation.

A feed checkpoint means only that invalidation was observed. It is never used to skip a fresh pending-state reconciliation after restart. Confirmed notice delivery is not a task acknowledgement, and must not make unclaimed work disappear from diagnostics.

Reconcile ordinary pending state on safe boundaries and after a completed receiver turn. Unchanged already-notified state must not create an endless reminder loop. A stuck unclaimed state remains visibly pending; any timed reminders require an explicit bounded policy rather than escalating automatically into repeated model turns.

### R6 — Claim and launch boundaries

The receiver claims through existing Relay/Client methods after obtaining current state. It must still prove current session/epoch, exact lease attempt, permission, and capacity at execution/settlement. A notice, stale claim receipt, or historical activation record grants no current authority.

Board `{msg}` entries remain append-only `posted` Inbox history and are not addressed agent deliveries. Board `{work}` hints may invalidate the existing Pool/prime demand path; the notifier must not broadcast board bodies, select winners, assign jobs, or invent a second scheduler. Pool eligibility, capability/series ordering, capacity reservations, and remote uncertainty remain authoritative.

Absent-worker activation reuses `createPool`, `ensureCapacity`, and the existing CORE launch ledger. Keep the fixed local executable recipe, `shell:false`, readiness nonce/session proof, verified native process ownership, bounded child budget, and recovery of unknown launches. Work payloads never become shell commands, executable paths, or process arguments. Remote messages never grant launch permission.

### R7 — Honest observability

Expose read-only operational diagnostics through the one CLI and documented local inspection path. Separate accepted work, pending/recoverable counts, native admission, context observed, turn observed, claim, and acknowledgement. Include the configured/qualified capability, current runtime state, last attempted/confirmed observation time, next retry boundary, and a bounded reason for unsupported/refused/uncertain outcomes.

Use `null`/unknown where an observation is absent. Do not fabricate ready/idle state, free capacity, completion, or wake latency. Diagnostic reasons use validated reason codes, not raw native responses that might contain secrets or control characters. Native session handles and Relay session IDs stay in protected local binding state and are excluded from public topology, logs, screenshots, and release artifacts.

The topology page remains read-only, native browser modules/SVG/CSS, and `Inbox | Bounties`. This increment does not require a new visual dashboard. Existing public report/feed schemas are not extended ad hoc with native session identifiers or invented delivery pulses.

## 6. Security, limits, and shutdown

Delivery is disabled by default. An enabled supervisor uses explicitly selected local roots, exact bindings, fixed authenticated hub/native destinations, and strictly validated operator configuration. A message can never change its destination, adapter, permissions, or executable recipe.

Native credentials, if needed, are separate from Relay credentials. Never forward a Relay bearer token to a runtime. No secret in argv, URL, log, notice, or diagnostic output; no redirected credentials, TLS downgrade, or arbitrary callback endpoint. Recheck scope/current binding immediately before a native submission. Credential revocation stops future reads/submissions and cannot undo a turn already accepted by the native host.

### Proposed additive bounds to freeze in `src/validate.mjs`

These are design limits, not measured performance claims. Existing lower broker/Pool/launch limits always win.

| Resource | Proposed default / hard cap |
|---|---|
| Delivery enabled | False |
| Active bindings | 64 / 512 |
| Scheduled hints | One coalesced slot per active binding; no per-event backlog |
| Reconciliation interval | 1,000 ms default; accepted range 250–30,000 ms |
| Native calls in flight | Four total; one per native target across all its bindings; existing network caps also apply |
| Native submission deadline | 10,000 ms over submission and recovery retries combined |
| Retry backoff | 250 ms minimum through 10,000 ms maximum, with jitter |
| Notice body | At most 2,048 UTF-8 bytes, payload-free |
| Automatic retry | At most three within one deadline, and only when safe/idempotent |
| Delivery coordination/history | At most 10,000 rows total; terminal history at most seven days; unresolved records remain protected and count toward admission capacity |
| Public diagnostic page | Existing default 50 / maximum 200 |

Admission must refuse a new binding/attempt when bounded coordination capacity cannot be obtained; do not delete unresolved attempts to make room. Already admitted Relay messages remain durable regardless of notification saturation. Counts refer to configured bindings and state, not physical hardware availability.

On shutdown, cancel polls, feeds, and in-flight native submissions; close owned handles and stop accepting new attempts. A submitted call whose cancellation cannot be proved remains uncertain. Do not acknowledge/release jobs merely because the notifier stopped, terminate an existing agent session, or signal a process not owned through the existing launch path. Consumer ownership loss fences further native submissions and causes the old instance to stop.

No host service installation or production-native-session mutation is authorized by writing this PRD. Native qualification must use isolated synthetic sessions; any billable model invocation or installed-host configuration change needs its applicable authorization.

## 7. Dependency-ordered work packages

New paths below are proposed destinations, not files claimed to exist today. The primary checkout owns integration and shared contracts. If workers are used, assign non-overlapping lane ownership after contract freeze.

### WP1 — Inventory and qualification contract

**Owner:** Integration/runtime adapter owner.

**Files:** Create `docs/delivery.md`; update `docs/spec.md`, `docs/contract.md`, `docs/acceptance.md`, `docs/verification.md` and the factual capability/evidence section of `README.md` during implementation.

Inventory every enabled receiving client, exact runtime version/surface, its actual startup/context/input APIs, consumed callback return envelope, busy/idle behavior, refusal controls, and native idempotency/status facilities. Record required `context`/`idle`/`launch` capabilities independently. Read current official docs and source before selecting an API; source wiring is not qualification.

Freeze the recipient-summary shape, revision/expiry semantics, native binding/attempt records, ownership fencing, strict configuration, additive CLI/API/RPC permissions, migration/rollback behavior, and numerical bounds. Reconcile all existing exclusions and declarations. Preserve owner-controlled presentation; add no new marketing copy or unsupplied artwork.

**Dependency:** None. Missing native APIs are recorded blockers for required clients.

**Acceptance:** Every enabled client has a requirement row and concrete supported consumer or explicit limitation; all additive contract decisions agree across documents.

### WP2 — Authoritative recipient read and coordination

**Owner:** CORE.

**Files:** Modify `src/relay.mjs`, `src/sqlite.mjs`, `src/schema.sql`, `src/validate.mjs`, `src/index.d.ts`, `src/index.mjs`; integrate permissions/dispatch in `src/auth.mjs`, `src/broker.mjs`, `src/client.mjs`.

Implement the frozen recipient read using existing transactional/authorization paths. Add only CORE-owned coordination/ownership metadata to the same store. Keep the business mutation and RPC journal atomic; recipient reads remain genuinely read-only. Apply explicit schema migration and safe refusal on unknown/corrupt versions rather than resetting data.

**Dependency:** WP1.

**Acceptance:** Exact-recipient reads neither consume nor disclose unrelated state; expiry/requeue revisions and stale binding/epoch refusals work; a crash/replay cannot create false current authority.

### WP3 — Supervised delivery loop

**Owner:** Delivery integration.

**Files:** Create `src/delivery.mjs`; modify `src/config.mjs`, `src/cli.mjs`, `src/validate.mjs`, `src/index.d.ts`; integrate existing `src/feed.mjs`/`src/pool.mjs` seams only where required by the frozen contract.

Implement explicit start/stop, one-root ownership, multiplexed scoped reconciliation, current-state rereads, bounded hints, retry/uncertainty handling, diagnostics, and cancellation. Reuse existing feed, authenticated Client, Pool, and launch ledger; no duplicate launch/lease engine or per-prompt poller.

**Dependency:** WP2.

**Acceptance:** Missing/reset events and restarts cannot strand pending state; concurrent supervisors are fenced; overload and shutdown stay bounded and leave authoritative work intact.

### WP4 — Native consumer adapters

**Owner:** Runtime integration.

**Files:** Proposed `src/adapters/hermes.mjs`, `src/adapters/opencode.mjs`; other first-party adapter paths must be listed during WP1 only for enabled clients. Amend existing native lifecycle bridges at their discovered owner, not through a copied host catalogue or a parallel configuration system.

Implement thin adapters against the frozen delivery contract and current supported native APIs. Registration belongs to real lifecycle handlers. Notifications must reach their model-visible consumer. Remove an orphan semantic wake declaration only in its owning integration and only after its replacement responsibility is covered; adding another declarative row is not implementation.

**Dependency:** WP1 and WP3. Host-side changes are a separate authorized rollout from portable Relay package work.

**Acceptance:** Each required client passes its native busy/idle/absent/unknown matrix. A context-only or unsupported client is reported accurately and cannot satisfy a required idle gate.

### WP5 — Isolated qualification and release evidence

**Owner:** Integration/verification.

**Files:** Extend `tests/auth.test.mjs`, `tests/core.test.mjs`, `tests/feed.test.mjs`, `tests/pool.test.mjs`, `tests/integration.test.mjs`, `tests/cli.test.mjs`; create `tests/delivery.test.mjs` and `tests/delivery-adapters.test.mjs`. Planned evidence: `docs/media/delivery-qualification.json` and redacted native captures referenced by `docs/verification.md`.

Exercise the acceptance matrix below, first with isolated synthetic state and then with actual target runtimes. Record exact runtime/surface, adapter version, platform, capabilities, observed transitions, timings, refusals, and privacy review. Stub adapters and harmless child fixtures prove mechanics only, never native wake.

Existing project check entrypoints are `npm run check` and `npm run test`; run them under implementation authorization, not as proof that writing this document completed the feature. Native observations remain a separate gate. Retain existing snapshot-recovery coverage.

**Dependency:** WP2–WP4.

**Acceptance:** Required observations exist and are redacted; public claims match the per-runtime evidence; all release gates are satisfied or the exact rollout blocker remains open.

## 8. Acceptance matrix

Every case starts **pending**. Proposed observations below are not recorded results.

| ID | Case | Required observation |
|---|---|---|
| D01 | Disabled/default | Ordinary account-free local Relay use starts no notifier, listener, native input, or process. |
| D02 | Real startup/context callback | A native lifecycle callback binds the exact synthetic session; the returned notice is actually visible to its model, not just stdout/a registration record. |
| D03 | Unattended idle activation | After the target session becomes idle, addressed synthetic mail starts a turn in that same session without user input; current state is observed within reconciliation plus native submission bounds, excluding provider/model-generation time. |
| D04 | Busy delivery | A controlled native tool remains uninterrupted; pending mail is visible at the documented next safe boundary, including work arriving while the receiver is busy. |
| D05 | Context-only/unsupported | The adapter reports the exact missing capability, leaves work pending, and does not claim idle wake or substitute a new session. |
| D06 | Recipient isolation | Another worker, native session, authority, or profile receives no hint/body/count from the target; same runtime name is insufficient to match. |
| D07 | Current-session fencing | Expired/replaced/ended sessions and delayed native replies cannot notify or complete against a new binding/epoch. |
| D08 | Non-consuming summary | Repeated reads/notices leave queue, session lifetime, leases, outcomes, and RPC state unchanged; bodies are absent. |
| D09 | Lease boundary | A receiver cannot execute from notice/old receipt alone; exact current claim and settlement permissions/attempt are required. |
| D10 | Inbox/work distinction | Board `{msg}` remains posted history; addressed `msg` uses normal claim rules; board work demand goes only through existing Pool eligibility/capacity. |
| D11 | Burst/duplicate hints | Duplicate events/callbacks and concurrent local/hub hints for the same native target coalesce through one dispatch gate; native acceptance alone cannot admit a second activation. New or deferred pending state is still discovered without a wake storm, duplicate lease, or false acknowledgement. |
| D12 | Release/expiry rediscovery | The same message becomes eligible again after release/expiry; admission-ID/sequence dedupe does not permanently suppress it. Reads do not perform expiry mutation. |
| D13 | Startup catch-up | Work admitted before the supervisor starts, including during downtime, is found by current-state reconciliation without needing retained feed events. |
| D14 | Feed reset/missed events | Broker restart, overflow, scope reset, stream saturation, and a deliberately omitted event recover through fresh scoped reads; no queue copying. |
| D15 | Crash before submission | A persisted unsent attempt is safely reconciled/retried; work remains pending and no false delivered status appears. |
| D16 | Crash after native acceptance | Recovery resolves or visibly retains uncertainty; it does not blindly start another turn or pretend exactly-once native activation. |
| D17 | Concurrent supervisors | Competing processes for one root, or two roots targeting the same native session, cannot submit as independent owners. Pause the old owner at dispatch and exercise takeover: submission/completion are fenced and unresolved native calls keep the target slot until reconciled. |
| D18 | Native hold/refusal | Refusal/approval state is honored, observable, and not bypassed by terminal input, alternate API, or process launch. |
| D19 | Absent/launch disabled | Work remains durable and the absence is reported; no implicit launch. |
| D20 | Authorized bounded launch | Enabled local launch uses the existing recipe/budget/readiness ledger; ambiguous child ownership stays blocked and remote payloads cannot choose an executable. |
| D21 | Credential/scope changes | Revocation and unsafe registry replacement deny future reads/submissions; no credential redirects or cross-principal native binding. |
| D22 | Capacity/deadline/storage failure | Saturated bindings, calls, logs, SQLite contention, failed migration, corruption/disk error, and deadline exhaustion refuse/report safely without deleting pending work or unresolved attempts. |
| D23 | Shutdown/cancellation | All owned timers/feeds/handles stop; accepted-but-unconfirmed native input remains uncertain; existing sessions/unowned processes are untouched. |
| D24 | Retention/privacy/output | Cleanup preserves unresolved coordination and pending work; bounded logs/notices/captures contain no payload, token, session handle, private path, or terminal-control injection. |
| D25 | Native support matrix | Every enabled client has real version/surface evidence for required capabilities; synthetic adapter success cannot be promoted to native qualification. |
| D26 | Clean-checkout documentation | Actual release commands and recorded synthetic example reproduce documented behavior; no planned command is presented as implemented, no unsupported platform/network claim is added. |

For D03/D04/D25, retain both the native session/turn observation and Relay’s recorded admission/claim/ack observations privately during verification, then publish only redacted evidence. Do not use sender-side acceptance or delivery-consumer logs alone as proof of receiver behavior. Any provider outage or unavailable native API is recorded as a limitation, not replaced with plausible output.

## 9. Risks and decisions

- **No supported idle API:** Requires an explicit capability gap and an owner decision for that client; prompt injection cannot satisfy unattended receiving.
- **Ambiguous native acceptance:** Exactly-once turn creation is not assumed. Use supported idempotency/status recovery, otherwise expose unresolved uncertainty and require reconciliation.
- **Runtime/version drift:** Pin qualified versions/surfaces in evidence. A materially changed input/callback contract invalidates qualification until rechecked.
- **Session expiry versus native presence:** A running/idle UI does not establish a live Relay session. Heartbeat, resume, and replacement stay in the native session-owning path.
- **Global feed limits/privacy:** Streaming is optional acceleration; exact recipient reads and bounded polling are the reliable fallback. Do not broaden grants to obtain lower latency.
- **Schema/config compatibility:** Explicit migration, backup, strict config versioning, and rollout rollback are frozen in WP1. Rollback disables notification and leaves authoritative queue state intact; do not downgrade an incompatible store silently.
- **Activation cost:** Unchanged pending state must not repeatedly start model turns. Keep reminders opt-in and bounded; synthetic native qualification may incur provider cost and needs applicable authorization.
- **Scope creep:** Thin first-party adapters and existing Pool/Client seams only. No runtime installer, generic orchestration framework, UI automation, or new task state engine.

The rollout client inventory and exact native APIs remain discovery gates. They must be resolved before the corresponding adapter is marked implemented. This document deliberately makes no fabricated API availability or native support claim.

## 10. Release gates and evidence handoff

- [ ] Freeze the complete additive contract and required per-client support set; reconcile product exclusions, declarations, permissions, CLI, configuration, and migration.
- [ ] Complete one authoritative recipient summary and delivery coordination path with preserved atomicity/fencing.
- [ ] Complete one bounded supervised consumer, actual native consumers, and removal of displaced/orphan integration paths.
- [ ] Pass required D01–D26 observations and project checks under their applicable authorization.
- [ ] Qualify real unattended idle delivery and busy safe-boundary delivery for every client that requires them; unsupported required clients remain blockers.
- [ ] Verify restart, ambiguous acceptance, duplicates, expiry/requeue, revocation, shutdown, capacity, and retention/privacy with real recorded evidence.
- [ ] Keep any platform-specific or physical LAN/Tailscale qualification explicitly separate and pending where unobserved.
- [ ] Publish only redacted capability/evidence documentation and an actually reproducible example; preserve owner-controlled presentation and obtain required approval for changed public presentation.
- [ ] Confirm the package contains no legacy host dependency, private state, credentials, or unreviewed native capture.

Completion of this PRD is document completion only. Relay/v2 native delivery is complete only when these implementation and qualification gates pass. Removing `ai-intercom.wake`, registering a session, or writing a notification artifact cannot close the feature.

## 11. Research basis and evidence boundary

The preceding comparison inspected documentation/upstream source, not runtime behavior. These are design references, not qualification of Relay or its adapters:

- Gas Town’s durable-mail/native-notification separation and idle-aware fallback: https://github.com/gastownhall/gastown/blob/main/internal/mail/router.go ; https://github.com/gastownhall/gastown/blob/main/internal/nudge/poller.go ; https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md
- Claude Code’s documented busy/idle cross-session delivery behavior: https://code.claude.com/docs/en/cross-session-messaging
- MCP Agent Mail Rust’s polling/signal distinctions: https://github.com/Dicklesworthstone/mcp_agent_mail_rust/blob/main/crates/mcp-agent-mail-tools/src/resources.rs ; https://github.com/Dicklesworthstone/mcp_agent_mail_rust/blob/main/crates/mcp-agent-mail-storage/src/lib.rs
- A2A transport polling/streaming/push semantics: https://a2a-protocol.org/v1.0.0/specification
- Wasteland is a federation/board comparator, not the native wake implementation to copy: https://github.com/gastownhall/wasteland/blob/main/README.md
- Hermes adapter discovery must use current authoritative docs and actual native consumer source: https://hermes-agent.nousresearch.com/docs/

The requirements above are Relay product decisions. Upstream behavior does not confer launch permission, prove access to an existing native session, or qualify this checkout. No code, installed agent configuration, host service, production session, or network policy was changed to produce this PRD.
