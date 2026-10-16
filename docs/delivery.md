# Native agent delivery

## Status

The October 16 implementation adds an opt-in recipient consumer to the pinned
OpenCode plugin: scoped tools, runtime session/lease maintenance and bounded
bridge reconnection. The default remains notice-only. The notification path
still does not claim or acknowledge items; only explicit recipient tool calls
do so. See [idle recipient consumption](idle-consumer.md). Automated integration
coverage is not full native qualification; the historical probes below retain
their original meaning and limitations.

The Relay/v2 delivery contract and original read-only native-client inventory remain frozen. The first-party OpenCode plugin targets exactly v2.0.27. An isolated archive-installed probe verified real supervisor/store binding, notice admission and prepared context in the same idle native session, a primary model request, an exact completed model reply, and persisted safe idle. Three further reconciliations did not repeat delivery or consume the pending message. This is a narrow idle-path result, not full adapter qualification: busy/refusal/restart coverage and the other required clients remain open. D01–D26 in [acceptance](acceptance.md) remain pending as full cases. See the [native-delivery spike](../tests/spikes/003-opencode-native-delivery/README.md).

The later [busy-context spike](../tests/spikes/005-opencode-busy-boundary/README.md)
exposed and fixed binding loss when the native SDK ignored an abort signal.
Real post-fix runs deferred message/work hints while the exact session was busy,
preserved its binding, and admitted one payload-free notice after normal release.
Earlier exact-response checks failed on free-router output; those receipts remain
incomplete. A separate follow-up run completed both exact replies, ordered
admission/context/turn/safe-idle observations, and three unchanged-state
reconciliations with both queue kinds still pending and no repeated delivery.
Its archive/source hashes and owned-resource cleanup were verified. This validates
the controlled-context busy boundary only, not full D04, actual model-tool
interruption safety, refusal/restart recovery, or complete native qualification.

The subsequent [model-tool spike](../tests/spikes/007-opencode-tool-boundary/README.md)
verified an actual model invoking a restricted native tool in the same bound
session. Relay preserved that running tool while both queue kinds stayed pending,
then delivered one notice after normal completion. Native tool/result readback,
both exact replies, ordered delivery phases, safe idle, and three unchanged-state
reconciliations passed. Two earlier failed reply epochs remain intact. This is
one controlled native tool boundary, not full D04, real task handling, native
refusal/restart qualification, or coverage of the other required clients.

The [native permission spike](../tests/spikes/008-opencode-permission-hold/README.md)
then exercised the runtime's real built-in read permission. Relay deferred both
queue kinds through four held-permission samples without a notice or attempt.
Native rejection removed the permission, interrupted its original turn, and left
the same read call in an error state without completing the read. One subsequent
notice produced an exact completed model reply in the same session, ordered
delivery phases and safe idle; three reconciliations retained both pending items
without repeating delivery. Archive/source verification and owned-resource
cleanup passed. Earlier failed receipts remain intact. This is one permission
case, not input-submission refusal, restart recovery, a complete permission
matrix, real task handling, or full adapter qualification.

Relay is independently usable. Executor, MCP, the private agent framework, and
AI Intercom are not runtime dependencies or release prerequisites. Replacing
an installed Intercom deployment is later, separately scoped work. Public demos
and showcase work are deferred until real native delivery is qualified.

Delivery is host-local, opt-in, and disabled by default. The basic Relay store,
queue, broker, Pool, and CLI remain usable with delivery disabled. This feature
does not install or modify an agent, host service, firewall, proxy, or network
policy. It adds no message-body replication, second queue/state engine, board
scheduler, public topology/report/feed fields, dashboard, terminal/UI automation,
or remote launch path. The installed-version snapshot below is one host’s
discovery result, not a supported-version matrix.

