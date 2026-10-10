# Topology view

The view is one read-only topology page with the selected board's `Inbox | Bounties`
panes. It reads snapshots, committed metadata events, and scoped board pages;
it does not own Relay state. A topology snapshot contains stable device, agent,
board, link, authority, age, count, and pagination fields. It contains no
message/work body, session ID, credential, key, or filesystem path.

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

The capture command uses the integrated UI at a loopback origin, submits a
private demo token through the UI form, and waits for connected topology plus
nonempty Inbox and Bounties panes before saving wide and narrow topology views,
a narrow selected-board view scrolled into place, and runtime metadata. It checks
the live origin, selected board, pane row counts, measured viewport and document
width, visible keyboard focus, reduced-motion styles, and uncaught runtime
exception count. Metadata contains board and row counts but no pane bodies,
tokens, session IDs, or local paths. It requires the actual disposable demo
server; it does not mock UI responses. The committed images and
[capture metadata](media/capture.json) are from a real authenticated run.
Wide and narrow layouts were visually reviewed. Native browser checks also
exercised metadata-only and work-only permissions, credential revocation,
an empty store, actual broker stop/restart, and HTML-like text rendered inertly.

The topology grant is metadata-only. Inbox and work bodies require separate
permissions. Text is rendered as text, never HTML or terminal control. Board
queries filter by exact board and `msg`/`work` kind before totals or paging.
