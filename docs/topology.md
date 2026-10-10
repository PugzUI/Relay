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
snapshot. The stream is bounded and does not block a lease transaction. A
hidden tab pauses motion and displays current state after resynchronization,
not old events as current activity.

The UI is not present in the committed foundation. No screenshot or visual
review is available yet. The capture command is designed to use the integrated
UI at a loopback origin and a fresh temporary Chromium profile; wide/narrow
captures, runtime/version evidence, and visual review remain pending the real
backend/UI merge.

The topology grant is metadata-only. Inbox and work bodies require separate
permissions. Text is rendered as text, never HTML or terminal control. Board
queries filter by exact board and `msg`/`work` kind before totals or paging.
