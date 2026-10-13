# 003 — OpenCode native notice delivery

## Question

Given a real Relay supervisor/store and an already-bound idle OpenCode 2.0.27 session, when Relay commits a message, does its notice reach that same session's native context and a successful model turn without manual input?

## Approach

Reuse the [shared test-only runner](../001-opencode-version-boundary/run.py), not a second storage engine, wire protocol, or public demo command.

- Create a disposable HOME/project, authenticated loopback server, and enrolled Relay worker. Forward the real native PluginContext unchanged through a package-directory observation wrapper; do not replace native methods or the Relay bind callback.
- With `--packaged`, create an actual npm archive, check its identity and fixture exclusions, install it offline with scripts disabled, and run both the supervisor/store and exported plugin from the installed archive.
- Use an explicit inference route only after checking live availability and zero input/output pricing. Native OpenCode models additionally require every input/output/cache pricing range to be zero. No provider credentials are inherited and no paid fallback is allowed.
- An optional test-only inference plugin can connect OpenCode directly to an owner-approved OpenAI-compatible free gateway. It is outside the shipped package; Relay's native session commands never travel through that gateway.
- Configure a private agent with tool permissions denied and bounded generation. Require an exact completed reply challenge, not a substring quoted in a summary, generated tool syntax, or a truncated/error response.
- Await the real native SDK's `session.wait` before enqueueing. This method returns void and is not a `session.wait` HTTP endpoint on the inspected runtime.
- Commit one message through Relay's existing `send` path. No native primer, manual prompt, or additional session is used after binding.
- Match the stored admission ID to bounded native user-message readback. Require one notice-only message in the same session, excluding the queued payload, and all four ordered admission/context/turn/safe-idle timestamps.
- Reconcile unchanged pending state three further times. Require one terminal delivery attempt, an unlocked native target gate, and the original message still pending.
- Delete the disposable native session and verify HTTP 404, stop every owned process, and remove bridge credentials and private profiles. Reports and bounded logs stay beneath private `TMPDIR`, outside the npm package and screenshot gallery.

Run on the inspected Linux surface with Node 24 or newer, Python's standard library, a private `TMPDIR`, and an explicitly selected OpenCode 2.0.27 executable:

```sh
python -O tests/spikes/001-opencode-version-boundary/run.py \
  --expect delivery --packaged --opencode /path/to/opencode-2.0.27 \
  --aperture-url "$APPROVED_FREE_INFERENCE_URL" --model openrouter/free
```

The URL is an operator-selected test destination, not a Relay configuration field or runtime dependency. It must contain no credentials, query, or fragment. Redirects and inherited proxy settings are refused. Current inventory must advertise the selected chat endpoint and explicit zero prices; a `free` alias with absent pricing is refused rather than assumed free.

Without the gateway option, `--model opencode/ling-3.1-flash-free` selects the native provider and still requires live zero-price checks. Catalog availability does not guarantee successful inference.

## Verdict: VALIDATED — narrow archive-loaded idle path

### What worked

- The installed archive's plugin bound the exact native target through the real Relay supervisor/store, not a substitute callback.
- One Relay-committed notice reached that same previously idle native session. Its admission ID matched native readback and its text excluded the queued message payload.
- A real model returned the exact challenge with a completed `stop` result. Relay persisted ordered admission, prepared-context, primary-turn, and safe-idle timestamps.
- The target gate was released. Three further reconciliations produced no second attempt, and the original addressed message remained pending. Notification is not handling or acknowledgement.
- The final probe contained no SDK method overrides or diagnostic event subscriber. Native setup observation alone wrapped the installed exported plugin.
- The package check passed, and the project regression suite passed 123 tests with no failures or skips. The unsupported-2.0.26 rejection probe passed without admitting a native prompt. Owned-session/process/bridge/profile cleanup passed.

### Fixes driven by native evidence

- The supervisor sends a string notice, not `{text}`; the consumer and its fixture had agreed on the wrong shape.
- The real v2 stream emits `session.execution.succeeded|failed|interrupted`, not the legacy idle event expected by the fixture. The adapter now confirms the exact session's idle boundary through `session.wait` after those events.
- Context and turn bridge reports raced. Per-attempt reporting now captures each observation and serializes it before the next, preserving the state engine's transition order.
- A fixed synthetic native identity retained an unresolved cross-root gate across fixture runs. The store-backed fixture now uses a unique identity and completes its observation path before cleanup; it does not remove another run's exclusion token.
- A one-step native budget produced a step-limit summary containing the challenge. The final verifier allows a normal first turn and checks exact completed text instead of accepting a quoted substring.

### Historical failures and remaining boundaries

Post-probe cleanup hardening corrected the test-only inference helper to use the SDK's registration objects and `.dispose()` methods. Failed retry-hook setup now rolls back the provider transform; teardown attempts both registrations and preserves multiple failures. Nine focused tests passed, including normal teardown, startup rollback, and cleanup-failure cases. These are helper/bridge mechanics, not another native-model run. The original native receipt retains its original fixture hashes; the shipped adapter bytes and recorded idle-path observations are unchanged.

Earlier native-provider attempts returned deprecated-model HTTP 410 or `provider.auth` HTTP 403. Their original receipts remain intact. A later free-router model ignored the reply instruction and emitted tool-like text; no tool was allowed or executed, and the exact-response check rejected the run despite observed safe idle. Free routing is not deterministic model behavior, so failed receipts are not discarded or relabelled successful.

The gateway-free alias lacked explicit input/output pricing and was refused before native session creation. Other free-route names are not automatically accepted when their endpoint or pricing metadata differs.

The archive-loaded plugin was imported by an isolated package-directory observation wrapper. Direct published-package loader configuration, busy-tool/safe-boundary delivery, native hold/refusal behavior, restart/uncertain recovery, work claims and acknowledgements, the other required clients, and other platforms remain unqualified. D01–D26 remain pending as complete acceptance cases; no full adapter or product-release qualification follows from this spike.

### Recommendation for the real build

Use this proven idle path for the next bounded native busy-boundary and restart/refusal qualification stages. The separate [004 direct-loader checkpoint](../004-opencode-direct-loader/README.md) subsequently verified local installed-directory configuration and idle delivery without wrapping Relay; it does not rewrite this execution epoch. Keep the historical [001](../001-opencode-version-boundary/README.md) and [002](../002-opencode-live-binding/README.md) checkpoints intact. The real UI, Intercom, installed agent configuration, and unrelated broker work are untouched; these changes remain local.
