# Verification

## Native execution

The regression suite passed with **95 tests, no failures or skips** on Linux
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

## Open qualification boundaries

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
