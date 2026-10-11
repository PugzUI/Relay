# Verification

## Native execution

The regression suite passed with **105 tests, no failures or skips** on Linux
with Node.js **24.21.0** and **26.11.1**. Earlier local runs also exercised
Node.js 26.8.1. `npm run check` passed syntax, the nine public exports, strict
consumer declarations, required modules, and the actual package-file manifest.
The packaging check accepts the native npm 11 and npm 12 JSON layouts while
retaining identity, entry-count, required-file and private-artifact checks.

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

The committed [capture metadata](media/capture.json) records the actual browser,
runtime, measured viewport/document/pixel geometry, selected board and pane row
counts. It records no message body, token, session ID or private filesystem
path. The images contain only synthetic demo data.

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

## Open qualification boundaries

- **Native delivery:** WP1 froze a documentation/contract baseline only. All
  D01–D26 cases remain pending; no Relay native adapter, host configuration
  change, real agent-session delivery, or idle-turn observation was performed.
  The version snapshot in [delivery.md](delivery.md) is not a support matrix.
- **A21:** separately authorized physical two-host LAN/Tailscale exchanges.
- **A29:** actual private proxy/access-policy inspection and denied-third-device
  observations.
- Native process identity and launch qualification was performed on Linux;
  Windows, macOS and Termux are not certified by these runs.
- No paid model, real coding-agent runtime or existing agent session was used.
  Native launch evidence uses the harmless configured Node child protocol.
- Owner-specific artwork, additional presentation copy and visual approval are
  separate from the backend/runtime evidence. No unsupplied marketing hero,
  slogan, diagram or decorative asset is included.

Relay does not configure firewall, Tailscale, public ingress, certificates,
proxies or host services automatically. Local and loopback evidence must not
be described as production LAN/Tailscale certification.