The required native-client scope is Codex, Cursor, OMP, Antigravity, Hermes, Zed, ZCode, OpenCode, Kilo, and Cline. The previous managed-catalog inspection supplied discovery evidence only; Relay does not require that catalog or its orchestration stack. Discovery labels establish neither a supported input API nor qualification, and do not remove Zed or ZCode from the required scope.

## Local runtime snapshot

This is the original inventory snapshot, not the later adapter version. Version commands were read-only. Build hashes, local paths, credentials, and session identifiers are intentionally omitted. `zcode` was present, but its version lookup timed out and its help command did not exit within six seconds.

| Managed client | Observed surface | Local version result |
|---|---|---|
| Hermes | CLI; source also exposes TUI/desktop and messaging-gateway plugin hosts | 2026.9.24 |
| OpenCode | CLI, v2 plugin host | 2.0.26 |
| Codex | CLI | 0.162.1 |
| Cursor | Agent CLI | 2026.10.01 |
| OMP | AI coding-assistant CLI and native TypeScript extension | 18.8.7 |
| Antigravity | Managed catalog label; executable `agy` | 1.3.3; exact product/API mapping not independently verified |
| Kilo | CLI | 7.8.8 |
| Cline | CLI | 3.0.70 |
| Zed | Desktop client | 1.23.2 |
| ZCode | CLI | Present; exact version unverified |

## Evidence labels and capability boundary

Capabilities are independent:

- `context`: a native callback/input is known to place the Relay notice in the exact recipient’s model-visible context.
- `idle`: a native operation is known to start a turn in that same, already-bound idle session without user input.
- `launch`: permission to request the existing local Pool/prime launch path. It is not permission for an adapter to start a process or a new conversation itself.

Evidence is also independent of capability: `Declared` is policy/config only; `Wired` means a concrete native callback/input and consumer are traced in source; `Qualified` requires the behavior to be observed on the exact recorded runtime/surface. OpenCode is the only Relay-wired adapter; no native adapter is qualified. Candidate upstream APIs below are not a Relay integration.

Outside the first-party OpenCode adapter, the current managed bridges are lifecycle/context paths, not Relay delivery consumers. Startup hooks and prompt hooks can add context only when those callbacks run; they do not constitute an external idle-session input channel. The existing notify-only wake artifact/helper is not Relay delivery and does not start an idle turn. No adapter may infer success from a hook declaration, stdout, a registration record, a notification receipt, or `true`/HTTP acceptance alone.

## Client inventory

### Codex

- The managed hook map declares `SessionStart`, `UserPromptSubmit`, and `SubagentStart` for ordinary lifecycle work; `ai-intercom.wake` is instruction-only. Hook output can carry `hookSpecificOutput.additionalContext`, but no Relay wake result is connected to that envelope.
- The current adapter’s source note pins its hook-schema evidence to Codex CLI 0.159.2; the local snapshot is 0.162.1. Recheck the output schema against the actual release before relying on that note.
- The OpenAI Codex App Server exposes `thread/resume`, `turn/start`, and turn events for its server-owned thread. Starting a separate app-server process does not prove attachment to the already-running CLI process/session. A safe busy queue, request idempotency, and refusal-to-admission correlation for this exact surface are not established here.
- Current Relay evidence: `context` is a hook-only candidate; `idle` is unsupported on the current managed path; `launch` is not a Codex adapter capability; Relay delivery is not wired.

### Cursor

- The managed hook map uses `sessionStart` and `beforeSubmitPrompt`; wake remains instruction-only. These callbacks can provide context at their documented boundary, not wake an idle session.
- Cursor’s Agent SDK can resume an agent by ID and submit another run. Its docs expose run status and a cloud idempotency key. Cloud busy runs reject rather than queue; current SDK documentation says local agents do not raise `AgentBusyError`, and `local.force` expires a stuck run rather than providing a safe busy-delivery boundary. The SDK call is not present in the managed bridge, and resuming a saved chat does not prove a second process can safely submit to a currently running UI/CLI session.
- Current Relay evidence: `context`/`idle` are SDK candidates only; busy delivery is unqualified; `launch` is not an adapter capability; Relay delivery is not wired.

