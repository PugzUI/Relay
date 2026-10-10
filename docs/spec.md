# Relay product specification

## Product

Relay is a standalone Node.js package and CLI for addressed worker messages,
board work, and one live topology view. A local SQLite store is the default.
An explicitly configured broker can serve that same store to authenticated
clients. One selected hub owns the shared bounty board and global addressed
messages; each host owns its local board. Each store has one authority and one
expiry clock. No queue or database is replicated.

The local quick start needs no account, listener, private catalogue, network
service, or existing home-directory configuration. Remote mode is optional and
operator-configured. Workers are registered as `<device>:<runtime>:<slot>`;
each session and lease is authority-specific, even when two stores contain the
same address. Device names and numeric slots are persisted and never silently
renamed or reused.

## Required behavior

- Multiple local processes share one SQLite store. Accepted enqueue, claim,
  acknowledgement, and RPC journal outcomes commit atomically.
- Sessions have monotonically increasing worker epochs. Claims have distinct
  attempt IDs and finite leases. Expired work can be retried, while stale
  sessions and attempts cannot complete a newer claim.
- Keyed sends have retained content fingerprints. An identical repeat returns
  the original receipt; changed addressed content returns a conflict.
- Messages accept exactly one explicit `{msg: string}` or `{work: JSON}`
  envelope. Body text never determines its kind. Board Inbox records are
  append-only and are not claims; board work uses the same lease engine as
  addressed work.
- The `bounty` board exists only on the configured hub. A `host:<device-id>`
  board exists only in that device's store. A network outage never creates a
  replacement bounty board or copies a local job.
- Board work eligibility requires a current session, board permission, free
  configured capacity, and all requested capabilities. Series serialize work
  in enqueue order; they are not dependency graphs or a workflow scheduler.
- A local pool can reserve capacity across local and hub authorities so an
  uncertain remote claim cannot cause a second assignment. Process launch is
  disabled by default. An enabled launch uses one operator-configured local
  executable recipe, an explicit budget, readiness registration, and verified
  process ownership for cleanup.
- Read-only inspection hides payloads by default, filters permission before
  totals or pagination, and uses stable cursors. Audit rows contain metadata,
  not message bodies.
- An optional same-origin HTTP/HTTPS broker runs only after explicit `serve`.
  It authenticates a principal for every request and applies exact worker,
  recipient, board, inspection, and session permissions. A client never opens
  the broker database.
- A lost network reply remains uncertain. The client may retry only the same
  request ID and content inside bounded journal/deadline limits. A replay never
  reopens a session or revives a stale claim.
- The topology page displays committed metadata, bounded host reports, and
  actual board state. Its global event stream contains no payloads. Board
  message/work bodies require separate scoped reads. The selected board shows
  peer `Inbox | Bounties` panes without consuming Inbox history.

## Store and authority

Use native Node SQLite through one adapter and one schema. Every handle applies
foreign-key and busy-timeout pragmas. On POSIX, create a private `0700` store
directory and `0600` owned state files; reject symlinked database/lock targets.
An unknown schema, corruption, permission error, busy timeout, or disk error
must not reset the store or return false success. Migrations are explicit and
backed up. `setup({root, device?, role?})` initializes a named device and host
board by default; a first hub setup requires an explicit device name and
`role:"hub"`, which creates `bounty`. The persisted role is immutable. An
ordinary mutating `open()` may initialize a host store, but broker startup
requires an already initialized store whose role matches its config. A
read-only open requires an existing store, does not create or migrate files,
and refuses mutations.

Store-wide lifetimes, retention, and capacities are persisted. Mutations use a
single high-water clock guard: a backwards wall-clock movement refuses
mutations while reads remain available. `init` is the immutable UTC epoch
millisecond record-creation time. It is neither a readiness flag nor launch
proof.

One transaction owns registration, slot allocation, admission, claim/touch,
acknowledgement/release, capacity reservation, and RPC journaling. Claim
expiry is inclusive (`now >= until`). Work can execute again after interruption;
callers must make external effects idempotent when duplication matters.

## Network boundary

`local` mode embeds the store without a listener; explicit local serving binds
literal loopback. `lan` requires one explicit local unicast address and valid
TLS trust. `tailscale` binds loopback behind operator-managed private HTTPS
proxying. Public ingress is outside scope. The default application port is
`4200`; occupied ports fail rather than selecting another port. The tailnet or
LAN boundary does not replace Relay credentials.

