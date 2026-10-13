# 007 — OpenCode model-tool busy boundary

## Question

With a real model-invoked tool running in the exact existing OpenCode 2.0.27
session, does Relay defer message/work hints without interrupting that tool,
then deliver one notice after normal completion?

## Approach

Extend the [shared runner](../001-opencode-version-boundary/run.py), not Relay's
storage engine, protocol, CLI, or plugin implementation. Install the actual Relay
archive offline with scripts disabled and load its native plugin directory
directly. Use the real supervisor/store and authenticated private bridge.

The [test-only tool](tool-gate.mjs) is registered through the version-matched
native `ctx.tool.transform` API. Its owned profile exposes only this tool, with
one explicitly allowed permission. The actual model must invoke it; the
controller never calls its executor. The tool validates exact session, agent,
and nonce, permits one invocation, and waits at most 30 seconds for an owned
release marker. It launches no shell or external command.

Before committing Relay message/work, independently match the native assistant's
running tool record to its executor's call/message identifiers and verify the
exact session is active. Reconcile repeatedly while the tool is held; require no
notice, no attempt, both queue kinds still pending, and preserved binding. Then
release it normally and require native completion/result evidence, exact
preparation and delivery replies, ordered delivery phases, and safe idle. Three
further reconciliations must not repeat delivery or consume the queue.

The [free-provider helper](../003-opencode-native-delivery/free-provider.mjs)
keeps tools disabled by default. Only this mode opts in with a validated boolean.
The optional [request observer](../006-opencode-inference-path/README.md) observes
native requests without replacing them. Native tool results may be normalized
from strings into text-content arrays; both declared shapes are checked without
copying result text into observer records.

```sh
python -O tests/spikes/001-opencode-version-boundary/run.py \
  --expect delivery --packaged --plugin-source plugin-directory \
  --busy-tool --trace-inference --opencode /absolute/path/to/opencode \
  --aperture-url "$APPROVED_FREE_API_BASE" --model openrouter/free
```

The selected route must pass the live endpoint-dialect and explicit zero
input/output-price checks. No inherited provider credentials, paid fallback,
installed-profile changes, SDK replacements, or synthetic provider responses
are used. Captures and executed-source snapshots remain in owned private
scratch, outside the repository and shipped package.

## Verdict: VALIDATED

This validates one controlled, genuinely model-invoked native tool busy boundary
on the recorded isolated Linux/OpenCode surface. It is not full D04, arbitrary
tool coverage, complete native adapter qualification, or real work handling.

### What worked

- The real model invoked the sole registered tool. Native API readback confirmed
  the same call running in the active bound session.
- Three busy-window samples preserved the binding and both queue kinds, with no
  attempt or premature notice.
- Normal release completed the same tool once. Its native cancellation signal
  was not aborted; the execution-after hook confirmed the exact tool result.
- Separate preparation and delivery turns returned exact, unpadded challenges.
  One native notice matched Relay admission in the same session and excluded
  the queued payload.
- Ordered admission/context/turn/safe-idle phases were persisted after tool
  completion. The gate unlocked with no delivery read failures.
- Three unchanged-state reconciliations retained one message and one work item
  without another attempt or notice.
- All 12 executed-source snapshots and 27 packaged files matched the successful
  receipt. Owned session deletion/readback, process, bridge, PTY, and private
  profile cleanup passed.

The three primary request streams reported `poolside/laguna-s-2.1:free`,
`cohere/north-mini-code:free`, and `nvidia/nemotron-3-ultra-550b-a55b:free`.
These are observed response-model identifiers, not a deterministic routing claim.

### Historical failed epochs

Two earlier real-native runs also left their actual model-invoked tool
uninterrupted and delivered a notice afterward, but failed exact delivery replies:

- The first returned the preparation challenge again. Its execution-after
  observer also compared only string results, missing the SDK's legal normalized
  text-content-array shape.
- The second used the corrected bounded result-shape observer and returned the
  delivery challenge with leading blank lines. It remained a failed exact reply;
  whitespace was not trimmed. Its delivery response-model observation timed out
  and remains unknown.

Their original `INCOMPLETE` receipts and source snapshots remain unchanged. The
successful epoch added explicit latest-message and raw-output formatting
instructions to the isolated probe agent; it did not change Relay's notice or
weaken the reply checks. A regression reproduced the observer's result-shape
failure before correction.

### Helper verification

The focused run passed 25 Node tests covering the adapter, inference observer,
and new tool fixture, plus four Python checks across three regression files. Coverage includes
explicit tool opt-in, invalid input and recipient rejection, duplicate-call
refusal, native cancellation, plugin teardown, cleanup fencing, normalized tool
results, and rejection of padded final replies. The package check preserved nine
public exports and 27 files with fixtures excluded. These helper checks are
separate from the real-native execution epochs, not broader qualification.

A post-execution cleanup-bookkeeping correction stopped tool mode from recording
an unrelated context-wait observer readback. Context mode now requires its actual
observation file. The targeted regression failed before that correction and all
four Python checks passed afterward. This is a separate helper/check epoch;
the native receipts and their executed-source snapshots were not rewritten.

### Follow-up identity validation

A separate decoder regression reproduced false busy-tool confirmation when
both records lacked call/message identities, or supplied empty/non-string values.
The verifier now requires present, non-empty string identities, the expected
runtime/session, and exactly one matching tool call. Mismatched runtime/session
markers and additional calls also fail the busy-boundary check.

The regression failed before correction and passed afterward, alongside all
five Python checks across the three regression files. No new model inference
was run. The original native receipts and executed-source snapshots remain
unchanged; this helper hardening does not expand native qualification.

### Remaining boundaries

Full D04 across the required runtime/surface matrix, native hold/refusal,
restart/uncertain recovery, claim/acknowledgement, and other clients/platforms
remain unqualified. The real UI, installed agent configuration, Intercom, and
unrelated broker changes remain untouched. Changes remain local, not pushed.

### Recommendation

Retain all failed and successful epochs. Advance to native refusal and
restart/uncertain recovery using isolated sessions and the same real store,
bridge, and plugin path. Do not treat a controlled tool result as application
work completion, infer routing determinism, or loosen reply checks.