### ZCode

- The managed adapter declares `SessionStart` and `UserPromptSubmit`; wake is instruction-only. It also declares an observe-only `PermissionRequest` hook. The official hook API returns model context through `hookSpecificOutput.additionalContext`, but the local executable’s exact version is unknown and the current hooks do not provide an idle input operation.
- Current Relay evidence: `context` is a hook-only candidate; `idle` has no established supported existing-session input or safe busy queue; idempotency/status is unverified; `launch` is not an adapter capability and remains only the existing local Pool/prime path; Relay delivery is not wired.

### Antigravity

- The managed catalog calls this client `antigravity` and the local executable is `agy`; its version is known, but an authoritative source mapping that exact executable/version to the managed `PreInvocation` hook contract was not located.
- `PreInvocation` is a policy declaration, not proof of a supported consumer return envelope. No exact existing-session input, safe busy queue, refusal/status, or idempotency API is selected. Do not substitute a similarly named Gemini CLI or launch a new conversation and call it idle activation.
- Current Relay evidence: `context`, `idle`, and native refusal behavior are unqualified; `launch` remains only the existing local Pool/prime path; Relay delivery is not wired.

### OMP

- The managed native TypeScript extension reads the exact current session identity. Its current route sends a hidden custom message with `triggerTurn: false` during session startup/switch; the prompt callback likewise returns a message for an already-starting turn. This can provide context but does not activate an idle session. The extension has no Relay input consumer.
- OMP 18.8.7’s public SDK is an in-process embedder (`createAgentSession`), not an external attach path to the installed CLI. Its `followUp` and session/turn events remain candidates for the exact owning runtime; durable request idempotency is undocumented, so duplicate submissions remain uncertain absent native observation or operator reconciliation.
- Current Relay evidence: context is wired at the native OMP boundary but not to Relay; `idle` is unqualified; `launch` is not an adapter capability.

### Kilo

- The current managed bridge handles `session.created`, `chat.message`, and `experimental.chat.system.transform`. The lifecycle callback ignores the hook return; the latter two mutate the current prompt/system context. They do not submit a new idle turn. The wake mapping is instruction-only.
- Current Kilo v2 documentation describes a session inbox/prompt API with a client-supplied message ID and an admission result, but it is not version-matched to the observed CLI 7.8.8. Replaying a message ID returns the prior admission but schedules another wake unless `resume:false`, which admits only; `sessions.active()` is process-local and resets on restart. Backlog/steering limits and provider timeout policy are deferred. Do not use this candidate for release qualification without a version-matched bounded API and current exact-session status/refusal/observation semantics.
- Current Relay evidence: context is wired for existing prompt boundaries but not to Relay; `idle` is an unqualified API candidate; `launch` is not an adapter capability.

### Cline

- The managed native hooks are `TaskStart` and `UserPromptSubmit`. Their consumed output is a JSON envelope with `cancel` and optional `contextModification`; the present wake declaration is instruction-only. These hooks add context at task/prompt boundaries and cannot start an idle turn.
- ClineCore documents `send(sessionId, prompt)` and status/event subscriptions, but that is an in-process Core surface, not proof that the installed CLI/extension can be attached safely from another process. Busy queue semantics and idempotent retry are not established for the observed Cline 3.0.70 surface.
- Current Relay evidence: context is wired for existing callbacks but not to Relay; `idle` is unqualified; Cline approval remains runtime-owned; `launch` is not an adapter capability.

### Hermes

