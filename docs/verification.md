# Verification

## 2026-10-17: reviewed integration

The reviewed product tree passed **245/245 tests**, with no failures,
cancellations or skips, on Linux with Node.js **26.11.1** and npm **12.2.1**.
The same 245 tests and `npm run check` passed in a fresh export of the staged
files, without the unrelated local prototypes or tooling configurations.
Package checks covered 32 JavaScript modules, nine public exports, strict
consumer declarations and the 36-file package manifest. An actual npm archive
installed offline and passed package/plugin imports plus a durable work
claim-and-acknowledgement roundtrip.

This review added 15 regressions. Corrections separate explicit recipient reads
from background hub polling limits; cancel and bound recipient calls and
cleanup; reject malformed bridge UTF-8; prevent private token/registry reads
from blocking on named pipes; bound token/registry reads; impose a total bridge
request deadline; and preserve useful configuration validation errors. Earlier
SSE handshake and stable UI-row fixes remain included. The implementation
contract was reconciled with the current replay, Pool and asynchronous API
behavior.

The real-clock integration also passed **125 seconds of idle maintenance** and
**35 seconds of active-work lease maintenance**, then explicitly settled the
work. It uses actual SQLite, supervisor, private socket and plugin code with a
**fake native SDK**, without provider calls. This is not fresh native OpenCode
qualification, Node 24 certification or cross-host network qualification.
Native restart recovery and the other clients remain subject to the existing
qualification boundaries.

The [review receipt](media/review-2026-10-17.json) records source hashes, test
results and archive verification. Older receipts below are historical snapshots,
not claims about the current tree; their original source hashes and failed
native observations are preserved.

## Historical native execution

The regression suite passed with **105 tests, no failures or skips** on Linux
with Node.js **24.21.0** and **26.11.1**. Earlier local runs also exercised
Node.js 26.8.1. `npm run check` passed syntax, the nine public exports, strict
consumer declarations, required modules, and the actual package-file manifest.
The packaging check accepts the native npm 11 and npm 12 JSON layouts while
retaining identity, entry-count, required-file and private-artifact checks.

The later busy-boundary checkpoint passed **130 tests, no failures or skips**
and the package check, plus both focused Python reply-reader regressions.
Its new regression reproduced an uncancellable native wait before the fix and
now covers bounded busy/unknown status, pending-read limits, idle recovery, and
cleanup. The [real busy-context probe](../tests/spikes/005-opencode-busy-boundary/README.md)
separately observed deferral and preserved binding, but its exact-response checks
failed. Those original failed receipts remain unchanged.

A separate follow-up OpenCode 2.0.27 native epoch passed the complete controlled
context-boundary probe: four busy samples without an attempt/notice, exact
preparation and delivery replies in the same session, ordered native phases,
safe idle, and three unchanged-state reconciliations. Both queue kinds stayed
pending; the target gate unlocked without another attempt. Archive/source hashes
and owned-resource cleanup were verified. This is not a new full-suite result,
full D04/model-tool interruption proof, or complete adapter qualification. See
the [request-path evidence](../tests/spikes/006-opencode-inference-path/README.md).

A later [model-tool busy probe](../tests/spikes/007-opencode-tool-boundary/README.md)
used a genuinely model-invoked native tool, not an operator shell or held context
callback. Three running-tool samples preserved the binding and both pending queue
kinds with no attempt/notice. Normal tool completion, native result confirmation,
both exact replies, ordered phases, safe idle, three reconciliations, archive/source
hashes, and owned-resource cleanup passed. Two earlier failed reply receipts remain
unchanged. The separate focused run passed 25 Node tests and four Python checks
across three regression files plus the package check. A post-execution cleanup
correction removed an unrelated context-wait readback flag from tool mode; its
regression failed before correction and passed afterward without rewriting the
native receipt. This qualifies only the recorded controlled-tool
boundary, not full D04, native refusal/restart recovery, or complete delivery.

