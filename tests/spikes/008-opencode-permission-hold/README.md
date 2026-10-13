# 008 — OpenCode native permission hold and rejection

## Question

With an existing, exactly bound OpenCode 2.0.27 session waiting for a real native
read permission, does Relay defer pending message/work hints, preserve the
binding, and deliver one notice after rejection without completing the refused
read?

## Approach

Use the [shared runner](../001-opencode-version-boundary/run.py), an offline
installed Relay archive, its directly configured plugin directory, the real
supervisor/store, and the authenticated private bridge. No runtime SDK method,
Relay bind callback, or provider response is replaced.

The test-only [tool selector](permission-tool.mjs) exposes the runtime's existing
`read` tool and retains its executor. All other tools are removed from the owned
isolated profile. The only requested file is a disposable project fixture.
Native permission rules require approval for `read`; the model itself must call
it. A pending permission must identify the same session, assistant message, and
sole running tool call before any Relay payload is committed.

The [observer](permission-hold.py) checks the real session permission and message
APIs. Four reconciliation samples require the permission still held, the exact
binding preserved, both queue kinds pending, and no notice or delivery attempt.
It revalidates the permission identity before sending the native `reject`
decision and reads back its absence plus the same tool call's error state.

On this runtime, rejection interrupts the original preparation turn. That
observed `aborted` outcome is recorded separately; it is not a completed model
reply and is not attributed to the provider. The subsequent Relay notice must
still produce an exact, unpadded completed delivery reply in the same session,
ordered admission/context/turn/safe-idle phases, and three reconciliations without
another notice or queue consumption.

```sh
python -O tests/spikes/001-opencode-version-boundary/run.py \
  --expect delivery --packaged --plugin-source plugin-directory \
  --permission-hold --trace-inference --opencode "$OPENCODE_BINARY" \
  --aperture-url "$APPROVED_FREE_API_BASE" --model openrouter/free
```

The gateway is optional test infrastructure, not a Relay runtime dependency.
The runner checks the selected route's live explicit zero input/output prices
and prohibits paid fallback. It creates private temporary profiles and owns all
processes, sessions, bridge resources, and captures. It does not modify an
installed profile or publish a gallery.

## Verdict: VALIDATED

### What worked

A real OpenCode 2.0.27 execution using the owner-approved `openrouter/free` route
passed this one read-permission boundary:

- The model called the real native `read` tool and a pending permission identified
  its exact message/call. Four held-permission samples preserved the binding and
  both pending queue kinds with no premature attempt or notice.
- Native rejection removed that permission and left the same tool in an error
  state without a completed read. The original turn was observably interrupted.
- One payload-free Relay notice reached a subsequent real model turn in the same
  native session. The completed delivery reply passed the raw exact-text check.
- Admission/context/turn/safe-idle phases were ordered. Three reconciliations
  retained both pending items without another attempt or notice. The target gate
  unlocked and there were no delivery read failures.
- Both recorded primary requests used the intended agent and chat route. The
  delivery request contained the notice; both observed response-model identities
  were `nvidia/nemotron-3.5-lightning:free`. This does not establish routing
  determinism.
- The installed archive's 27 files matched the checkout; 13 executed-source
  snapshots matched their recorded hashes. Session-delete readback and owned
  process, bridge, PTY, and private-profile cleanup passed.

### Historical failed epochs

The initial custom-tool attempt did not establish a permission hold: declaring a
permission option did not cause that gate's executor to request approval. Its
receipt remains `INCOMPLETE`; that gate was not used for the successful boundary.

The first built-in-read attempt established the real hold and rejection, but the
verifier incorrectly demanded a preparation reply after the runtime interrupted
that turn. Its original `PARTIAL` receipt and source snapshots remain unchanged,
including its misleading provider-refusal label. Current reporting distinguishes
native turn failure from provider refusal, and permission mode requires the
observed interrupted preparation outcome instead of inventing a reply.

The next execution reached post-refusal notice admission/context/turn but timed
out waiting for a completed model reply. It remains `INCOMPLETE`, separate from
the successful follow-up. Neither admission nor safe-idle evidence relabels a
failed exact-response epoch.

### Helper verification

The separate focused checks passed three Node tests and 12 Python checks across
four regression files, plus the package check. Coverage includes retaining the
native executor, exact-scope metadata-only observations, setup rollback, cleanup
fencing, incomplete/ambiguous permission identity rejection, pre-write authority
revalidation, completed-read rejection, observed interruption, and the existing
strict reply/notice-window decoders. These helper results are not native
qualification themselves.

### Remaining boundaries

This qualifies one built-in read permission case, not the full native permission
matrix, input-submission refusal, restart/uncertain recovery, real task
claim/acknowledgement, other required clients/platforms, or complete delivery.
The real UI, shipped runtime, installed agent configuration, Intercom, and
unrelated broker work were untouched by this spike. Changes remain local.

### Recommendation

Keep the failed and successful receipts distinct. Continue with native
input-submission refusal and restart/uncertain recovery in isolated sessions,
using the same real store/bridge/plugin and existing delivery checks. Do not
infer permission enforcement from tool metadata, turn an expected native
cancellation into a fabricated reply, or loosen the delivery exact-text check.