- The managed Relay-adjacent hook is instruction-only. Hermes 2026.9.24 exposes `PluginContext.inject_message(content, role, session_key=...)` only inside its Python plugin context. Gateway injection requires the explicit `allow_gateway_injection` grant. Its boolean result reports scheduling acceptance only; the API provides no caller request ID, idempotency receipt, fresh exact-session status, or correlated context/turn observation. The alternate `origin` form may start a session and is forbidden as a substitute for idle activation.
- A generic external bridge cannot supply those missing native semantics. In particular, cached hook state or matching injected text is not evidence of current idle/context/turn. The classic CLI busy path can interrupt and is not usable for safe busy delivery; no verified external path is established for another surface.
- Current Relay evidence: Hermes remains required but unsupported/unqualified. A safe adapter needs a version-matched in-process API with caller-keyed idempotent enqueue plus fresh exact-session status and correlated context/turn observation; deployment and permission changes remain owner-controlled. `launch` remains the local Pool/prime path.

### Zed

- The managed policy supplies instructions only; it has no native Zed hook or external input bridge. Zed’s ACP client starts/controls an ACP agent process. ACP `session/prompt` targets that child agent session, not proof of an input path into an already-running Zed-owned assistant session.
- Current Relay evidence: no existing native-session context/input consumer selected; `context`/`idle` are unsupported on the inspected managed path; ACP child launch is not Relay launch authority; Relay delivery is not wired.

### OpenCode

- The current v2 plugin bridges `session.created`/`session.deleted` and mutates model context at prompt/context hooks. The `session.created` wake callback invokes a semantic hook but discards its output; it does not start a turn or deliver a notice.
- OpenCode’s v2 plugin/session API can submit to an exact existing `sessionID`; use explicit `delivery: "queue"`, never `steer`, for Relay. A caller-supplied prompt ID is retry-safe: a repeated ID for an existing admission returns the original admission rather than adding another inbox item. Concurrent submissions can still run prompt hooks more than once, so this is not an exactly-once side-effect boundary. The API returns an inbox/admission record, not proof of model-visible context or a turn; session/message events provide separate observations. Permissions remain native and must not be bypassed.
- Current Relay evidence: `@pugzui/relay/opencode-plugin` supplies the exact v2.0.27 PluginContext handoff and queues an idempotent prompt to the configured existing session. It observes prepared context and primary `model.request`, then handles exact-session `session.execution.succeeded|failed|interrupted` and confirms idle through native `session.wait`. Per-attempt bridge reports are serialized so context, turn, and safe-idle observations cannot arrive out of order. The authenticated broker bridge checks exact Relay authority/worker/session/epoch and coalesces configured local/hub bindings on one target gate. Archive-installed native idle delivery, an exact completed model reply, and safe idle were observed on the isolated Linux surface; `launch` is not an adapter capability. The original v2.0.26 test-callback smoke remains historical evidence only.

The v2.0.27 idle probe installed an actual `npm pack` archive offline and imported its exported plugin through a test-only package-directory observation wrapper. Both the supervisor/store and plugin used installed archive bytes; the native PluginContext was forwarded unchanged. A separate test-only inference plugin used an owner-approved, explicitly zero-priced route; it is not a Relay runtime dependency. Native message readback matched the stored admission ID and contained the notice only, not the queued payload. An exact completed assistant reply and all four ordered delivery timestamps were observed. This proves the archive-loaded idle path, not direct published-package loader configuration, busy-boundary/refusal/restart behavior, a work claim, completed handling, or acknowledgement. Earlier provider HTTP 403 and other failed probe receipts remain intact.

### Installed plugin configuration

The separately verified direct loader selects the archive-installed Relay
package's `src/adapters` directory in an approved project's `opencode.json(c)`
`plugins` entry. Its `package` value is that absolute directory path, not the
Relay library root or the `@pugzui/relay/opencode-plugin` import string. The
canonical `index.mjs` serves both this directory and the programmatic import;
there is no separate plugin publication or second implementation.

Supply the existing exact options: `relayRoot`, `profile`, `nativeSession`, and
`bindings`. Each binding contains its current `authority`, `worker`, `sid`,
and integer `epoch`; use actual session readback, never a remembered identity.
The owning Relay supervisor must already be enabled on that root. This does
not authorize installation, permission changes, or enabling an existing profile.

