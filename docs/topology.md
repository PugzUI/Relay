# Topology view

The view is one read-only topology page with the selected board's `Inbox | Bounties`
panes. It reads snapshots, committed metadata events, and scoped board pages;
it does not own Relay state. A topology snapshot contains stable device, agent,
board, link, authority, age, count, and pagination fields. It contains no
message/work body, session ID, credential, key, or filesystem path.

The functional overview uses locally bundled Lit Web Components, native SVG
links, and one external PugzUI stylesheet. Light DOM preserves native controls
and theme access without relaxing CSP. The existing controller and parsed Relay
state remain authoritative; components own rendering and local view preferences
only. See [UI decisions and source comparison](ui-decisions.md).

The summary rail shows scoped device/worker/board totals and explicitly labeled
visible busy-worker/active-link counts. A missing snapshot is unknown, not zero.
Select a device, worker or board for its inspector. Board selection also updates
the existing independent Inbox and Bounties panes. Filter by node identity or
capability; matches inside collapsed branches remain accessible. Clear the
filter to restore collapse preferences. Use Tab/Enter/Space on native controls,
up/down and Home/End within topology, left/right to collapse/expand, `/` to focus
the filter, and Escape to clear it. Expand all and Refresh are read-only actions.
Disconnect clears credentials, private views, cached pages and pending requests.

The viewer reconciles snapshots every ten seconds while visible, in addition
to committed feed hints, so report age/staleness cannot remain frozen on a quiet
connection. Quiet reconciliation preserves history nodes and selected text.
Hidden views cancel pending reads, retry waits and motion. Offline snapshots are
explicitly cached; revoked credentials clear them. A changed authority clears
the old board body scope before loading pages from the replacement store.
Successful snapshot recovery starts the feed without another Connect; failed
reads cannot reopen it using cached topology. Reconnects require a fresh snapshot.

The global feed observes committed audit rows and validated host reports. It
does not create a success pulse for a refusal, heartbeat, retransmission,
failed delivery, or replay. Reported host state includes receiver time and
staleness. Unknown capacity stays unknown; `free` means configured assignment
slots, not measured CPU/GPU availability.

Snapshot and feed cursors share a read boundary. A changed scope, broker
restart, expired cursor, ring overflow, or slow viewer may require a fresh
snapshot. If topology changes between initial snapshot pages, the view discards
the partial pages and retries from the first page, up to three attempts. Only a
native snapshot `reset` triggers this retry; other refusals stop the load.
Cancellation, a hidden tab, or a superseding connection stops the old load.
The stream is bounded and does not block a lease transaction. A hidden tab
pauses motion and displays current state after resynchronization, not old events
as current activity.

The internal browser verification fixture at `tests/fixtures/ui/capture.mjs`
uses the integrated UI at a loopback origin, submits a
private fixture token through the UI form, and waits for connected topology plus
nonempty Inbox and Bounties panes before saving wide and narrow topology views,
a narrow selected-board view scrolled into place, and runtime metadata. It checks
the live origin, selected board, pane row counts, measured viewport and document
width, visible keyboard focus, reduced-motion styles, and uncaught runtime
exception count. Metadata contains board and row counts but no pane bodies,
tokens, session IDs, or local paths. It requires an actual isolated Relay
broker; it does not mock UI responses. New captures go to an owned temporary
evidence directory, not the README or tracked image gallery. The retained images and
[capture metadata](media/capture.json) are from a real authenticated run.
Wide and narrow layouts were visually reviewed. Native browser checks also
exercised metadata-only and work-only permissions, credential revocation,
an empty store, actual broker stop/restart, and HTML-like text rendered inertly.

The topology grant is metadata-only. Inbox and work bodies require separate
permissions. Text is rendered as text, never HTML or terminal control. Board
queries filter by exact board and `msg`/`work` kind before totals or paging.

The additional isolated `tests/fixtures/ui/overview-qa.mjs` probe launches an
owned real store/broker and headless Chromium, verifies the new controls and
live SVG links, then exercises permissions, revocation, actual restart and
authority replacement, empty state, reduced motion and five viewport widths.
It retains private screenshots/metadata and closes its owned resources. This
is browser qualification with synthetic participants, not native-agent proof.
Development requires `npm ci --include=dev` and `npm run build:ui`; compiled
assets and third-party licenses ship in the package. `npm run check` verifies
that they match source. End users do not need Lit or esbuild installed.
The build stages every output before publication, replaces files by atomic
rename, and publishes the executable bundle after its licenses. A staging write
failure leaves the published assets unchanged and removes its temporary files.
Staging lives in `.relay-ui-build-*` at the repository root, outside the package
allowlist, so leftovers from abrupt termination cannot enter the release archive.