A subsequent [read-permission probe](../tests/spikes/008-opencode-permission-hold/README.md)
observed an actual native permission tied to the sole running read call. Four
held-permission samples preserved the binding and both pending queue kinds with
no attempt/notice. Native rejection removed the permission, interrupted that
original turn and left the same read call in an error state without a completed
read. A subsequent notice reached a real model turn and passed the raw exact
delivery-reply check, ordered phases, safe idle and three unchanged-state
reconciliations. There were no delivery read failures and the target unlocked.
All 27 installed package files and 13 executed-source snapshots matched;
owned-resource cleanup passed. Three Node tests and 12 Python helper checks
across four files passed separately, plus the package check. The earlier custom
gate, interrupted-preparation verifier and model-timeout epochs remain distinct.
This is one native permission case, not full input-submission refusal,
restart/uncertain recovery, real task handling or complete adapter qualification.

The executed cases cover durable admission and receipts, keyed conflicts,
process contention and recovery, session/epoch fencing, honest JSON, immutable
store roles, scoped enrollment and registration, local/hub capacity recovery,
native child readiness and exact-lease results, current-auth transaction gates,
scoped history and pruning, metadata-only feeds, and independent board panes.
Test names identify their acceptance cases; a passing suite is not a claim
that every subclause in the acceptance matrix or every deployment environment
has been exercised.

The basic, board, and recovery examples ran against disposable real stores.
The documented CLI flow was also exercised with a root containing spaces,
Unicode, literal dollar/percent characters and a backslash; ordinary reads
hid payloads and a missing-root list created no state.
The recovery example returned a new second attempt after expiry and persisted
its acknowledgement. The network example returned addressed, bounty, and
host-local acknowledgements through independent HTTP/HTTPS loopback
locations. Its certificate and all credentials were temporary; TLS verification
was not disabled.

A dedicated two-authority HTTPS view test verifies the host body's authority,
exact board/kind pages through the UI parser, separate viewer permissions,
fixed-view credentials rather than the viewer bearer, and an unavailable target
without a substitute local body page. Accepted reported topology remains usable
when a body view is unavailable.

## Rendered interface

The capture fixture (`tests/fixtures/ui/capture.mjs`) regenerates browser
metadata per run: actual browser, runtime, measured viewport/document/pixel
geometry, selected board and pane row counts. It records no message body,
token, session ID or private filesystem path. Captures go to an owned
temporary evidence directory, not a tracked gallery. The images contain only
synthetic demo data.

Native [browser checks](media/browser-qa.json) exercised:

- Authenticated selected-board Inbox and Bounties data at wide and narrow widths.
- Visible keyboard focus and reduced-motion styling.
- No measured document horizontal overflow or uncaught page runtime exceptions.
- Metadata-only access retaining topology with denied, empty private panes.
- Work-only access retaining Bounties while Inbox is denied.
- Actual credential revocation clearing cached private rows and selection.
- A real empty store, broker shutdown, and successful reconnect after restart.
- HTML-like posted text remaining inert text, with no executable image element.

The wide, narrow topology and narrow board captures were visually reviewed for
readability, hierarchy, wrapping, alignment and clipping. Recorded images are
not live telemetry or evidence of physical network deployment.

## Initial snapshot recovery

Nine additional regressions exercise native continuation cursors with no links,
reset-only recovery, a three-attempt limit, credential revocation during recovery,
non-retried refusals, hidden-tab cancellation, and late failures from obsolete
snapshot generations. The continuation producer now emits `null`, not an empty
string, for a collection that has no pagination marker.

A fresh headless Chromium profile exercised a native loopback broker with 513
synthetic agents, forcing a two-page snapshot. The comparison served the previous
UI controller and then the current controller against the same native broker.
An actual authenticated post between pages caused the native `503 reset`:

