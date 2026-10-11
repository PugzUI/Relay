# Native agent delivery

## Status

As of 2026-10-11, this document freezes the Relay/v2 delivery contract and a read-only native-client inventory. It is not an implementation or support claim. Relay does not currently deliver a message into an agent session or activate an idle session. All D01–D26 cases in [acceptance](acceptance.md) remain pending; no native adapter is qualified.

Delivery is host-local, opt-in, and disabled by default. The basic Relay store,
queue, broker, Pool, and CLI remain usable with delivery disabled. This feature
does not install or modify an agent, host service, firewall, proxy, or network
policy. It adds no message-body replication, second queue/state engine, board
scheduler, public topology/report/feed fields, dashboard, terminal/UI automation,
or remote launch path. The installed-version snapshot below is one host’s
discovery result, not a supported-version matrix.

The client scope is the ten enabled receiving clients in the inspected managed catalog: Codex, Cursor, OMP, Antigravity, Hermes, Zed, ZCode, OpenCode, Kilo, and Cline. Shared discovery and orchestration entries are not receivers. The managed policy’s `first_class_clients` list is a discovery hint, not evidence of use, an input API, or qualification; it does not remove Zed or ZCode from this inventory.

## Local runtime snapshot

Version commands were read-only. Build hashes, local paths, credentials, and session identifiers are intentionally omitted. `zcode` was present, but its version lookup timed out and its help command did not exit within six seconds.

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

Evidence is also independent of capability: `Declared` is policy/config only; `Wired` means a concrete native callback/input and consumer are traced in source; `Qualified` requires the behavior to be observed on the exact recorded runtime/surface. No client is Relay-wired or qualified today. Candidate upstream APIs below are not a Relay integration.

The current managed bridges are lifecycle/context paths, not a Relay delivery consumer. Startup hooks and prompt hooks can add context only when those callbacks run; they do not constitute an external idle-session input channel. The existing notify-only wake artifact/helper is not Relay delivery and does not start an idle turn. No adapter may infer success from a hook declaration, stdout, a registration record, a notification receipt, or `true`/HTTP acceptance alone.

## Client inventory

### Codex

- The managed hook map declares `SessionStart`, `UserPromptSubmit`, and `SubagentStart` for ordinary lifecycle work; `ai-intercom.wake` is instruction-only. Hook output can carry `hookSpecificOutput.additionalContext`, but no Relay wake result is connected to that envelope.
- The current adapter’s source note pins its hook-schema evidence to Codex CLI 0.159.2; the local snapshot is 0.162.1. Recheck the output schema against the actual release before relying on that note.
- The OpenAI Codex App Server exposes `thread/resume`, `turn/start`, and turn events for its server-owned thread. Starting a separate app-server process does not prove attachment to the already-running CLI process/session. A safe busy queue, request idempotency, and refusal-to-admission correlation for this exact surface are not established here.
- Current Relay evidence: `context` is a hook-only candidate; `idle` is unsupported on the current managed path; `launch` is not a Codex adapter capability; Relay delivery is not wired.

### Cursor

- The managed hook map uses `sessionStart` and `beforeSubmitPrompt`; wake remains instruction-only. These callbacks can provide context at their documented boundary, not wake an idle session.
- Cursor’s Agent SDK can resume an agent by ID and submit another run. Its docs expose run status and a cloud idempotency key. Cloud agents report a busy run instead of queuing; local busy behavior is not a safe queue contract, and the SDK call is not present in the managed bridge. The local CLI’s ability to resume a saved chat is not evidence that a second process can safely submit to a currently running UI/CLI session.
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
- OMP’s documented in-process session API supports a `followUp` path when a turn is already streaming and exposes session/turn events. This is a candidate safe-boundary mechanism only when called inside the exact owning runtime. No durable request-idempotency guarantee is documented for this path; duplicate submissions therefore remain uncertain unless a native observation or operator reconciliation resolves them.
- Current Relay evidence: context is wired at the native OMP boundary but not to Relay; `idle` is unqualified; `launch` is not an adapter capability.

### Kilo