The [direct-loader spike](../tests/spikes/004-opencode-direct-loader/README.md)
observed one exact live-store binding with empty queues, then a separate real
idle delivery through this configuration. OpenCode reported the Relay plugin
active; no Relay observation wrapper or archive overlay was used. A read-only
test helper confirmed native idle, and the free inference helper remained
test-only. Exact notice/admission readback, an exact completed reply, all four
ordered timestamps, gate release, unchanged-state coalescing and cleanup passed.
This closes the local installed-directory loading gap, not native busy,
hold/refusal, restart, other-client, or registry/Git-selector qualification.
The earlier wrapper-loaded and failed receipts remain unchanged.

## Frozen recipient API

Add exactly one payload-free recipient summary operation. The result is this strict seven-field shape:

```ts
interface PendingCounts {
  msg: number;
  work: number;
}

interface PendingSummary {
  v: 1;
  authority: string;
  worker: WorkerAddress;
  epoch: number;
  revision: string; // 64 lowercase hex characters
  pending: PendingCounts;
  recoverable: PendingCounts;
}
```

`Relay.pending(sid)` is synchronous; `Client.pending(sid)` is asynchronous. The existing `/v1/call` protocol gains `op: "pending"` with exact args `{ sid }`. Add a consumer declaration for `PendingCounts` and `PendingSummary`; do not add runtime top-level exports.

- `pending` counts only addressed messages for the exact current worker/session. Board `{msg}` remains posted Inbox history and is never included. Board `{work}` remains Pool/prime demand, not a notifier assignment.
- `recoverable` counts current `claimed` rows whose live lease deadline has passed and which the existing mutation path can requeue/claim; reads never relabel or expire those claims.
- The read does not initialize a missing root/session, renew, claim, purge, expire/requeue, write audit, or insert an RPC journal row. It does not change any message, lease, receipt, or session state.
- `revision` is an opaque SHA-256 of a deterministic canonical projection of the exact recipient’s eligible message/attempt state from the same SQLite read snapshot: message identity, kind, pending/claimed state, attempt number, current lease identity/deadline, and whether that lease is recoverable at the snapshot’s single `now`. It excludes body/data. New admission, release/requeue, claim-attempt change, and newly recoverable expiry therefore change the revision even when a message ID is reused. No timestamp is included, so unchanged state remains stable.
- The response contains no `sid`, lease, message ID/body, native session handle, path, token, launch authority, or other worker’s data. A count/revision is a discovery hint only, never a claim or acknowledgement.
- Remote authorization requires the current authenticated principal’s exact worker grant and ownership of that live session/epoch. It does not require `inspect.messages`/topology, and filtering occurs before counts. The read is reauthorized before response and creates no RPC journal entry.

## Binding, ownership, and uncertain calls

A native binding is an exact tuple of authority, worker, Relay `sid`/epoch, runtime instance, profile, native session identity, native lifecycle generation, and monotonic binding generation. The raw native session identity and Relay session ID live only in the owner-private local Relay store. They are never included in the notice, public topology, CLI status, logs, screenshots, or release evidence.

The v3 coordination model is one local SQLite state engine with these records:

- `delivery_owners`: one owner generation/lease per host-local root; the generation, not a PID, fences mutations and dispatch.
- `delivery_bindings`: the protected exact binding tuple, capability flags, binding generation, lifecycle state, and timestamps.
- `delivery_attempts`: one attempt ID and target digest, owner generation, state, optional native request ID, observation timestamps, retry boundary, and validated reason code. No work/message body.
- `delivery_attempt_scopes`: the per-authority binding generation, pending revision, and separate pending/recoverable `msg`/`work` counts included in that attempt.
- `delivery_targets`: one target digest and active gate/attempt state shared across all of that root’s local/hub bindings.