- Previous controller: `200, 503`, Unavailable, no topology and no event stream.
- Current controller: `200, 503, 200, 200`, Connected, all agents loaded, selected
  bounty Inbox Ready, Bounties Empty, and one event-stream request.
- A later committed post reached the Inbox through the recovered live feed.

The probe paced that later post by 1,100 ms to respect the existing request-rate
budget; it did not relax any broker limit. Both 1280 px and 390 px views had no
measured horizontal overflow or uncaught page runtime errors. The
[recorded observations](media/snapshot-recovery.json) use `requests` booleans to
indicate first-page (`false`) versus continuation (`true`) requests. The saved
[before](media/snapshot-before.png), [recovered wide](media/snapshot-after-wide.png),
and [recovered narrow](media/snapshot-after-narrow.png) images were visually
reviewed; all identities and posted text are disposable synthetic data.

## WP5a protocol parity checkpoint

On Linux x86_64 (Arch Linux, kernel 7.2.9-arch1-1), revision `d37b70ffdf6b49f900ec1502dbcaad6a988f16de` plus the recorded dirty `src/broker.mjs` bytes passed `npm run check` and `npm run test` on Node.js 26.11.1 / npm 12.2.0. The check validated 26 modules, nine frozen exports, declarations, imports and 26 packaged files; the suite passed 122/122 with no skips. The exact working-file and diff hashes are in [delivery qualification](media/delivery-qualification.json). Existing untracked user work was preserved and not content-hashed. No Node 24.21.0 executable was available in the installed system/version-manager locations inspected; no runtime was installed.

The disposable `basic`, `boards`, and `recovery` examples passed. `network.mjs` exercised two independent temporary stores and authorities, exact synthetic device-qualified workers, three `done` receipts, host HTTP loopback and hub HTTPS through a locally owned TLS terminator with the generated CA explicitly trusted; all owned listeners closed. This proves same-machine protocol mechanics, not physical multi-host connectivity. The full suite also executed the harmless Node child bootstrap/readiness/exact-lease protocol; no coding-agent session or paid provider was used.

A fresh Chromium 153.0.8010.52 profile authenticated to the actual loopback demo. The current-run capture measured 1440×1000, 1000×900, 390×844 and a scrolled 390×1200 board view; all had no horizontal overflow, Connected topology and Ready panes. Keyboard focus and reduced-motion behavior were observed, with zero uncaught runtime exceptions. A separate live broker-stop/restart probe observed `disconnected / Reconnecting` with cached rows, then Connected/Ready panes after the restarted disposable demo was reauthenticated. Both demo processes exited cleanly, their temporary tokens were removed, and the owned browser/processes and listener were stopped. Wide, narrow and scrolled-narrow captures were visually inspected in an isolated scratch mirror; committed screenshots were not overwritten and the temporary images were not published.

Permission-restricted panes, credential revocation, empty/inert-text behavior and the 513-agent snapshot-reset/live-feed recovery remain evidenced by the retained [browser QA record](media/browser-qa.json) and [snapshot-recovery record](media/snapshot-recovery.json). These artifacts were inspected, but their browser flows were not replayed in this checkpoint; the current-run browser observations above are separate. The machine-readable record distinguishes these sources and lists all remaining qualification boundaries.

## Direct installed OpenCode loader checkpoint

The [direct-loader spike](../tests/spikes/004-opencode-direct-loader/README.md)
installed an actual npm archive offline and selected its `src/adapters`
directory in isolated OpenCode 2.0.27 configuration. The native inventory
reported the Relay plugin active, and the real supervisor/store persisted
the exact recipient binding with queues and attempts empty.

A separate direct-delivery run observed one notice in the same previously idle
session, matching native admission readback, an exact completed model reply,
ordered context/turn/safe-idle observations, an unlocked target gate, and three
unchanged-state reconciliations with no repeated delivery or queue consumption.
No Relay observation wrapper, SDK override, or installed-archive overlay was
used. The independent idle-read and free-inference helpers are test-only.
Owned-session/process/bridge/profile cleanup passed. Original receipt hashes
remain attached to their execution epoch; later documentation edits do not
rewrite the executed archives or older evidence.