- The current managed bridge handles `session.created`, `chat.message`, and `experimental.chat.system.transform`. The lifecycle callback ignores the hook return; the latter two mutate the current prompt/system context. They do not submit a new idle turn. The wake mapping is instruction-only.
- Current Kilo v2 documentation describes a session inbox/prompt API with a client-supplied message ID and an admission result. This is a candidate only: the local CLI is 7.8.8, the API contract is not version-matched to that binary, and the inspected v2 specification explicitly leaves inbox/steering backlog limits and provider timeouts unresolved. Do not use it for release qualification until the exact build, safe busy behavior, resource bounds, and status/refusal path are verified.
- Current Relay evidence: context is wired for existing prompt boundaries but not to Relay; `idle` is an unqualified API candidate; `launch` is not an adapter capability.

### Cline

- The managed native hooks are `TaskStart` and `UserPromptSubmit`. Their consumed output is a JSON envelope with `cancel` and optional `contextModification`; the present wake declaration is instruction-only. These hooks add context at task/prompt boundaries and cannot start an idle turn.
- ClineCore documents `send(sessionId, prompt)` and status/event subscriptions, but that is an in-process Core surface, not proof that the installed CLI/extension can be attached safely from another process. Busy queue semantics and idempotent retry are not established for the observed Cline 3.0.70 surface.
- Current Relay evidence: context is wired for existing callbacks but not to Relay; `idle` is unqualified; Cline approval remains runtime-owned; `launch` is not an adapter capability.

### Hermes

- The managed Relay-adjacent hook is instruction-only. The installed Hermes source provides `PluginContext.inject_message(content, role, session_key=...)`; non-CLI injection requires the plugin’s explicit `allow_gateway_injection` permission and the exact existing durable session key. Its boolean result means the host accepted scheduling, not that context or a turn was observed. The alternate `origin` form may start a session and is forbidden as a substitute for idle activation.
- The inspected native TUI/desktop host queues a message on a busy exact session and drains it when idle. The classic CLI path uses its interrupt queue while busy, so it must not be used for D04. Gateway input uses the adapter’s existing busy-session queue, rechecks current authorization, and cannot approve tools or resolve confirmation/clarification prompts. The API is disabled for plugins by default; acceptance only means asynchronous scheduling, not turn or platform-delivery completion. No idempotency key or completion receipt is provided by `inject_message`.
- Current Relay evidence: `context` and `idle` are candidate capabilities for the exact TUI/desktop/gateway surface only; the Relay project does not set the plugin permission, and host configuration remains an owner-controlled prerequisite; no Relay adapter is wired or qualified; `launch` remains the local Pool/prime path.

### Zed

- The managed policy supplies instructions only; it has no native Zed hook or external input bridge. Zed’s ACP client starts/controls an ACP agent process. ACP `session/prompt` targets that child agent session, not proof of an input path into an already-running Zed-owned assistant session.
- Current Relay evidence: no existing native-session context/input consumer selected; `context`/`idle` are unsupported on the inspected managed path; ACP child launch is not Relay launch authority; Relay delivery is not wired.

### OpenCode

- The current v2 plugin bridges `session.created`/`session.deleted` and mutates model context at prompt/context hooks. The `session.created` wake callback invokes a semantic hook but discards its output; it does not start a turn or deliver a notice.
- OpenCode’s v2 plugin/session API can submit to an exact existing `sessionID`; use explicit `delivery: "queue"`, never `steer`, for Relay. A caller-supplied prompt ID is retry-safe: a repeated ID for an existing admission returns the original admission rather than adding another inbox item. Concurrent submissions can still run prompt hooks more than once, so this is not an exactly-once side-effect boundary. The API returns an inbox/admission record, not proof of model-visible context or a turn; session/message events provide separate observations. Permissions remain native and must not be bypassed.
- Current Relay evidence: upstream `context`/`idle` and safe queue/idempotency are strong candidates; the managed bridge does not call that API for Relay; no native qualification has been performed; `launch` is not an adapter capability.

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

The native target digest is SHA-256 over canonical `(runtime instance, profile, native session, lifecycle generation)` identity. Same-target local/hub bindings share one gate but keep authority/session/epoch scope rows distinct. A fixed per-OS-user `O_EXCL` lock token keyed only by that digest prevents a second Relay root from submitting to the same native target. The token is only an exclusion primitive, not another store: it contains no queue, body, credentials, or authoritative attempt history. It has no TTL takeover. A competing root refuses until the owning root safely releases it or an operator explicitly reconciles its attempt.

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