Credentials are separate high-entropy tokens per stable principal. Store token
digests, not raw tokens, in an owned permission registry. Never trust identity
headers, put secrets in URLs/argv/logs, follow redirects with credentials, or
disable TLS verification. Network requests have bounded bodies, headers,
deadlines, concurrency, rates, retries, pagination, and retained RPC receipts.
The broker rechecks scope before mutation and before delivering forwarded board
pages. Remote board reads use one fixed binding, one hop, no redirects, and
shared cancellation/deadline limits.

An authenticated host client may call `enroll(device)` on the hub. The hub
accepts only the exact device ID/name preauthorized for that principal and
returns an idempotent receipt. Enrollment grants no worker, session, board,
inspection, or launch rights. The local CLI enrollment command reads the
identity from the selected local root and the fixed hub binding from its
operator config; it sends no root path to the hub.

An isolated loopback HTTPS/proxy harness with synthetic principals and devices
can qualify wire parsing, credentials, scope refusals, RPC replay, redirects,
and resource bounds. It cannot prove two-host LAN reachability, private proxy
policy, or access from separately enrolled physical devices. Those deployment
claims require separately authorized two-host LAN and private-network runs.
No local harness result is described as physical-host qualification.

## View and presentation

The view is one read-only topology page with selected-board `Inbox | Bounties`
panes. Use native browser modules, SVG, and CSS. Keep the layout flat with
zero-radius corners, readable white/light-grey text, and lime only for real
activity. No nested cards, dashboard framework, kanban editor, message
composer, launch controls, fabricated traffic, or inferred hardware capacity.
Use stable ID placement, keyboard access, reduced-motion behavior, safe text
rendering, bounded streams, explicit stale/reset states, and no automatic
scrolling away from older Inbox history.

Presentation text, artwork, and screenshots are owner-controlled. Do not add a
subtitle, lead, hero caption, slogan, sales prose, invented empty-state copy,
or generated headline. Capture only real synthetic demo activity and real
receipts. A screenshot or backend feed does not itself establish visual
approval.

## Initial bounds and limits

- Session 120 s; claim 30 s, capped by session expiry; resume window 5 min.
- Send-key and RPC retention 24 h; terminal message retention 7 days; audit
  retention 30 days by default and never more than 30 days.
- Payload at most 64 KiB encoded UTF-8 JSON; 10,000 pending/claimed rows and
  128 MiB outstanding payload; 50,000 retained rows and 256 MiB retained
  payload.
- Page size defaults to 50 and is capped at 200. Device names are 1–63 ASCII
  letters/digits/dot/underscore/hyphen. Runtime names are 1–32 characters;
  numeric slots are zero-padded and at least three digits; worker addresses
  are at most 160 ASCII bytes.
- Needs/caps hold at most 16 unique validated tags. Series IDs are 1–64 ASCII
  characters. Keys are 1–128 UTF-8 bytes without NUL/control characters.
- Local SQLite busy timeout is 5 s; broker per-connection timeout is 100 ms.
  Network defaults: 8 KiB headers, 128 KiB request body, 1 MiB response,
  10 s operation deadline, 3 s connection deadline, 32 concurrent requests
  (8 per principal), 60 requests/minute/principal with burst 10, 3 exact
  retries, at most 256 credentials, bounded idle rate entries, and 100,000
  RPC rows / 32 MiB journal.
- Topology defaults: 64 devices, 512 agents per page, 32 KiB host reports,
  16 KiB deltas, 2,048 retained feed events, 8 streams, 64 KiB queued output
  per stream, 15 s keepalive, 10 s reports, and a 30 s stale boundary.
- Pool defaults: at most 8 agents and 1 held work item, 1 s poll interval,
  and 250 ms–10 s retry backoff; configured bounds and launch limits are fixed
  in the implementation contract. Local launch budget defaults to zero. No
  setting is a performance or physical CPU/GPU availability claim.

The exact public and cross-module contracts, persisted fields, principal
permissions, cursor/feed shapes, configuration, and lane ownership are frozen
in [the implementation contract](contract.md). Qualification scenarios are
listed in [the acceptance matrix](acceptance.md).

## Exclusions

No queue replication, peer mesh, broker federation, shared/network-mounted
SQLite, public ingress, DAG or general scheduler, automatic task decomposition,
model routing, runtime installer, arbitrary remote shell, plugin system,
automatic desktop input, arbitrary process launch, general dashboard, diagram
editor, or second state engine. Do not promise exactly-once external execution
or cross-platform support without platform-specific qualification. No live
existing-store migration is included.

## Ownership and licence

Relay's first-party implementation is owned by PugzUI and is distributed under
the MIT licence in `LICENSE`. The package identity is `@pugzui/relay`; this is
not a claim that the package has been published.