On Node 26.11.1 / npm 12.2.0, `npm run check` preserved nine public exports,
passed strict declarations and validated 27 package files with fixtures
excluded. The full project suite passed 129 tests with no failures or skips.
These checks do not qualify the remaining native matrix.

## Open qualification boundaries

- **Native delivery:** The delivery supervisor and first-party OpenCode plugin
  are implemented, but all D01–D26 cases remain pending. The later isolated
  OpenCode 2.0.27 probe installed a real npm archive, used its live Relay
  supervisor/store and exported plugin, matched notice admission to native
  message readback, and observed prepared context, primary turn start, an exact
  completed model reply, and persisted safe idle. Three further reconciliations
  retained the pending message without repeating delivery. The observation
  wrapper and free inference plugin are test-only. The subsequent direct-loader
  checkpoint above verified local archive directory configuration and idle
  delivery without wrapping Relay. Registry/Git package selectors,
  busy/refusal/restart behavior, and completed handling remain unverified.
  Earlier provider refusals and failed runs remain separate evidence. No
  installed-host configuration changed. Browser/store fixtures do not qualify
  native delivery. Public demos are deferred, not readiness gates.
  The version snapshot in [delivery.md](delivery.md) is not a support matrix.
- **A21:** separately authorized physical two-host LAN/Tailscale exchanges.
- **A29:** actual private proxy/access-policy inspection and denied-third-device
  observations.
- Native process identity and launch qualification was performed on Linux;
  Windows, macOS and Termux are not certified by these runs.
- Earlier launch evidence uses the harmless configured Node child protocol.
  The later native-delivery probe used a real disposable OpenCode runtime,
  without inherited provider credentials, paid fallback, or a real user session.
- Owner-specific artwork, additional presentation copy and visual approval are
  separate from the backend/runtime evidence. No unsupplied marketing hero,
  slogan, diagram or decorative asset is included.

Relay does not configure firewall, Tailscale, public ingress, certificates,
proxies or host services automatically. Local and loopback evidence must not
be described as production LAN/Tailscale certification.


## 2026-10-16: audited correctness and opt-in recipient consumer

On Linux with Node.js v26.11.1 and npm 12.2.0, the integrated working tree passed
`npm test`: **227/227 tests**, no failures, cancellations or skips.
`npm run check` passed syntax, the nine public exports, strict declarations,
UI bundle/license consistency and the 36-file package allowlist.
`git diff --check` also passed.

The added integration test uses real SQLite, supervisor, authenticated Unix
bridge and plugin code with a **fake native SDK**. It verifies addressed message
claim, a sender-scoped reply, explicit acknowledgement, a large JSON work item,
and the absence of acknowledgement merely from native turn completion.
The opt-in real-clock run passed 125 seconds of idle session maintenance and
35 seconds of active-work lease maintenance, then settled the work successfully.
It made no provider calls. That lifetime run preceded a final bounded
request-framing adjustment; the complete suite passed again afterward.

Regression coverage includes empty/full-journal replay, monotonic message
sequences after purge, board authorization during SQL pagination, exact notice
scope truncation, single-timer scheduling, confirmed nonacceptance, shared-hub
read budgets, addressed-work capacity/recovery/fairness, cancellation and native
bridge reconnection. The existing theme and unrelated local-profile changes
were preserved. No installed native profile or host service was deployed.

These results do **not** qualify a real OpenCode runtime, provider behavior,
other native clients, cross-host reachability or complete native restart
reconciliation. Existing native spike receipts and their limitations remain
unchanged. See [idle recipient consumption](idle-consumer.md) and the
[machine-readable implementation receipt](media/implementation-2026-10-16.json).
