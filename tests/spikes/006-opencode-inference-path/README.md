# 006 — OpenCode inference request path

## Question

When the controlled busy probe fails its exact-reply check, did the primary
request use the configured agent and chat protocol, retain both reply
instructions, and expose which model the free router returned?

## Approach

Reuse the [shared runner](../001-opencode-version-boundary/run.py), directly
installed Relay archive, real supervisor/store, and [busy context gate](../005-opencode-busy-boundary/README.md).
An optional [observer](observer.mjs) uses the version-pinned native
`http.request` and `http.response` hooks. It never replaces a request, response,
model, prompt, native method, or Relay callback.

The observer filters the exact disposable session and primary requests. It
records agent-match and instruction-presence booleans, message roles, protocol,
HTTP status, and the response stream's model identifier. Request headers,
message bodies, reply text, native session IDs, and destination URLs are not
captured. Response observation runs separately from the native consumer.

Capture is capped at eight requests, one response observation per request,
64 role labels per request, 128 KiB per inspected body, and a three-second
body-read deadline. Unexpected metadata values remain unknown rather than being
copied into the trace. Cancelling a cloned response's tee branch is not awaited:
that promise can depend on the original consumer. Hook setup rolls back on
failure; cleanup fences new callbacks and waits for bounded observations.
Private captures and executed-source snapshots remain outside the repository.

```sh
python -O tests/spikes/001-opencode-version-boundary/run.py \
  --expect delivery --packaged --plugin-source plugin-directory \
  --busy-context --trace-inference --opencode /absolute/path/to/opencode \
  --aperture-url "$APPROVED_FREE_API_BASE" --model openrouter/free
```

The trace flag requires the isolated busy-context/free-route mode. Live
input/output prices must explicitly be zero. No inherited provider credentials,
paid fallback, installed-profile changes, or public capture gallery are used.

## Verdict: PARTIAL

### What worked

The real OpenCode 2.0.27 run observed two primary requests:

- Both used the configured `relay-probe` agent, the chat endpoint, the selected
  `openrouter/free` route, and no tools. Both reply instructions were present
  in system messages.
- The preparation response reported `nvidia/nemotron-3-super-120b-a12b:free`
  and returned the exact preparation challenge.
- The delivery response reported `cohere/north-mini-code:free`. Its request
  contained the actual Relay notice in the same native session.
- Repeated busy-window reads showed no premature attempt or notice. The held
  context released normally. Native readback matched one Relay admission and
  excluded queued payloads.
- Admission, context, primary turn, and safe idle were persisted. The target
  gate unlocked, with one message and one work item still pending and no
  delivery read failures.
- Owned session deletion/readback, processes, bridge, PTY, and temporary profiles
  were cleaned up. The installed archive hash and all 12 recorded executed-source
  snapshots matched the private receipt.

Five observer tests passed: non-consuming inspection/privacy, capture/body
bounds, setup rollback, missing model metadata, and cleanup while the original
response is unconsumed. Both existing reply-reader regressions passed. The
package check retained nine public exports and 27 packed files with fixtures
excluded. These fixture checks qualify observer mechanics only.

### What did not pass

The delivery model acknowledged the pending-state counts and asked for further
instructions instead of returning the exact delivery challenge. The native
receipt remains `INCOMPLETE`; the three post-delivery unchanged-state
reconciliations were not reached. Neither acknowledgement text nor safe idle
turns that failed check into a successful run.

The earlier `User Safety: safe` output was not reproduced, so its specific cause
is not established. This run rules out missing reply instructions, a wrong
configured agent, and a wrong HTTP dialect for these two observed requests.
It also demonstrates different response-model identifiers across the two
requests; it does not prove the behavior of every free-router request.

The inspected approved catalog contained 14 entries. Only the variable
`openrouter/free` route declared explicit zero input/output prices. No fixed
model route met that price gate. Unknown prices and free-sounding names were
not treated as authorization for inference.

### Follow-up observer hardening

Separate regressions exposed three helper defects: cleanup could return before
an in-flight request capture finished, unexpected metadata objects/role values
could copy payload text into the trace, and duplicate response callbacks could
start additional stream readers. Each regression failed before its correction.

Both request and response captures now use the same tracked lifecycle. Metadata
is projected into bounded validated fields, and each request admits one response
observation. All eight observer tests and the package check passed.

This is a separate code/check epoch, not another native-model run. The original
receipt and executed-source snapshots remain intact; its `INCOMPLETE` verdict
and native qualification boundaries are unchanged.

### Successful follow-up native epoch

A later owner-approved `openrouter/free` run completed the exact busy-context
probe after observer hardening. Both primary requests retained the configured
agent and reply instructions. The preparation stream reported
`cohere/north-mini-code:free`; the delivery stream reported
`poolside/laguna-s-2.1:free`. Both turns returned their exact reply challenges.

Four busy-window samples showed no premature attempt or notice. Native readback
matched one notice to the same session and Relay admission; ordered observations
reached safe idle and unlocked the gate. Three unchanged-state reconciliations
kept one message and one work item pending without another attempt. Cleanup and
the archive/12-source-snapshot checks passed.

This is a new `VALIDATED` controlled-context receipt, not a relabel of the earlier
`INCOMPLETE` diagnostic run. The earlier safety-classification cause remains
unknown. Successful exact replies did not require a fixed response model; this
does not make variable-router behavior deterministic.

### Remaining boundaries

This is a read-only diagnostic execution epoch, not native adapter qualification.
Full D04/model-tool interruption safety,
hold/refusal, restart/uncertain recovery, claim/acknowledgement, other required
clients, and other platforms remain unqualified. Historical successful and
failed receipts are unchanged. Shipped runtime code, the real UI, Intercom,
installed agent configuration, and unrelated broker changes were untouched.
Changes remain local.

### Recommendation

Continue to actual model-tool busy-boundary, refusal, and restart qualification
with the owner-approved inference selections. Keep exact-reply checks intact
and retain every execution epoch. A fixed model is useful for reproducibility,
not a required missing input for the now-completed controlled-context probe.
Keep this observer optional and test-only; do not make the private gateway a
Relay dependency.
