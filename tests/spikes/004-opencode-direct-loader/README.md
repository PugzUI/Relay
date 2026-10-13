# 004 — Direct installed OpenCode plugin loading

## Question

Given an installed Relay npm archive and an isolated OpenCode 2.0.27 session, when OpenCode config selects the installed plugin directory directly, does the real plugin bind through the live Relay supervisor/store and deliver a notice to that same idle session without an observation wrapper?

## Approach

Reuse the [shared runner](../001-opencode-version-boundary/run.py). Install the actual archive offline with scripts disabled, and run both Relay's supervisor/store and native plugin from those installed bytes. Keep queues empty for the initial binding check; then run a separate bounded real-model idle-delivery check.

The direct selector is the installed Relay package's `src/adapters` directory. The root package remains the Relay library. `@pugzui/relay/opencode-plugin` remains a programmatic import, not an OpenCode package-target selector. Both select the same canonical `src/adapters/index.mjs`; there is no second plugin implementation or separate npm publication requirement.

For direct delivery, a separate test-only read observer confirms the exact session exists and awaits native `session.wait` before Relay sends. It neither imports nor wraps the Relay plugin, changes native methods, nor supplies a binding callback. The independent test-only inference plugin uses an explicitly zero-priced owner-approved route. Neither helper is shipped or required by Relay.

```sh
python -O tests/spikes/001-opencode-version-boundary/run.py \
  --expect binding --packaged --plugin-source plugin-directory \
  --opencode /path/to/opencode-2.0.27

python -O tests/spikes/001-opencode-version-boundary/run.py \
  --expect delivery --packaged --plugin-source plugin-directory \
  --opencode /path/to/opencode-2.0.27 \
  --aperture-url "$APPROVED_FREE_INFERENCE_URL" --model openrouter/free
```

Use a private `TMPDIR`, Node 24 or newer, Python's standard library, and an explicit executable. The second command needs the separately approved fixed free endpoint. No provider credentials, paid fallback, real user session, installed profile modification, or manual native prompt is used. Reports and bounded logs remain in private scratch, not the package or README gallery.

## Verdict: VALIDATED — direct local archive loading and idle delivery

### What worked

- OpenCode's native plugin inventory reported the real Relay plugin active from the installed directory, without a Relay observation wrapper or execution overlay.
- The authoritative Relay store recorded one exact native/Relay session mapping. The binding-only run left both queues and delivery attempts empty.
- In the separate delivery run, native readback matched the one admitted notice to the same previously idle session and excluded the queued payload.
- A real model completed the exact reply challenge. Relay persisted ordered admission, context, primary-turn and safe-idle timestamps; the target gate was released.
- Three further reconciliations produced no second attempt. The original addressed message stayed pending; no work claim, handling, or acknowledgement was inferred.
- Session deletion read back absent. Owned native/server/supervisor processes, PTY, bridge artifacts, and private profiles were cleaned up.
- `npm run check` passed on Node 26.11.1 / npm 12.2.0, preserving nine public exports and validating 27 packaged files with fixtures excluded. The full suite passed 129 tests with no failures or skips.

### Loader findings

The inspected runtime ignored the library root and the manifest-only adapter directory: both had no active binding. The export-subpath package target failed loading. A private prototype adding a canonical `index.mjs` entry loaded successfully; that overlay is separate experimental evidence, not package qualification. The final archive replaced the old internal entry with that canonical entry, retained one implementation, and passed direct binding and delivery without modifying installed archive bytes. Earlier failed and successful receipts remain intact.

### Follow-up reply-verifier hardening

The reply reader now compares raw completed text without trimming whitespace.
The [focused decoder regression](reply-reader.test.py) exercises the actual
reader with exact, padded, quoted, summary, truncated and errored responses:

```sh
python -O tests/spikes/004-opencode-direct-loader/reply-reader.test.py
```

The regression reproduced padded responses being incorrectly accepted, then
passed after the comparison was corrected. The original native reply contained
no padding, so its recorded verdict remains supported. Its receipt and recorded
source hashes remain unchanged; the later runner edit is a separate execution epoch.
These decoder checks and the passing package check are not another native-model
run or broader delivery qualification.

### Remaining boundaries

This verifies local archive installation and directory selection on the recorded isolated Linux/OpenCode surface, not an npm-registry or Git package selector, public publication, or other runtime/platform versions. Native busy-tool safe-boundary delivery, hold/refusal, restart/uncertain recovery, claims, acknowledgements, and other required clients remain unqualified. D01–D26 remain pending as complete acceptance cases. No full native adapter or release qualification follows from this spike.

### Recommendation for the real build

Use the directly loaded plugin for the next native busy-boundary and refusal/restart checks. Preserve the historical [001](../001-opencode-version-boundary/README.md), [002](../002-opencode-live-binding/README.md), and [003](../003-opencode-native-delivery/README.md) execution epochs. The real UI, Intercom, installed agent configuration, and unrelated broker work remain untouched; no changes were pushed.
