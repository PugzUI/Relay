# 001 — OpenCode native version boundary

This records the historical pre-migration result below. The current adapter now
guards 2.0.27; the shared runner rejects 2.0.26 instead. Earlier receipts and
observations are not rewritten. The later [003 delivery probe](../003-opencode-native-delivery/README.md)
is a separate idle-path result, not a retroactive qualification.

## Question

Given a real Relay store and delivery supervisor, when the unchanged Relay plugin loads in an isolated OpenCode 2.0.27 session, does it bind that exact native session?

This is a disposable rejection probe, not a demo, native-delivery qualification, or release gate. It does not alter installed agent configuration or Relay's shipped implementation.

## Approach

- Create a private temporary HOME, project, Relay store, and authenticated loopback OpenCode server.
- Register and join a real Relay worker through the existing engine; pass that mapping as native plugin options.
- Create one empty native session and read back its identity and empty message list.
- Load an observation-only package-directory wrapper around the unchanged Relay plugin. The wrapper records native setup fields and forwards the actual context without substituting a bind callback or overriding the version.
- Observe setup rejection before enqueueing a disposable Relay message. Refuse to enqueue if any native binding exists.
- Read the authoritative delivery status and native session again, then delete the session and verify HTTP 404 before stopping owned processes and removing private profiles and bridge credentials.

The current rejection command requires an explicitly selected unsupported OpenCode 2.0.26 executable, Node 24 or newer, Python's standard library, and an existing private `TMPDIR`:

```sh
python -O tests/spikes/001-opencode-version-boundary/run.py --expect rejection --opencode /path/to/private/opencode-2.0.26
```

The current rejection probe submits no prompt. The explicit `--expect binding` mode requires 2.0.27 and keeps both Relay queues empty; its historical predecessor is recorded in [002 — live binding](../002-opencode-live-binding/README.md). Only `--expect delivery` attempts a provider turn, after explicit zero-price checks. Reports and bounded logs remain in a newly created private directory beneath `TMPDIR`; neither goes to the README gallery. The report includes execution time, dirty-checkout provenance, and runtime/source/fixture hashes. The fixture is outside the npm package and normal test glob.

Safety checks remain active under `python -O`. Profile creation, version discovery, and server readiness share one cleanup boundary. Teardown attempts every owned resource, records cleanup failures without replacing the primary error, and returns a nonzero exit if cleanup is incomplete. API requests ignore proxy environment variables, and the native observation file is published atomically.

## Historical verdict: INVALIDATED

The unchanged plugin does **not** bind from native OpenCode 2.0.27. This verdict applies to that version and boundary, not to the feasibility of Relay's architecture or its pinned 2.0.26 implementation.

### What worked

- The real Relay store, owner fencing, delivery supervisor, and private adapter bridge started.
- Native OpenCode setup ran with version `2.0.27`, the exact configured disposable session, supplied options, and all four expected session methods present.
- The unchanged Relay plugin returned without a cleanup handle; authoritative state contained zero bindings and zero delivery attempts.
- One disposable message remained pending in Relay. The same native session still contained zero messages.
- Session deletion read back absent; the native interface, both owned server runs, supervisor, bridge artifacts, and temporary profiles were cleaned up.
- The final hardened probe and Node syntax check exited successfully.
- After the cleanup hardening, the native rejection probe also exited successfully under `python -O` with unusable proxy environment settings. Focused fault checks exercised failed version discovery, startup refusal, cleanup continuation, safety-check rejection under optimization, and child-exit races.

Hardening runs produce new receipts with the current fixture hashes; they do not rewrite earlier reports or promote this result to native-delivery qualification.

### What did not work

- Relay's exact `2.0.26` version guard rejects `2.0.27` before native registration.
- In an earlier probe, `2.0.27` rejected a configured plugin file path with `configured plugin path must be a directory`. An isolated package directory allowed setup to run. This does not establish whether Relay's exported npm plugin subpath installs correctly on that runtime.
- Initial fixture runs failed on owner-token length, API authentication, and loader configuration. Their reports remain private; they are not passing evidence.

### Surprises

- Documented file-path examples did not match the observed loader behavior. Native loader logs, not a populated interface or empty binding list, identified that boundary.
- Adapter capability flags remained present while evidence stayed `pending` and no native binding existed. Flags alone do not prove delivery.

### Recommendation for the real build

Keep the guard intact until the exact current runtime API and packaged plugin loading are qualified. Establish an isolated, supported-version plugin-to-live-store binding first. Then separately prove model-visible context, an unattended turn in the same idle session, busy safe-boundary delivery, refusal, and restart recovery. Do not substitute a new session, provider fixture, or synthetic worker receipt for those gates.

No provider prompt, context observation, model turn, safe-idle-after-turn, claim, or acknowledgement was exercised. Hermes and the other required native clients remain unresolved. Historical evidence and product readiness labels are unchanged.
