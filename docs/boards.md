# Boards

There is one authoritative store and one message table. A hub owns the shared
`bounty` board. Each device root owns `host:<device-id>`. A host-local board
does not move to the hub during an outage; disconnected global work remains
unavailable or uncertain as reported by the relevant operation.

Each board has two independent queries:

| Envelope | Stored state | Query | Behavior |
|---|---|---|---|
| `{msg: text}` | `posted` | `list({board, kind:"msg"})` | Append-only Inbox history; no lease, ack, queue claim, or job-slot use. |
| `{work: value}` | `pending` | `list({board, kind:"work"})` | Bounty/assignment work using normal claim, touch, ack, release, needs, and series rules. |

An envelope has exactly one `msg` or `work` key. Text such as `work: inspect`
remains Inbox text. Post `needs` and `series` require a work envelope. Kind is
derived at admission; it is not caller-selected.

Inbox reads do not change global state or consume entries. Reader position is a
local cursor. `data` is hidden by default and returned only when the caller
requests it and has the matching board/body permission. Permission and filters
apply before totals or pagination. Audit and topology streams contain metadata,
not Inbox/work bodies.

Board jobs share the same message, lease, receipt, and audit path as addressed
work. A successful claim has one current lease; release or expiry requeues the
job with a new lease on its next accepted attempt. `needs` compares with the
worker's registered capabilities. A series is enqueue-order serialization,
not a dependency graph. An earlier unfinished member blocks a later member;
callers post a successor only after its predecessor completes when success is
required.

The optional local Pool reserves capacity across local and hub authorities
before board claims. An uncertain remote result keeps the exact request and
reservation until the authority establishes the outcome. Inbox message claims
do not use board-job capacity. Raw `claim` is not a resource-availability
guarantee. Local child launch is disabled by default and uses only a fixed,
operator-configured recipe with a bounded budget and verified process
ownership.

Posted Inbox rows count toward retained message limits and seven-day terminal
retention. Retained send keys and RPC outcomes protect referenced rows. Reads
do not purge history. Details are in [limits](limits.md) and [API](api.md).