The native target digest is SHA-256 over canonical stable `(profile, native session)` identity, independent of Relay authority and adapter client. Runtime-instance and lifecycle-generation values remain on the protected binding and rotate its generation; they do not change the cross-root gate. Same-target local/hub bindings share one gate but keep authority/session/epoch scope rows distinct. A fixed per-OS-user `O_EXCL` lock token keyed only by that digest prevents a second Relay root from submitting to the same native target. The token is only an exclusion primitive, not another store: it contains no queue, body, credentials, or authoritative attempt history. It has no TTL takeover. A competing root refuses until the owning root safely releases it or an operator explicitly reconciles its attempt.

Attempt lifecycle: `reserved` → `submitting` → `admitted` → `context_observed` → `turn_started` → `safe_idle`. `held`, `refused`, `uncertain`, and `reconciled` are explicit states, not success aliases. Persist the attempt and acquire the target gate before the native call; commit `submitting` before calling outside SQLite. If recovery finds `reserved`, no native call began and it may be retried after revalidation. If it finds `submitting`/`admitted` without native idempotency or an observation, it is uncertain and retains the target gate. A supervisor lease expiring never reopens that gate. Use the same attempt ID for supported native idempotency; otherwise do not blindly retry. An explicit local operator reconciliation can record `observed` or `not-accepted`; it does not alter the authoritative Relay queue.

`context_observed` means the exact native session made the notice model-visible. `turn_started` means its native turn-start was observed. `safe_idle` means the turn following that attempt reached an observed safe boundary. None of these mean the task was claimed, completed, or acknowledged. An approval/hold stays native-owned; no shell, terminal, alternate API, or launch path may bypass it.

Use committed feed/audit events only as invalidation hints. Reconcile current recipient summaries at startup, after feed reset/overflow, and on the bounded polling interval. A checkpoint never replaces a current-state read. Coalesce by binding/revision; do not classify by text. Unchanged already-notified state must not produce reminder turns; any future reminder schedule requires an explicit bounded policy. Preserve pending work through restart and shutdown.

## Security and notice boundary

Native credentials remain runtime-owned and separate from Relay credentials. Never pass a Relay bearer to a native client, place a secret in argv/URL/log/notice, follow redirects with credentials, or accept a destination, adapter, permission, or executable from message/work data. All notice destinations are fixed by the exact binding and current operator configuration. Recheck auth and binding generation before every summary read and native submission; revocation fences future work but cannot undo an already accepted turn.

The model-visible hint may contain only a fixed operational notice plus bounded per-scope kind counts/revisions. It contains no work/message text, message ID, lease, Relay session ID, native session handle, local path, credential, or free-form native error. Diagnostics use finite reason codes and `null` for unknown observations. Keep topology/report/feed schemas unchanged and publish only redacted native evidence.

## Configuration, CLI, schema, and limits

Config v1 remains accepted unchanged and means `delivery.enabled = false`; it is not auto-migrated. Strict config v2 adds exactly one top-level `delivery` object with exactly these fields:

```json
{
  "enabled": false,
  "clients": [],
  "pollMs": 1000
}
```

`clients` is a unique explicit subset of `codex`, `cursor`, `omp`, `antigravity`, `hermes`, `zed`, `zcode`, `opencode`, `kilo`, `cline`. Disabled config requires an empty selection; enabled config requires a host role and a nonempty selection. `pollMs` is an integer from 250 to 30,000. There are no adapter URLs, callback commands, executable overrides, message-selected destinations, or new launch permission. The configured existing local root and fixed hub are the only Relay authorities. A selected but unavailable/unqualified adapter remains visible as unsupported; it is never silently dropped or treated as qualified.

