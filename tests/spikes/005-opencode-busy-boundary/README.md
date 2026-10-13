# 005 — OpenCode busy context boundary

## Question

Given the directly loaded Relay plugin and an exact existing OpenCode 2.0.27
session, does Relay defer both message and work hints while the native execution
is busy, preserve that binding, and deliver one notice after the busy boundary?

## Approach

Use the [shared runner](../001-opencode-version-boundary/run.py) and the installed
Relay archive, real supervisor/store, authenticated private bridge, and directly
loaded plugin. The [context gate](context-gate.mjs) is a test-only native hook:
it holds the initial preparation context until the controller releases it.
The native active API and exact-session message readback independently confirm
that the session is busy. No SDK method or Relay bind callback is replaced.

While that native context is held, commit one message and one work item through
Relay. Reconcile repeatedly and require no attempt, no native notice, and both
items still pending. Release the context normally, then require separate exact
preparation and delivery replies, native admission/context/turn/safe-idle
observations, and three unchanged-state reconciliations without another attempt.

The independent wait diagnostic requests abort after 200 ms and records the
native SDK's actual settlement. Reply-window regressions prevent an earlier
preparation reply from satisfying the delivery challenge. Raw reply text is
compared without whitespace trimming.

```sh
python -O tests/spikes/001-opencode-version-boundary/run.py \
  --expect delivery --packaged --plugin-source plugin-directory \
  --busy-context --opencode /absolute/path/to/opencode \
  --aperture-url "$APPROVED_FREE_API_BASE" --model openrouter/free
```

The inference URL is test-only and owner-approved. Live input/output prices
must explicitly be zero; there is no inherited provider credential or paid
fallback. This command creates private temporary profiles, captures, and owned
processes. It does not configure an installed profile or publish a gallery.

## Verdict: VALIDATED

This validates the controlled native **context** busy boundary only. It does
not validate model-tool interruption safety, full D04, or the whole adapter.

### Historical partial observations

- The original busy probe exposed a real binding loss. A native SDK wait resolved
  after 7,072 ms with its signal aborted by a timer scheduled at 200 ms. Relay's bridge command had
  expired, so completing that stale command ended the binding.
- The shipped plugin now races its own observation deadline instead of relying
  on SDK cancellation. It retains at most one pending native read per method,
  clears settled reads, and budgets read/submission time inside the bridge's
  command deadline. An overdue identity read reports unknown, not idle.
- Post-fix real native runs preserved the exact binding while both queue kinds
  remained pending. Four or five busy-window samples showed no attempt or
  premature notice; the context was released without interruption.
- After release, one notice reached the same native session with an admission ID
  matching Relay's record and without queued payload text. Native context and
  primary turn observations were persisted. One post-fix run also persisted
  safe idle and an unlocked target gate, with both items still pending.
- The isolated session was deleted and read back absent. Owned native/server/
  supervisor processes, bridge artifacts, PTY, and private profiles were cleaned
  up. Earlier idle receipts remain intact.
- The project suite passed 130 tests without failures or skips. Package checks
  preserved the nine public exports and 27 packed files with fixtures excluded.
  Focused coverage also checks bounded unknown reads, idle recovery, and cleanup
  while an uncancellable native wait is still outstanding.

### Historical failed reply checks

Earlier post-fix real-model runs returned `User Safety: safe` instead of the exact
preparation challenge. Their original receipts remain `INCOMPLETE`. They are
not successful exact-response runs, and their post-delivery unchanged-state
reconciliation phase was not completed. Observed admission or safe idle does
not turn a failed reply check into success.

The inspected alternative free-route catalog lacked explicit input/output prices;
cache-only prices or a free-sounding name do not satisfy the inference price
gate. No such route was used to bypass that gate.

### Follow-up idle confirmation hardening

A focused bridge/store regression exposed a second deadline edge: safe-idle
confirmation arriving after the short read deadline was discarded, retaining
the target gate without another execution event. The plugin now keeps one
passive idle observation per attempt without blocking the event feed. Late
callbacks after cleanup cannot mark the ended attempt safe idle.

The delayed-confirmation regression failed before that fix and passed afterward.
Additional coverage checks duplicate terminal events and cleanup before the
native wait settled. All 10 focused adapter tests and the package check passed.
This is a separate code/check epoch, not another real-native model run. Original
receipts, snapshots, and qualification boundaries remain unchanged.

### Successful follow-up native epoch

After the owner confirmed the approved Aperture aliases, a new directly loaded
OpenCode 2.0.27 run completed the entire controlled-context probe:

- Four independently observed busy-window samples retained one message and one
  work item, the exact active binding, and no delivery attempt or premature notice.
- The held native context released normally without interruption.
- Separate preparation and delivery turns returned both exact, unpadded reply
  challenges. Native readback matched one Relay notice to its admission in the
  same session and excluded queued payload text.
- Ordered admission, context, primary turn, and safe-idle observations were
  persisted. The target gate unlocked.
- Three further reconciliations retained both queue kinds without another
  attempt or repeated notice. Delivery reported no read failures.
- Owned session deletion/readback and process, bridge, PTY, and temporary-profile
  cleanup passed. The installed archive and all 12 executed-source snapshots
  matched the new private receipt.

The new receipt is `VALIDATED` for this narrow boundary. Earlier failed receipts
remain `INCOMPLETE`; no original execution epoch was relabelled. The optional
[request observer](../006-opencode-inference-path/README.md) recorded two
different response-model identifiers even in this successful run. A fixed model
was not a prerequisite for this result, and router compliance is not guaranteed.

### Remaining boundaries

This controlled native context loop is not a model-tool interruption experiment.
Full D04/model-tool interruption safety, hold/refusal, restart/uncertain
recovery, claim/acknowledgement, other required clients, and other platforms
remain unqualified. No adapter or full release qualification follows from this
narrow result. The real UI, installed agent configuration, Intercom, and
unrelated broker work remain untouched; changes remain local.

### Recommendation

Retain the deadline fix and every failed and successful execution epoch. Advance
to an actual model-tool busy boundary and native refusal/restart qualification
using only approved inference selections and without relaxing reply checks.

The later [request-path diagnostic](../006-opencode-inference-path/README.md)
observed both reply instructions in the correct primary chat requests and
different response-model identifiers between preparation and delivery. Its
preparation reply passed, but its delivery reply failed the exact check. This
separate failed receipt remains distinct from the later successful epoch above.
