# Idle recipient consumption

## Status and ownership

Relay includes an opt-in recipient consumer for the existing OpenCode 2.0.27
plugin. The default remains notice-only. This implementation has automated
store, bridge, plugin-contract and lifecycle coverage; those tests use a fake
native SDK and do not qualify a real OpenCode runtime or another client.

The owning plugin attaches only to the explicitly supplied existing native
session and current Relay bindings. It does not launch a conversation, install
an agent, change permissions, or replace an existing Intercom deployment.
The normal local dashboard profile leaves native delivery disabled.

## Configuration

Use the installed plugin directory and existing host configuration described
in [delivery](delivery.md). The host must explicitly enable its `opencode`
delivery client. Add `consume: true` to the plugin options only when this plugin
is intended to own the mapped Relay session lifetimes and recipient tools:

```json
{
  "relayRoot": "/absolute/path/to/private/relay-store",
  "profile": "approved-profile",
  "nativeSession": "ses_REPLACE_WITH_EXISTING_SESSION",
  "bindings": [
    {
      "authority": "REPLACE_WITH_STORE_AUTHORITY",
      "worker": "workstation:opencode:001",
      "sid": "REPLACE_WITH_CURRENT_RELAY_SESSION",
      "epoch": 1
    }
  ],
  "consume": true
}
```

All identifiers above are placeholders. Read the current authority, session and
epoch before configuring them. Omit `consume` to retain notice-only behavior;
`consume: false` is not an alternative configuration shape. Do not run two
session owners against the same mapping. Native tool permissions must be
approved separately in the owning runtime; Relay does not grant them.

## Model-facing tools

| Tool | Input | Effect |
|---|---|---|
| `relay_pending` | Empty object | Reads addressed message/work counts and revisions. |
| `relay_claim` | `kind: msg` or `kind: work` | Claims one addressed item and returns its lease and explicit envelope. |
| `relay_reply` | `lease`, `msg` | Replies to the original sender of an owned message claim. |
| `relay_ack` | `lease`, `outcome` | Records the explicit `done`, `failed` or `rejected` outcome. |
| `relay_release` | `lease` | Releases an owned claim for another attempt. |

Tools reject another native session. Authority, worker, Relay session, epoch,
destination, paths and credentials are not model arguments. Replies are
limited to 4,096 UTF-8 bytes and one accepted reply per message lease, with a
runtime-derived idempotency key. Work claims accept any valid JSON work value;
work completion uses explicit acknowledgement, not the message reply tool.

The consumer allows one active lease and one claim attempt per native
activation. Completion of a native turn resets that activation limit but never
acknowledges the item. A notification contains counts and revisions, not the
queued payload. Only an authorized claim returns that payload.

## Lifetimes and recovery

Session renewal and active-lease extension run in ordinary runtime timers,
independently of model inference. Maintenance is scheduled from the returned
remaining lifetime, and lease maintenance and settlement are serialized.
Malformed receipts, lost ownership and ambiguous claims stop further recipient
processing. No new claim is allowed to hide an unresolved earlier operation.
Recipient bridge calls have a ten-second deadline. Shutdown cancels owned
in-flight calls even when a bridge ignores cancellation, and a known lease's
cleanup release is separately bounded. A late response is not a new execution
or settlement permission; ambiguous outcomes remain unresolved.

The local bridge authenticates its private socket and gates recipient calls on
the explicit consumption opt-in. The supervisor revalidates the persisted
binding generation. Replies resolve their destination from authoritative
metadata for a lease held by that binding.
The transport rejects malformed UTF-8 instead of repairing it. Private token
and credential readers reject links, non-regular files and oversized contents;
a named pipe cannot block startup or credential reload. The bridge transport
also has an absolute request deadline that partial response bytes cannot reset.

Bridge transport failures have bounded reconnect/rebind behavior. Native
submission failures do not trigger blind resubmission. Rebinding cannot change
the configured recipient identity or release an unresolved target gate.
A saved native request ID or a later idle event is not proof of earlier
admission, context or turn observations. Full native restart reconciliation
remains unqualified; unresolved cases require authoritative observation or the
existing stopped-service, operator-confirmed reconciliation command.

Confirmed nonacceptance can make unchanged pending state eligible again with
bounded backoff. Accepted or uncertain attempts remain protected. Background
hub summary reads share a budget of 20 per minute, rotate across bindings and
back off on failure. Explicit recipient reads and claim preflight checks use
fresh authority state without competing for that background budget. Cached
summaries never authorize a new native admission. The broker's normal limits
still apply to all foreground reads, claims, maintenance and other traffic.

The plugin fences Relay operations, not arbitrary external side effects from
other tools. External work must still be idempotent where repetition matters.
No exactly-once execution or automatic permission approval is promised.

## Verification

```sh
node --test tests/idle-agent.integration.test.mjs
RELAY_IDLE_SOAK=1 node --test tests/idle-agent.integration.test.mjs
```

The first command exercises real SQLite, supervisor, socket bridge and plugin
code with a fake native SDK, including a large JSON work item and explicit
completion. The opt-in variant also crosses the default session and claim
lifetimes using the real clock. Neither command sends an inference request.
See [verification](verification.md) for the recorded run and remaining native
qualification boundaries.