- `relay pending --sid SID --root PATH` and the matching authenticated `--url HTTPS_ORIGIN --token-file FILE` form are read-only. The result is exactly `PendingSummary`.
- `relay serve --root PATH --config FILE` remains the explicit foreground start. It owns the optional supervisor only when v2 config enables it; `SIGINT`/`SIGTERM` stops it. Importing/opening a store or running a read-only command never starts a notifier.
- `relay delivery-status --root PATH --config FILE` is local-only and read-only. It reports enabled/owner/capability state, bounded attempt counts, timestamps, retry boundary, and reason codes only; no session/worker/native IDs, paths, or raw native errors.
- `relay delivery-reconcile ATTEMPT --root PATH --outcome observed|not-accepted --reason-code operator-confirmed --confirm` is local-only, explicit, and never sends a native message. It may clear uncertainty only when the owning service is stopped and the operator confirms the external outcome.
- `relay migrate --root PATH --to 3 --backup PATH` is the only v2→v3 migration. It refuses overwrite/symlink backups and unknown/corrupt schemas, verifies the backup, and changes only delivery schema metadata/tables. `--to 2` is the explicit rollback and requires `--config FILE` whose strict parsed delivery setting is disabled, no unresolved attempt/gate, and its own new backup. Both directions preserve messages, leases, receipts, sessions, audit, RPC journal, and immutable `init`. Delivery-only history is retained in the backup on rollback. `open()` never migrates or resets.

Fresh stores use schema v3. The new implementation continues to open schema v2 stores for ordinary core operations and `pending()` while delivery is disabled. Enabling delivery on a v2 store fails closed with the explicit migration instruction; it does not auto-upgrade.

Freeze these bounds in `src/validate.mjs`; existing lower Pool/broker/launch limits still win:

| Resource | Default / hard cap |
|---|---|
| Delivery | Disabled |
| Active bindings | 64 / 512 |
| Scheduled hints | One coalesced slot per binding; no per-event backlog |
| Reconciliation | 1,000 ms; range 250–30,000 ms |
| Native calls | 4 total; 1 per target across authorities |
| Submission and recovery deadline | 10,000 ms combined |
| Retry backoff | 250–10,000 ms with jitter; no unsafe retry |
| Notice | 2,048 UTF-8 bytes; counts/revisions only, no payload |
| Automatic retry | At most 3 inside the deadline and only with native idempotency/safe refusal |
| Coordination/history | 10,000 rows total; terminal history at most 7 days; unresolved rows retained and count toward capacity |
| Public diagnostics | Existing 50 default / 200 maximum |

Capacity refusal must not delete unresolved records or admitted Relay work. A running native submission whose cancellation is unproved remains uncertain. Shutdown cancels owned timers/feeds, stops new attempts, closes owned handles, and never acknowledges/releases work or terminates an unowned process.

## Release boundary

All ten inventory rows are required for a full unattended-receiver release. A missing, context-only, busy-unsafe, or unversioned path is a blocker, not a reason to remove the client or call the whole matrix qualified. In particular, a client must pass same-session idle activation and safe busy-boundary delivery on its exact runtime/version before its `idle` capability can be `Qualified`. A stub adapter, API documentation, captured stdout, host acceptance boolean, local loopback, or harmless child fixture is not that evidence.

No physical LAN/Tailscale/private-route claim follows from native delivery work. A21/A29 remain separate release gates. See [acceptance](acceptance.md), [implementation contract](contract.md), and [verification boundaries](verification.md).

## Official API references inspected

These references describe candidate upstream APIs, not Relay qualification:

