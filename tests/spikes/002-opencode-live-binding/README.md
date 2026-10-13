# 002 — OpenCode native startup binding to a live Relay store

This preserves the historical 2.0.26 checkpoint below. The adapter now guards
2.0.27 and the shared runner's current binding mode requires that version.
See [003 — native delivery](../003-opencode-native-delivery/README.md) for the
later idle-path result; the original receipts and observations remain unchanged.

## Question

Given the unchanged Relay plugin and its supported OpenCode 2.0.26 runtime, when a real native setup event supplies an existing Relay mapping, does that exact native target become an active binding in the real Relay store?

This advances the startup-binding boundary only. It is not proof of native message/work delivery or product readiness.

## Approach

Reuse the [shared test-only runner](../001-opencode-version-boundary/run.py) rather than copy its lifecycle, storage, or transport implementation.

- Obtain the official `@opencode/cli-linux-x64@2.0.26` artifact in a private temporary directory, verify its published npm integrity, and run its extracted binary without global installation.
- Create a disposable HOME, project, authenticated loopback server, and real Relay store/supervisor with an enrolled worker session.
- Keep the message and work queues empty throughout the binding probe. No native prompt is submitted and no provider credentials are inherited.
- Load a package-directory observation wrapper around Relay's unchanged source plugin. Forward the real native context without replacing `session.get`, hooks, or the Relay bind callback.
- Read `listDeliveryBindings` through the existing storage engine. Require exactly one active row matching the authority, worker, Relay session, epoch, owner generation, native session, and profile.
- Independently read supervisor status and the exact native session's empty message list, then delete that session and verify HTTP 404. Stop owned processes and remove bridge artifacts and temporary profiles.

Run from the repository root on the qualified Linux x64 surface, with Node 24 or newer, Python's standard library, an existing private `TMPDIR`, and an explicitly selected supported binary:

```sh
python -O tests/spikes/001-opencode-version-boundary/run.py --expect binding --opencode /path/to/private/opencode-2.0.27
```

The current mode refuses any version other than 2.0.27. Reports and bounded logs remain private beneath `TMPDIR`, outside the shipped npm package and README gallery. Each report contains the actual runtime version, binary digest, dirty-checkout provenance, and source/fixture hashes. When launching through a sandbox, set the child's `TMPDIR` explicitly; sandbox defaults may point to ephemeral storage.

## Historical verdict: VALIDATED — startup binding only

### What worked

- The official pinned artifact matched the registry's published integrity hash.
- Native setup on 2.0.26 returned the plugin cleanup handle, with the exact configured session and required native methods present.
- The real store contained one active binding whose persisted mapping matched the registered Relay session and native target.
- Supervisor evidence changed to `wired`; its core showed one target, no locked target, and no delivery attempts.
- Both Relay queues stayed empty. The same disposable native session still had zero messages.
- Session deletion read back absent, and native/server/supervisor, bridge, and profile cleanup passed.
- The shared 2.0.27 rejection regression still passed: no binding, no attempt, and its disposable message stayed pending.

### What did not work or remains unverified

- Model-visible context, unattended idle turns, busy safe-boundary delivery, safe idle after a turn, native refusal, and restart recovery were not exercised.
- No work claim, completed handling, or acknowledgement occurred.
- The probe used an observation wrapper importing the source plugin; installing Relay's exported npm plugin subpath is a separate qualification boundary.
- OpenCode 2.0.27 remains rejected by Relay's unchanged guard. No other client or platform is qualified by this result.

### Surprises

The first pinned-runtime attempt stopped on a bootstrap HTTP 503 before session creation. The final run observed one transient bootstrap 503, then reached readiness within the existing deadline. The helper now retries only bootstrap 503s while its owned server is alive; authentication failures still fail immediately. This is fixture readiness handling, not a relaxation of Relay's production transport rules.

### Recommendation for the real build

Use the proven live-store binding as the starting point for separate native-delivery qualification. Verify packaged loading and a real model-visible notice/turn in that exact session before claiming delivery. Keep provider fixtures, queue receipts, and startup registration distinct from model receipt and completed handling.

The original rejection verdict and historical evidence remain intact. No shipped Relay code, installed agent configuration, Intercom integration, or production state was changed.