- [Hermes plugin documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins/) — plugin injection is profile-permission-gated; the installed 2026.9.24 source was also inspected read-only.
- [OpenCode v2 plugin API](https://dev.opencode.ai/v2/docs/build/plugins/) and [API](https://dev.opencode.ai/v2/docs/api/) — exact session prompt, explicit queue delivery, admission IDs, and session events.
- [Kilo Code](https://github.com/Kilo-Org/kilocode) — current v2 session specification; not matched to the installed 7.8.8 executable.
- [OMP SDK](https://github.com/open-horizon-labs/oh-omp/blob/main/docs/sdk.md) — in-process session and follow-up APIs.
- [Cursor Agent SDK](https://cursor.com/docs/agent-sdk/python) — resumable agent IDs, run status, and cloud busy/idempotency behavior.
- [Codex App Server](https://developers.openai.com/codex/app-server) — thread resume and turn APIs; no proof of control of an already-running CLI process.
- [Cline SDK sessions](https://docs.cline.bot/cline-sdk/sessions) — ClineCore session input/status API; not version-matched to the installed CLI.
- [Zed ACP quickstart](https://zed.dev/docs/agent-client-protocol/quickstart) — Zed-controlled ACP child process, not an external input API to Zed’s own active assistant.
- [ZCode hooks](https://zcode.z.ai/en/docs/hooks) — lifecycle hook output is context-only and cannot establish idle activation.

The inspected source did not map the exact local `agy` executable/version to an authoritative input API; no adapter claim is made.

## WP4: historical native adapter boundary

At the WP4 checkpoint, OpenCode v2.0.26 was the sole implemented adapter and remained unqualified. The exported native plugin is designed to run inside OpenCode's own PluginContext; its setup validates the configured exact session/profile, supplies runtime and lifecycle identity, and connects to the broker through a private Unix socket with an owner-only token. It uses the existing Relay `bind()` path; the broker never imports or guesses a native SDK context. Plugin options must contain the exact pre-authorized Relay authority/worker/session/epoch bindings; one native plugin connection can bind local and configured hub scopes while sharing the same consumer and target gate.

The no-spend smoke used an isolated temporary HOME/profile and disposable empty OpenCode sessions created through the documented `POST /api/session` route. The real plugin verified its exact configured session through `session.get`, bound through the private bridge, and read fresh idle status via `session.wait`. The Node bridge's bind callback was a test stub, so this did not establish live Relay supervisor/store binding. No `session.prompt` or provider call occurred; both disposable sessions were deleted and confirmed absent, and the isolated processes were stopped. The repository-owned bridge/PluginContext fixture tests prove mechanics only. This work does not install or enable the plugin in an active profile, or change host permissions/configuration. Native context, turn, safe-idle-after-turn, refusal, restart, and end-to-end Relay persistence evidence remain pending; no native adapter is qualified. All other selected clients without concrete adapters remain `unsupported` in delivery status, with all adapter capabilities false; their messages remain in the authoritative Relay queue. Per-client API/version/capability/deployment gaps are recorded in [delivery blockers](delivery-blockers.json). This work does not pass D02, D03, D04, or D25, and the ten-client required support set remains unchanged.

## WP5a protocol verification checkpoint

The protocol/regression checkpoint ran on Linux x86_64 (Arch Linux, kernel 7.2.9-arch1-1), Relay revision `d37b70ffdf6b49f900ec1502dbcaad6a988f16de` plus the recorded dirty `src/broker.mjs` bytes, with Node.js 26.11.1 and npm 12.2.0. `npm run check` passed its 26-module syntax, nine-export, declaration, import and 26-file packaging checks; `npm run test` passed 122/122 with no skips. Three disposable store examples passed, the network example verified distinct hub/host authorities over loopback HTTP and locally trusted HTTPS, and an authenticated Chromium 153 demo passed wide/narrow rendering plus live broker-stop/restart recovery. Exact measurements, hashes and the distinction between current-run and retained browser evidence are in [delivery qualification](media/delivery-qualification.json).

Node 24.21.0 was not installed in the inspected system/version-manager locations, so this checkpoint does not claim a current Node 24 run. The network/browser evidence is same-machine and synthetic. Permission/revocation and paginated snapshot-reset browser evidence remains in the retained verification artifacts; those flows were inspected rather than replayed here. None of this qualifies native delivery: OpenCode remains the sole implemented adapter, zero adapters are qualified, all D01–D26 native cases remain pending, and no exact native session was woken. A21 physical two-host LAN/Tailscale and A29 private-route/denied-third-device remain separate open gates.
