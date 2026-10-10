# Relay implementation contract

This is the frozen cross-lane contract for the first implementation. JavaScript
files use ESM and JSDoc; `src/index.d.ts` is the consumer API. Do not invent a
second queue, transaction owner, wire protocol, CLI state machine, cursor kind,
or permission model. Any necessary interface change must be agreed by affected
owners and updated here before implementation diverges.

## 1. Package and names

- Project/package name: `Relay` / `@pugzui/relay`, version `0.1.0`. This is a
  package identity, not a claim that the name is available or published.
- Runtime: JavaScript ESM, Node `>=24.0.0`; runtime dependencies: none.
  TypeScript is a development-only dependency for declaration checking.
- Storage and transport use Node native `node:sqlite`, `node:http`,
  `node:https`, `node:crypto`, and `node:child_process`; the UI uses browser
  modules, SVG, and CSS.
- Public spelling is `Relay`. `init` always means immutable record creation
  time in UTC epoch milliseconds.
- Public runtime exports are exactly `Fault`, `Relay`, `open`, `setup`,
  `Broker`, `serve`, `Client`, `connect`, and `LIMITS`. Public declarations
  also export the types in `src/index.d.ts`. Internal seams below are not
  re-exported from the package root.
- A local `open()` is synchronous and owns one SQLite handle. Remote `connect()`
  and server `serve()` are asynchronous. No function starts a listener except
  `serve()` / the explicit CLI `serve` command.

### Frozen public signatures

The declarations in `src/index.d.ts` are authoritative and must match these
signatures. `Relay` methods are synchronous; matching `Client` methods return
`Promise` of the same value. `Client.close()` and `Broker.close()` return
`Promise<void>`; `Relay.close()` returns `void`.

```ts
open(options: OpenOptions): Relay
setup(options: SetupOptions): Device
connect(options: ClientOptions): Promise<Client>
serve(options: BrokerOptions): Promise<Broker>
register(runtime: string, options?: { slot?: string; caps?: readonly string[] }): Agent
enroll(device: Device): EnrollmentReceipt          // local admin or remote hub enrollment
join(worker: WorkerAddress, options?: { replace?: boolean }): Session
resume(sid: string): Session
renew(sid: string): Session
leave(sid: string): EndReceipt
send(sid: string, to: WorkerAddress, envelope: Envelope, options?: { key?: string }): AdmissionReceipt
post(sid: string, board: BoardId, envelope: Envelope, options?: PostOptions): AdmissionReceipt
claim(sid: string, options?: ClaimOptions): Lease | null
touch(sid: string, lease: string): Lease
ack(sid: string, lease: string, outcome: AckOutcome): Receipt
release(sid: string, lease: string): ReleaseReceipt
get(id: string, options?: GetOptions): Message | null
list(options?: ListOptions): Page<Message>
stats(): Stats
audit(options?: AuditOptions): Page<AuditEvent>
report(sid: string, report: ReportInput): ReportReceipt
snapshot(options?: SnapshotOptions): Snapshot
purge(options: PurgeOptions): PurgeResult
```

`Envelope` is a disjoint union: `{msg: string}` or `{work: JsonValue}`. It
allows no other own keys. `msg` must be nonempty and is preserved exactly;
work-only `needs` and `series` are options to `post`, never envelope fields.
`JsonValue` accepts finite JSON primitives, dense arrays, and plain records only.
`Message.data` and lease body keys are omitted unless the caller has explicit
body permission. `send` has no board metadata. `post` returns the same persisted
admission fields as `send`. Empty `claim` is `null`, not a refusal.
`EnrollmentReceipt` extends the persisted `Device` fields with `repeat:boolean`.

Small return-shape decisions made explicit here: `leave` returns
`{sid,epoch,ended}`; `release` returns a `ReleaseReceipt` with outcome
`released`; a page includes the current position token as `cursor` and its
continuation token as `next`. These names make the end/requeue receipts
consumable without changing state rules.

## 2. Ownership map

No lane edits another lane's files. Shared contracts and public exports remain
frozen while lane work is in progress.

| Owner | Exact owned paths |
|---|---|
| Foundation | `package.json`, `package-lock.json`, `LICENSE`, `src/index.mjs`, `src/index.d.ts`, `scripts/check.mjs`, `.github/workflows/ci.yml`, `docs/contract.md`, `docs/acceptance.md`, `docs/spec.md` |
| CORE | `src/relay.mjs`, `src/schema.sql`, `src/sqlite.mjs`, `src/fault.mjs`, `src/validate.mjs`, `src/feed.mjs`; core, storage, board, device, and topology tests |
| NETWORK/POOL | `src/broker.mjs`, `src/client.mjs`, `src/auth.mjs`, `src/config.mjs`, `src/pool.mjs`; network and pool tests |
| CLI/DEMO/DOCS | `src/cli.mjs`, `examples/*`, `scripts/demo.mjs`, `scripts/capture.mjs`, `README.md`, `docs/api.md`, `docs/storage.md`, `docs/limits.md`, `docs/network.md`, `docs/boards.md`, `docs/topology.md`; CLI/example tests |
| UI | `ui/*` and UI tests |

Foundation created the package boundaries and contracts; lanes own only their
listed paths. `src/index.mjs` intentionally re-exports implementation modules
that do not exist yet. Until all lane modules land, package import is expected
to fail and `npm run check` reports the missing contract modules. No placeholder
implementation is exported as success.

## 3. Shared data and persistence

All times and durations in APIs are milliseconds. IDs are opaque strings.
`authority` is a random stable identifier for one store; it contains no path,
hostname, credential, or device name. Identical worker addresses at different
authorities are different principals for lease ownership.

### Records

| Record | Required fields and rules |
|---|---|
| Device | `{id,name,init}`; opaque ID, unique exact name and unique case-folded name; no implicit rename. |
| Agent | `{id,device,runtime,slot,caps,epoch,init}`; `id` is the canonical full address; epoch increases when a live identity is explicitly replaced. |
| Board | `{id,kind,device}`; exactly one `bounty` at the hub, or `host:<device-id>` in that device's store. |
| Session | `{id,worker,epoch,until,ended,principal}`; one current epoch per worker; remote sessions bind to one principal. |
| Message/job | `{id,seq,from,to,board,kind,needs,series,data,state,init,acked}`; one addressed worker or board target; exact single envelope; `kind` derived on admission; enqueue order is persistent. |
| Lease | `{id,mid,sid,epoch,until,attempt}`; a new ID for each accepted attempt; exactly one live attempt for a claimed row. |
| Receipt | `{mid,lease,sid,epoch,outcome,time}`; one accepted terminal acknowledgement for a leased item. Board Inbox admission uses its admission receipt and never invents a lease. |
| Send key | `{from,key,mid,hash,until}`; unique sender/key during retention; fingerprint covers target, board, exact kind/body, needs, and series. |
| Audit | `{seq,time,type,worker,sid,mid,lease,code,from,to}`; payload-free; `from/to` are stable endpoint IDs or null. |
| Meta | Schema version, immutable `init`, authority ID, device identity, immutable `role=host|hub`, persisted lifetime/retention/capacity policy, clock high-water mark, audit-pruned counts, and monotonic slot counters. |
| Principal binding | Hub-local exact device ID/name, principal ID, and permitted runtime namespaces. It is administration state, never supplied as an authority claim by a remote request. |
| RPC receipt | `{principal,rid,op,hash,committed,until,worker,sid,epoch,mid,lease,result_ref}`; unique principal/request ID; references outcomes and stores only minimal non-payload result metadata. |
| Capacity reservation | Exact `Reservation` in §7; unique active row per worker; keeps the authority, board, sessions, claim request, lease, and settlement request needed to recover uncertainty. |
| Launch record | Exact `LaunchRecord` in §7; unique launch request per device; persisted before spawn and retained while native process ownership or readiness is uncertain. |
| Report state | Device, current reporting session/epoch, last accepted report sequence and broker receipt time. Presence details are volatile and become unknown at broker restart until a new report arrives. |

One `messages` table stores both addressed messages and board entries. `data`
stores canonical JSON for exactly one `{msg}` or `{work}` envelope. Board Inbox
rows have `state=posted`, no lease, no ack, and do not use job capacity.
Addressed `msg` rows use ordinary claim/ack rules. Work rows use `pending`,
`claimed`, and terminal `done|failed|rejected` states. A released or expired
work row returns to `pending`; each retry has a fresh lease ID and increments
`attempt`.

Required indexes include `(board,kind,seq)` for pane paging, `(to,kind,state,seq)`
for addressed claims, a unique current session per worker/epoch, current lease
lookup by `(mid,state)`, sender/key expiry lookup, audit sequence, retained RPC
expiry, and a partial unique active reservation by worker. Foreign keys never
cascade-delete a row protected by a live claim, retained send key, or retained
RPC receipt. Retention cleanup checks references before deletion.

Opening applies `foreign_keys=ON` and the chosen `busy_timeout` on every
connection. Local/default timeout is 5,000 ms; broker connections use 100 ms.
The database is `<root>/relay.sqlite`; SQLite-owned WAL/SHM sidecars remain
beside it. Use WAL and `synchronous=FULL` for the local-disk store.
Fresh POSIX store directories are `0700`; owned database, lock, config, and
credential files are `0600`. Do not chmod unrelated parents. Reject symlinked
final database/lock targets. Unknown schema or failed integrity validation
refuses opening without replacing files. Migrations require a backup and an
explicit version step. No live existing-store import is implemented.

Mutations use `BEGIN IMMEDIATE`; read pages and snapshots use one read
transaction. The same persisted high-water guard applies to all mutation paths.
If wall time is below the saved maximum, return `clock` without mutation; equal
time is valid. Reads do not write the guard, expire claims, purge, or initialize
a missing root. `init` never changes on repeat or RPC replay.

### Device, address, and board invariants

- Device names are exact supplied values or the OS hostname captured once at
  setup: 1–63 ASCII `[A-Za-z0-9._-]`. Reject invalid fallback names. Preserve
  case; enforce case-folded uniqueness at the hub. Do not add suffixes.
- Runtime segments are 1–32 ASCII `[A-Za-z0-9._-]`. The full address is
  `<device-name>:<runtime>:<slot>`, at most 160 ASCII bytes. `prime` is reserved;
  numbered slots are positive, zero-padded decimal strings of 3–32 digits.
- Local numbered slots allocate monotonically in the store transaction. Never
  reuse a slot. A host registrar may register only its enrolled device and the
  runtime namespaces in its grant. Hub enrollment does not grant posting,
  claiming, inspection, or launch permission.
- `host:<device-id>` exists only on its owner's root. `bounty` exists only on
  the configured hub. A local view has no invented remote boards. The hub's
  host-board summary contains counts/age/authority only, never local payloads
  or ownership records.

## 4. Core method semantics

- `setup({root,device?,role?})` creates/validates the store and persists the
  first device identity and immutable role (`host` by default). A first hub
  setup supplies `device` explicitly. `open({root,device?,role?,sessionMs?,
  claimMs?,keyMs?,readOnly?})` initializes a missing store only when
  `readOnly` is false or omitted. `readOnly:true` requires an existing store,
  opens SQLite in native read-only mode, cannot create or reconfigure state,
  and refuses every mutating Relay method with `denied`. Existing role and
  persisted policy must match supplied options or return `input`. CLI reads
  use `open({root,readOnly:true})`; a missing store returns `missing` without
  creating its root.
- `join(worker,{replace?})` refuses a live session with `active`. Explicit
  replacement ends that worker session, increments its epoch, and releases its
  claims in one transaction. `resume(sid)` resumes only that exact unended
  current-epoch session within five minutes of expiry; expired owned claims are
  requeued before renewal. It never creates an identity. `renew(sid)` extends
  only a live session. `leave(sid)` ends only the exact session and releases its
  claims. No core heartbeat daemon exists.
- `enroll(device)` is hub-only. It atomically checks the exact device ID/name
  against the principal's separate `grant.enroll` allowlist, persists or reads
  back that device, and returns it with `repeat`. Repeating the same identity
  is idempotent; an ID/name collision returns `device_conflict`. Enrollment
  creates no agents, sessions, worker grants, or board permissions. An
  enrollment grant does not itself authorize `register`, `join`, or `claim`.
- `send` first verifies a known target. Offline known targets may receive queued
  messages. One transaction expires keys, resolves a retained sender/key,
  compares canonical fingerprints, inserts and reads back a message, inserts
  its key and audit event, and returns the persisted receipt. Matching key
  repeats return the original ID/init with `repeat=true`; changed input returns
  `key_conflict` without a row.
- `post` applies the same transaction to a board target. For `{msg}`, reject
  `needs` or `series`; append `posted` history without a lease. For `{work}`,
  persist needs/series and enqueue `pending`. Key hashes include board and all
  work metadata. Only one message row exists per post.
- `claim(sid)` selects the oldest pending addressed entry of the allowed kind
  for that worker. `claim(sid,{board})` selects only `work` on that board.
  Addressed control messages may use `kind=msg`; a board claim with `kind=msg`
  is `input`. One transaction expires eligible claims, validates session,
  capabilities and eligibility, moves one row to claimed, and inserts a new
  attempt. A board claim also checks series: the earliest unfinished member
  blocks later members even if its needs are not met. Two processes cannot
  accept the same attempt.
- `touch` extends the exact live lease only, never past the live session expiry.
  Extending a session does not extend existing leases. Expiry is inclusive:
  `now >= until` is expired.
- `ack` accepts only `done|failed|rejected`, a current live session/epoch, and
  the exact live owner/attempt. The first acknowledgement inserts a receipt and
  terminal state atomically. A same-outcome direct repeat returns the original
  receipt only after current-session/epoch validation; changed outcome is
  `ack_conflict`. External execution is at-least-once after interruption, not
  exactly-once. Retryable work uses `release`, not `failed`.
- `release` requeues only the exact unexpired owned attempt and writes audit in
  the same transaction. An expired or stale caller cannot change a newer
  attempt. `leave`/replacement also release only claims belonging to the exact
  session and epoch.
- `get/list` hide `data` unless explicitly requested and authorized. `to` and
  `board` filters are mutually exclusive. Totals and pagination are computed
  only after permission, target, board, kind, and state filters. No read
  performs expiry, cleanup, or initialization.
- `purge({before,dry?})` considers terminal records only. The effective cutoff
  is the earlier of the requested cutoff and the configured retention boundary.
  Never delete pending/live rows or a receipt/message reference protected by a
  retained send key or RPC receipt. A dry run and execution use the same
  bounded eligibility query. Expired keys may be removed after their lifetime.
- `stats()` separates Inbox history (`posted`) from work states. `audit()` is
  bounded and payload-free. Audit compaction removes only oldest eligible rows
  in a bounded batch and increments visible pruned counts. If audit capacity
  cannot be admitted, refuse the business mutation atomically with `full`.

Honest JSON encoding rejects cycles, sparse/extra-property arrays, non-finite
numbers, `undefined`, BigInt, functions, symbols, accessors, non-plain objects,
and unsupported prototypes. Object key order is canonicalized; array order and
literal values remain significant. Do not coerce or stringify unsupported
values into an accepted payload.

## 5. Principal and credential contract

### Token and registry format

The operator-owned credential registry is JSON, UTF-8, mode `0600`, with no
unknown fields:

```json
{
  "version": 1,
  "credentials": [{
    "principal": "host-east",
    "tokenDigest": "<64 lowercase hex SHA-256 characters>",
    "grant": {
      "enroll": [{"deviceId": "<opaque-id>", "deviceName": "east"}],
      "register": [{"deviceId": "<opaque-id>", "deviceName": "east", "runtimes": ["worker"], "allocate": true}],
      "workers": ["east:worker:prime"],
      "recipients": ["hub:worker:prime"],
      "boardPost": ["bounty", "host:<opaque-id>"],
      "boardClaim": ["bounty", "host:<opaque-id>"],
      "inboxRead": ["bounty"],
      "workRead": [],
      "inspect": {"messages": false, "receipts": false, "audit": false, "topology": true},
      "reportDevice": null
    }
  }]
}
```

The angle-bracket strings above are schema descriptions, not valid literal
identifiers. The registry has at most 256 credentials. Principal IDs are 1–64
ASCII `[A-Za-z0-9._-]` and remain stable across rotation. Each principal's
`register` grant contains zero or one device namespace so the frozen
`register(runtime, options)` signature resolves exactly one device without an
identity field in request arguments. A token is 32 random bytes encoded
base64url (43 characters);
the registry stores only its lowercase SHA-256 hex digest. Each principal has
exactly one active token digest. Rotation atomically replaces that digest;
overlapping old/new tokens are not supported. Duplicate principal IDs or
token digests, duplicate grant entries, unknown keys, invalid IDs, and wildcard
entries refuse registry loading. Compare fixed-length digest bytes in constant
time. Accept exactly one `Authorization: Bearer` value; reject duplicate
Authorization headers. Ignore claimed-user, forwarded, and proxy identity
headers.

Grant arrays are exact; `*`, prefix matching, hostname inference, and
implicit inheritance are invalid. `enroll` grants exact device ID/name pairs
on the hub. `register` separately grants only its device ID/name and listed
runtime names; `allocate=true` permits that authority to allocate local
monotonic numbered slots in that namespace. A remote hub registration always
supplies an explicit host-allocated numbered slot; remote registration never
allocates a slot or registers `prime`. This grant does not permit another
device or prime replacement. `workers` grants session/claim ownership for exact canonical
addresses. `recipients` controls send targets separately. Board post, board
claim, Inbox body, work body, and inspection grants are independent. A topology
grant returns metadata only. Remote purge, credential administration,
reassignment, and process launch are never wire operations.

The normalized grant shape is exactly the JSON `grant` object above. Empty
arrays represent no permission, `register` has at most one entry,
`reportDevice` is an opaque ID or `null`, and
`inspect` always has all four booleans. One device may appear in a hub
principal's `enroll` grant and in its host principal's `register` grant; those
permissions remain operation-specific. `RegistrySnapshot` is an immutable
`{version:1, credentials:[{principal,tokenDigest,grant,scopeKey}]}` value plus
an internal digest index. A `Principal` is exactly `{id,grant,scopeKey}`;
`scopeKey` is lowercase SHA-256 of canonical normalized grant JSON. No raw
token is retained. The broker loads a fresh complete snapshot at each auth
boundary; invalid, missing, or unsafe replacement denies that request and is
never replaced by a last-known-good snapshot.

`src/auth.mjs` cross-lane exports:

```js
loadRegistry(filePath) -> RegistrySnapshot
authenticate(snapshot, authorizationHeader) -> Principal
authorize(snapshot, principal, operation, args) -> Authorization
authorizeBoardRead(snapshot, principal, board, kind, includeData) -> Authorization
```

`loadRegistry` validates a complete immutable snapshot before returning it.
Invalid, missing, or unsafe replacement denies the current request; no
last-known-good grant remains active. The Broker revalidates the current
registry immediately before mutation dispatch and again in the synchronous
post-lock `beforeCommit()` gate. The gate defines the commit authorization
boundary: a revocation observed before that gate rolls back the operation and
RPC journal; a revocation after it does not undo already committed state.
Streams revalidate before every batch, and forwarded board pages revalidate
before delivery. Atomic digest replacement revokes the old token for new and
replayed requests without undoing committed state.

`Authorization` is `{principal: Principal, operation: RpcOperation,
scopeKey: string}`. It contains no raw token. `scopeKey` is a stable digest of
the current normalized grant and is used in cursors. The request body cannot
provide a principal, device identity, root path, permission, or authority.

authorize(snapshot,principal,operation,args) first verifies the principal
still exists in that snapshot, then validates the exact operation shape and
all statically knowable worker, recipient, board, and device scopes. It returns
the normalized Authorization; the core applies row-dependent read scope in
the same read transaction. In particular, get(id) first resolves only the
row's target/board/kind metadata and applies the principal's exact read grant
before reading body bytes. Out-of-scope and missing IDs both return null.
list, stats, and audit apply permission filters before totals or pagination;
callers cannot use an opaque ID or filter to broaden scope.

## 6. Config, wire, and RPC

### Broker config

`src/config.mjs` loads one operator-owned JSON document relative to its own
directory; paths inside it are resolved relative to that directory. Unknown or
duplicate keys, invalid types, out-of-range values, and ambiguous bindings
fail before opening a socket. The exact top-level object is:

```json
{
  "version": 1,
  "role": "host",
  "mode": "local",
  "listen": {"host": "127.0.0.1", "port": 4200},
  "tls": null,
  "allowedPeers": [],
  "credentialsFile": "./credentials.json",
  "hub": null,
  "pool": null,
  "views": []
}
```

`role` is `host|hub`; `mode` is `local|lan|tailscale`. `listen.host` is a
literal IP address, never a hostname: local and tailscale require literal
loopback; LAN requires one local unicast address and explicit exact peer-IP
allowlist. `listen.port` defaults to 4200; alternate ports are only for
isolated qualification. `tls` is `null` for local/tailscale and
`{certFile,keyFile}` for LAN. TLS private material is private-file validated;
client trust is configured by `ClientOptions.caFile`. `allowedPeers` is
required and nonempty in LAN mode; it is an exact
list of canonical unicast IPs, not CIDRs. Application credentials remain
required in every mode.

`hub` is null or `{url,tokenFile,caFile?}` and is allowed only on a host role.
The URL must be an HTTPS origin with no userinfo, query, fragment, or path.
`views` is an array of `{deviceId,url,tokenFile,caFile?,boards}` with unique
device IDs. URLs are fixed HTTPS origins with no userinfo/query/fragment/path;
board values are exact IDs. No URL or token path comes from a request, report,
job, or browser. A forwarding binding is read-only and cannot target arbitrary
external hosts.

`pool` is null or exactly:

```json
{
  "maxAgents": 8,
  "maxJobs": 1,
  "pollMs": 1000,
  "minBackoffMs": 250,
  "maxBackoffMs": 10000,
  "launch": null
}
```

`maxAgents` is 1–512 when configured (default 8); `maxJobs` is 1–128
(default 1); `pollMs` is 100–60000 (default 1000); backoff minimum is
100–5000 ms and maximum at most 60000 ms (defaults shown, with max >= min).
Only a `host` config may set `pool` to an object; a `hub` config requires
`pool:null` and never starts a Pool or child process. A host `serve()` starts
one Pool manager only when `pool` is non-null. The manager reconciles saved
reservations/launches before polling; it never starts a listener or child when
the section is null. `launch` is null by default (zero launch budget), or exactly
`{runtime,executable,args,cwd,capabilities,maxChildren,readyTimeoutMs}`.
`executable` is an operator-selected absolute file path, `args` is an array of
at most 32 fixed strings, `cwd` is an operator-allowed absolute workspace,
`capabilities` is at most 16 validated tags, `maxChildren` is 1–16, and
`readyTimeoutMs` is 1000–60000. Each argument is at most 1,024 UTF-8 bytes and
arguments total at most 8,192 bytes; each absolute path is at most 4,096 UTF-8
bytes. The launch never uses a shell and never takes an executable, argv, cwd,
environment variable, or capability from job data. Its child environment is
restricted to present values among `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`,
`WINDIR`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, and `TZ`. The runtime
adapter receives bounded newline-delimited JSON control frames on stdin and
returns bounded JSON readiness/result frames on stdout (§7). A launch consumes
budget from starting through verified exit; unknown readiness or native
ownership keeps the slot reserved and blocks relaunch.

`BrokerOptions` is exactly `{root,configFile}`. `serve()` parses and validates
the complete config before opening the store or binding, and requires an
already initialized store whose persisted role exactly matches `config.role`.
It never initializes a store or chooses a device name. First setup is explicit:
`setup({root,device,role:"hub"})` persists the named hub and its `bounty` board;
host setup defaults to `role:"host"`. Later `serve()` calls cannot change that
role. Public `open()` may create a store using the same immutable role option.
Broker acquires one exclusive `<root>/broker.lock` with an atomic create. Its
record is `{v:1,pid,processStart,nonce}`. On Linux, verify PID and process-start
identity before treating a lock as stale; never unlink a matching live owner.
If owner identity cannot be verified, fail `active`/`unavailable` and leave the
lock for operator review. Never use PID alone or delete an unverifiable lock.
On graceful close, stop admission, drain bounded in-flight work, close feed,
listener, client requests and DB handle, then unlink only the lock whose nonce
matches this Broker. Close is safe to repeat. Startup failure closes only
resources it acquired and preserves the original error.

### Request and response

All state routes require Authorization and same-origin use; CORS is disabled.
`GET /v1/health` is authenticated readiness/version only. `POST /v1/call` has
JSON content type, no content encoding, one body no larger than 128 KiB, and
this exact envelope:

```json
{"v":1,"rid":"request-id","op":"send","args":{"sid":"…","to":"…","envelope":{"msg":"…"},"options":{"key":"…"}}}
```

`rid` is 1–128 visible ASCII `[A-Za-z0-9._:-]`. `op` is one of `register`,
`enroll`, `join`, `resume`, `renew`, `leave`, `send`, `post`, `claim`, `touch`,
`ack`, `release`, `get`, `list`, `stats`, `audit`, `report`, `snapshot`, or the
internal read-only `attempt` operation. `attempt` accepts only `{sid,lease}`
and returns status for that exact attempt to its current owning principal; it
never returns a body or mutates state. `setup`, `purge`, `close`, filesystem
paths, SQL, reflection, and arbitrary method names are not wire operations.
`args` exactly matches the operation table in §9; unknown fields are refused.
Duplicate JSON object keys are refused. `kind` is derived from the accepted
envelope; caller-supplied `kind` is never accepted in an envelope.

Successful response:

```json
{"v":1,"rid":"request-id","ok":true,"result":{},"time":0,"replayed":false,"remainingMs":null}
```

Refusal response:

```json
{"v":1,"rid":"request-id","ok":false,"fault":{"code":"denied","message":"Operation denied"},"time":0}
```

`time` is broker time in epoch milliseconds. `remainingMs` is a nonnegative
integer only for a returned live claim, derived by the broker; otherwise null.
`replayed` is true only for a retained RPC journal hit. Fault context is
allowlisted and never includes payload, credential, private path, or stack.
Client validates version, exact request ID, JSON shape, IDs, result schema,
and remaining lease before resolving a call.

Reject duplicate Authorization, unknown headers only when ambiguous/security
relevant, duplicate envelope fields, malformed UTF-8/JSON, compressed bodies,
unsupported content types/schemes, endpoint credentials/query strings,
unexpected origins, redirects, late requests, and oversized streamed bodies.
Do not buffer an unbounded request before checking its size. Static `/` assets
may load without auth but contain no runtime state. Responses use
`Cache-Control: no-store` on state, board, and stream routes. No browser cookie
auth or secret in a URL.

### Atomic broker/core seam

The network owner must call the CORE-owned seam for every `/v1/call` operation;
it must not invoke a committing public method and then append an RPC receipt.
Exact internal signature and return shape:

```js
dispatchRpc(relay, { authorization, rid, op, args, beforeCommit }) -> {
  v: 1,
  rid,
  committedAt: number | null,
  replayed: boolean,
  result: operationResult,
  remainingMs: number | null
}
```

CORE owns one `BEGIN IMMEDIATE`, clock validation, operation dispatch, and
RPC-journal insert. `authorization.operation` must equal `op`; the principal
comes only from the current Broker-authenticated `Authorization`, never from
`args`. For a mutation it first admits journal capacity, checks a
retained `{principal,rid}`, compares SHA-256 of canonical `{v,op,args}`, then
executes the same internal operation handler used by `Relay` and inserts its
minimal receipt reference before one commit. Before a successful write or
matching replay result is returned, CORE invokes the trusted synchronous
`beforeCommit()` callback after `BEGIN IMMEDIATE` has acquired the SQLite write
lock and immediately before `COMMIT` or response release. A read invokes the
same callback after its scoped query and before ending its read transaction or
returning the result. The callback checks the original absolute request
deadline and reloads, authenticates, and authorizes against the current
complete credential registry. It requires the same principal ID and scope
digest used to compute this result. It throws
`timeout` if the deadline elapsed, or `auth`/`denied` if the credential was
revoked or the current grant no longer permits the exact operation. It returns
no authorization data and is never wire-controlled. A gate fault rolls back
application, audit, and journal writes together. No asynchronous timer or
pre-lock-only check substitutes for this callback. A matching repeat returns
the original operation result/reference with `replayed=true`; different
canonical content returns `rpc_conflict` without executing. Reads are not
journaled but use the final gate before results are released.

Before dispatch, the Broker validates auth/scope and constructs `beforeCommit`
from the in-memory Authorization header, exact request arguments, credential
file binding, and absolute deadline. The callback performs the post-lock
revalidation above. CORE binds every remote session to `principal.id` and
rejects a different principal's SID. The journal also records original worker, session, epoch,
message, and lease references needed to validate replay. `send/post` replay
returns original ID/init without adding a row. `join/resume/renew` returns only
the original same-epoch session outcome; a superseded epoch is refused. `claim`
replay returns body only if that exact attempt is still live/current; it never
claims a replacement. Terminal `ack/leave/release` replay returns its original
immutable receipt after principal, original owner, and non-superseded epoch
checks, even if the accepted operation ended/released that state. It never
reopens, re-acks, re-releases, or mutates a later attempt. A repeated `renew`
does not extend expiry again. RPC journal retention is 24 hours, 100,000 rows,
and 32 MiB of encoded receipt metadata. Admit room before mutation; `full`
means no mutation occurred. Purge cannot erase a retained referenced record.

On timeout/lost connection, the Client returns `uncertain` with the original
`rid`. It may retry that exact request at most three attempts inside one 10 s
deadline and the retained journal window. It never generates another request
ID to hide ambiguity. Once retry protection expires, return `uncertain` and
require inspection before a deliberate new operation. Broker/client connection
deadline is at most 3 s; request/operation deadline at most 10 s. Recheck the
remaining deadline immediately before mutation dispatch. A synchronous DB call
can block the event loop; the post-lock gate catches an elapsed deadline before
commit, and qualification must measure synchronous blocking latency.

## 7. Board pool, reservation, and launch seams

The src/pool.mjs controller is the only automatic board-work claimant. One
claim pass checks local addressed msg, hub addressed msg, the local host board,
then hub bounty. Message claims do not reserve job capacity. A worker may hold
at most one active board assignment across the local and hub authorities.
Direct Relay.claim() remains a raw lease API and cannot establish physical
resource availability; automatic board work uses Pool.

### Capacity reservation

Before a board claim, Pool reserves in the worker's local Relay store. CORE
owns the reservation rows and transactions and exports these exact seams:

```js
reserveCapacity(relay, input: ReservationInput) -> Reservation
bindCapacity(relay, input: ReservationBindInput) -> Reservation
listCapacity(relay, options?: { worker?: string }) -> Reservation[]
beginCapacitySettlement(relay, input: SettlementStartInput) -> Reservation
resolveCapacity(relay, input: ReservationResolveInput) -> null
```

Reservation is exactly:

```ts
interface Reservation {
  worker: WorkerAddress;
  localSid: string;
  remoteSid: string | null;
  board: BoardId;
  rid: string;
  authority: string;
  state: "reserved" | "held";
  mid: string | null;
  lease: string | null;
  epoch: number | null;
  until: number | null;
  settleRid: string | null;
  settleOutcome: AckOutcome | "release" | null;
}
interface ReservationInput {
  worker: WorkerAddress;
  localSid: string;
  remoteSid: string | null;
  board: BoardId;
  rid: string;
  authority: string;
  maxJobs: number;
}
interface ReservationBindInput {
  worker: WorkerAddress;
  rid: string;
  authority: string;
  lease: Lease;
}
interface SettlementStartInput {
  worker: WorkerAddress;
  rid: string;
  authority: string;
  settleRid: string;
  outcome: AckOutcome | "release";
}
type ResolutionProof =
  | { kind: "claim"; rid: string; authority: string; outcome: "empty" | "refused" }
  | { kind: "attempt"; rid: string; authority: string; mid: string; lease: string; epoch: number; state: "done" | "failed" | "rejected" | "released" | "expired" | "superseded" };
interface ReservationResolveInput {
  worker: WorkerAddress;
  rid: string;
  proof: ResolutionProof;
}
```

authority is the exact opaque ID of the store that owns the selected board.
For a local board remoteSid is null and localSid is used for the claim; for a
hub board remoteSid is the exact hub session. rid is generated before reserve
and remains the exact RPC request ID for retries. The row also persists the
selected board and session so a restart can reconstruct the original claim
arguments. There is one unresolved or held row per worker. An identical reserve
is idempotent; a changed tuple conflicts. Bind changes reserved to held only
after an accepted lease response and records its exact mid, lease ID, epoch,
and until. The core reads its own guarded transaction time; callers never
provide expiry time. `maxJobs` is the validated controller limit for this local
root, 1–128. In the same `BEGIN IMMEDIATE`, reserve refuses `full` when the
count of active `reserved` plus `held` board rows has reached that limit.
SettlementStart persists one settlement rid and outcome before ack/release
dispatch. Repeats must use that same tuple.

listCapacity returns every active row, including unresolved reservations. On
Pool start, each row is checked against the configured fixed local/hub
authorities; a missing or changed authority does not retarget work and remains
blocked as uncertain. For a reserved row, Pool retries the original claim with
the exact saved rid, authority, board, and session. For a held row, Pool checks
the exact saved lease with the internal attempt operation. It resolves only
after a definitive empty/refusal response or an authoritative terminal state
(`done|failed|rejected`), `released`, `expired`, or `superseded` attempt result.
A timeout, lost response,
client clock, or elapsed until alone is not proof and never frees capacity.
resolveCapacity verifies the proof's worker, request ID, authority, message,
lease, epoch, and state against the persisted reservation before deleting its
active row. `maxJobs` counts `reserved` and `held` board rows so uncertainty
cannot open a second slot. Direct addressed-message claims use the ordinary
claim API and never consume board capacity; they do not create a capacity row.
A held lease remains reserved until exact settlement or attempt expiry is
confirmed.

The read-only internal attempt operation has these exact shapes:

```ts
interface AttemptInput { sid: string; lease: string }
interface AttemptStatus {
  mid: string;
  worker: WorkerAddress;
  sid: string;
  epoch: number;
  lease: string;
  attempt: number;
  until: number;
  state: "live" | "done" | "failed" | "rejected" | "released" | "expired" | "superseded" | "unknown";
}
```

It returns null only when the exact lease is unknown. Otherwise it returns no
payload and confirms current principal/session ownership before exposing status.
unknown means the authority cannot establish a terminal state; Pool must keep
the reservation. This internal operation is available through the same
authenticated versioned call protocol but is not included in the public method
set or public-method `RpcOperation` mapping. The internal union is
`RpcOperation | InternalAttemptOperation`.

### Pool inputs and results

The Network/Pool owner exports these exact module contracts:

```js
createPool(options: PoolOptions) -> Pool
pool.claim(input: { worker: WorkerAddress; localSid: string; hubSid?: string }) -> Promise<PoolClaim | null>
pool.settle(input: { worker: WorkerAddress; item: ClaimedPoolItem; outcome: AckOutcome | "release" }) -> Promise<PoolSettlement>
pool.start(input: PoolWorkerInput) -> Promise<void>
pool.ensureCapacity(input: { primeSid: string; demand: number; readySpare: number }) -> Promise<LaunchRecord | null>
pool.close() -> Promise<void>
```

```ts
interface PoolOptions {
  local: Relay;
  hub: Client | null;
  maxAgents: number;
  maxJobs: number;
  pollMs: number;
  minBackoffMs: number;
  maxBackoffMs: number;
  launch: LaunchConfig | null;
}
interface LaunchConfig {
  runtime: string;
  executable: string;
  args: string[];
  cwd: string;
  capabilities: string[];
  maxChildren: number;
  readyTimeoutMs: number;
}
type ClaimedPoolItem = Extract<PoolClaim, { state: "claimed" }>;
type PoolClaim =
  | { state: "claimed"; kind: "msg" | "work"; rid: string; authority: string; board: BoardId | null; lease: Lease }
  | { state: "uncertain"; rid: string; authority: string; board: BoardId | null; mid: string | null; lease: string | null };
type PoolSettlement =
  | { state: "settled"; receipt: Receipt | ReleaseReceipt }
  | { state: "uncertain"; rid: string; authority: string; mid: string; lease: string };
interface PoolWorkerInput {
  worker: WorkerAddress;
  localSid: string;
  hubSid?: string;
  signal: AbortSignal;
  execute(item: ClaimedPoolItem, signal: AbortSignal): Promise<AckOutcome | "release">;
}
```

Pool obtains its canonical local store root through CORE's internal
`relayRoot(options.local)` seam. It returns only the open Relay handle's
immutable `StoreHandle.root`, refusing invalid or closed handles without
exposing the database or store object. It is not a public package export or
wire operation and never appears in snapshots, feeds, or board records.
Validate this root before reserving a launch or spawning its owned child;
only the child's private bootstrap receives it. Do not infer it from cwd,
task data, URLs, or Relay private fields.

`createPool` is internal and accepts one instance per local store. `serve()`
holds the store's broker lock and is the only network owner that may construct
the configured host Pool. A second Pool for the same `Relay` handle returns
`active`. `claim` performs one bounded arbitration pass in this order: local
addressed messages, hub addressed messages, the local host board, then hub
bounty. It never claims Inbox rows from a board. An unavailable hub before a
request is sent skips that source for this pass and local work remains
eligible. An uncertain submitted claim stops before another board claim.

`start` owns one sequential polling loop for the exact current local worker
session supplied by the caller; it does not join, replace, or renew that
session. The worker and session must be registered on `options.local`. It first
recovers that worker's saved board reservation, then passes one accepted lease
at a time to `execute`. It settles only the callback's explicit
`done|failed|rejected|release` result. If the callback throws, Pool attempts
`release` for that exact attempt, retains any uncertain reservation, and
rejects `start` with the callback error as primary. AbortSignal cancels the
poll wait and is passed to an active callback; the callback must settle or
return `release` before another item can be claimed. `start` resolves when
cancelled or closed.

Before a board claim, Pool reserves capacity on the worker's local store.
`maxJobs` counts all active `reserved` and `held` board rows across local and
hub authorities; message claims never consume this budget. An uncertain board
claim or settlement returns its original `rid` and authority and never emits a
second activity event. `settle` persists and reuses `settleRid` after a lost
response. Empty/refused claims and completed settlements resolve only their
matching reservations. `maxAgents` bounds the union of ready numbered local worker loops and launch
records in `starting|running|unknown`, deduplicating a running record and its
matching registered worker so one child consumes one agent slot. `prime` and stale/remote
reported capacity do not count as ready spare workers. Polling/backoff is
owned by Pool, jittered, bounded by the configured intervals, and cancelled by
AbortSignal or `close()`. Close stops only Pool-owned timers, requests, and
verified-owned child handles.

### Prime launch ledger

The launch ledger is part of the same CORE SQLite database. Network/Pool must
not maintain a second launch database or read Relay private fields. CORE exports:

```js
reserveLaunch(relay, input: LaunchReserveInput) -> LaunchRecord
listLaunches(relay, options?: { activeOnly?: boolean }) -> LaunchRecord[]
updateLaunch(relay, input: LaunchUpdateInput) -> LaunchRecord
```

```ts
interface NativeHandle {
  platform: string;
  pid: number;
  processStart: string;
  nonce: string;
}
interface LaunchRecord {
  id: string;
  device: string;
  primeSid: string;
  primeEpoch: number;
  runtime: string;
  requestId: string;
  recipeHash: string;
  capabilities: string[];
  state: "starting" | "running" | "unknown" | "exited" | "failed";
  handle: NativeHandle | null;
  worker: WorkerAddress | null;
  sid: string | null;
  epoch: number | null;
  readyAt: number | null;
  exitAt: number | null;
  exitCode: number | null;
  signal: string | null;
  init: number;
  changed: number;
}
interface LaunchReserveInput {
  primeSid: string;
  runtime: string;
  requestId: string;
  recipeHash: string;
  capabilities: string[];
  demand: number;
  readySpare: number;
  maxChildren: number;
}
type LaunchUpdateInput =
  | { id: string; from: "starting" | "unknown"; to: "running"; handle: NativeHandle; ready: { worker: WorkerAddress; sid: string; epoch: number; nonce: string; caps: string[] } }
  | { id: string; from: "starting" | "running"; to: "unknown"; handle?: NativeHandle }
  | { id: string; from: "starting" | "running" | "unknown"; to: "exited"; handle: NativeHandle; exitCode: number | null; signal: string | null }
  | { id: string; from: "starting"; to: "failed"; reason: "spawn" };
```

`ensureCapacity` validates demand and readySpare as bounded nonnegative counts
observed by this local Pool instance; remote reported `free` values never
contribute to readySpare. One call reserves and starts at most one child. It
returns null when launch is disabled, demand does not exceed ready spare, or
the configured agent/child budget is full. Otherwise it returns the persisted
record: `running` only after readiness, `failed` only when spawn provably never
created a child, or `unknown` when launch/readiness/ownership is ambiguous.
The caller refreshes ready spare and repeats if more capacity is still needed.

`reserveLaunch` runs inside BEGIN IMMEDIATE. It verifies that `primeSid` is
the current session for this store's registered `prime` worker and demand exceeds
readySpare. Network validates runtime, capabilities and recipeHash against the
exact configured recipe before calling this trusted internal seam; CORE does
not load or duplicate the network-owned configuration. CORE verifies that
counts are within 0–512, maxChildren is 1–16, and fewer than maxChildren
records for this device are in starting/running/unknown. It uses guarded store
time; callers never supply timestamps. `requestId` is unique per launch
request; an identical repeat returns its record, while changed input conflicts.
It writes the starting record before any child is spawned. The record binds the
current prime epoch, local device, runtime, exact capability set, and a digest
of the fixed executable/argv/cwd/capability recipe. Replacement or exit of the
prime does not erase children or free their budget. The `maxAgents` budget
also includes ready worker loops and active launch records; the one local Pool
controller checks that count before requesting a launch.

The launcher uses `node:child_process.spawn` with `shell:false`, the exact
configured executable, arguments, working directory, and allowlisted
environment. Its protocol is newline-delimited JSON with no extra
stdout/stderr logging:

1. Parent sends exactly one bootstrap frame on stdin:
   `{"v":1,"event":"bootstrap","id":"<launch-id>","nonce":"<random>","device":{"id":"<id>","name":"<name>"},"runtime":"<runtime>","capabilities":["<tag>"],"storeRoot":"<local-root>"}`.
   It is at most 8,192 encoded UTF-8 bytes and contains no job body or token.
2. The child opens that local store, registers one numbered worker with the
   exact runtime/capabilities, joins it without replacement, then emits one
   ready frame: `{"v":1,"event":"ready","id":"<launch-id>","nonce":"<same-random>","worker":"<canonical-address>","sid":"<sid>","epoch":1,"caps":["<tag>"]}`.
   The frame is at most 4,096 bytes. Parent and CORE verify nonce, launch ID,
   current session, epoch, local device, runtime, and exact capability set
   before marking the record `running` or assigning work.
3. For one accepted lease at a time, parent sends
   `{"v":1,"event":"execute","id":"<launch-id>","nonce":"<same-random>","authority":"<store-id>","board":"<board-id-or-null>","lease":{...Lease}}`.
   The encoded frame is at most `payloadBytes + 1,024` bytes. The worker
   performs the configured local task and emits
   `{"v":1,"event":"result","id":"<launch-id>","nonce":"<same-random>","lease":"<lease-id>","outcome":"done|failed|rejected|release"}`
   within 4,096 bytes. Parent matches every ID/nonce/lease before settling;
   the child cannot choose a recipient, authority, SQL operation, executable,
   or follow-up process. No second task is sent before the first settles.

Frames reject duplicate keys, invalid UTF-8/JSON, trailing values, unexpected
fields, and over-limit lines. The parent parses only bounded, valid stdout protocol frames, including
post-ready result frames, and drains and discards stderr. Malformed or
unexpected stdout is a protocol failure, not an ignored success. It never
logs child output, job data, token, or session ID.
The launch nonce and handle are private store state, not topology data.

The persisted handle is `{platform,pid,processStart,nonce}`. The platform
adapter must produce a stable process-start identity and reconcile it after
restart; a PID check alone is insufficient. Launch is refused before spawn on
a platform without that capability. The Linux adapter uses the process start
identity from `/proc` together with the boot ID; no Windows/macOS launch
support is claimed until equivalent reconciliation is implemented and
qualified. The adapter's reconcile operation must match all four fields to
prove ownership. On restart,
Pool calls reconcile for every starting/running/unknown record before counting
spare slots or launching again. A proven live handle updates to running; a
proven exit updates to exited; ambiguous or unsupported identity becomes
unknown and keeps the full child budget reserved. No PID-only signaling or
unrelated process cleanup is allowed. Stop/reap is permitted only for a
verified-owned child. If this platform lacks reliable identity/reconciliation,
the record remains unknown and launch stays blocked until operator resolution.

## 8. Topology snapshot, cursor, report, and feed

### Query cursors

`Page<T>` is `{items,total,visible,complete,cursor,next,firstSeq,pruned}`.
`total` is the exact permitted total at the page's captured upper sequence;
`visible` is this page's item count. `complete` is true when the stable result
has no continuation. `firstSeq` is the oldest retained sequence for that
board/kind (or null); `pruned` is its cumulative pruned count.

`ListOptions.after` and `AuditOptions.after` are opaque base64url-encoded
canonical UTF-8 JSON tokens, maximum 1,024 bytes decoded. Message token schema:

```json
{"v":1,"authority":"<store-id>","scope":"<sha256>","filter":"<sha256>","boundary":123,"last":100}
```

Audit token uses the same fields with `filter` fixed to the audit query.
Tokens are position/scope validators, never credentials. `scope` fingerprints
the current principal grant (local direct calls use the local scope); `filter`
fingerprints normalized target, board, kind, state, and page limit. The first
page captures `boundary=max(seq)` inside one read transaction. Later pages
require the same authority/scope/filter/boundary and seek `seq > last AND
seq <= boundary`; changing filters or grant returns `cursor`. Query defaults
to 50 and caps at 200. JSON/body permission is rechecked each page.

SnapshotOptions is {device?,limit?,after?}. A device filter is an exact opaque
device ID; limit defaults to 512 and caps at 512 for both agents and links.
A snapshot continuation token is unpadded base64url canonical UTF-8 JSON,
decoded maximum 1,024 bytes, with exactly:
```json
{"v":1,"authority":"<store-id>","scope":"<sha256>","filter":"<sha256>","boundary":123,"time":0,"last":{"agent":"<worker-or-null>","link":"<link-id-or-null>"}}
```

The first page captures maximum audit sequence and time in the same read
transaction as the feed cursor. All topology-visible changes append audit
before commit. Device/board rows are bounded by 64 devices and one board per
device; all are repeated on each snapshot page. Agents and links are sorted by
stable ASCII ID and seek after their respective last values. Totals are exact
within scope at the captured boundary. A continuation with changed scope,
filter, authority, or audit boundary returns reset; no cross-page mixed
snapshot is returned. complete is false only when another agent or link page
exists, and next is null exactly when complete is true. The cursor field
remains the independent live-feed cursor and is never the page token.

### Snapshot shape

`Snapshot` is one consistent JSON object:

```json
{
  "v": 1,
  "authority": "<store-id>",
  "time": 0,
  "cursor": "<feed-cursor>",
  "devices": [],
  "agents": [],
  "boards": [],
  "links": [],
  "totals": {"devices": 0, "agents": 0, "boards": 0, "links": 0},
  "visible": {"devices": 0, "agents": 0, "boards": 0, "links": 0},
  "complete": true,
  "next": null
}
```

Device rows contain `{id,name,init,authority,receivedAt,stale,free}`. Agent
rows contain `{id,device,runtime,slot,caps,epoch,init,state,assignmentCount,
receivedAt}`. Board rows contain `{id,kind,device,authority,inbox,pending,
claimed,terminal,reported,receivedAt}`. Link rows contain `{id,from,to,kind,
state,mid,time}`. Links represent only current live assignments or bounded
accepted report paths; IDs are stable relationship IDs, not lease or session
IDs. Historical pulses are delivered only as feed deltas. `state` for an agent is `registered|starting|ready|busy|
unknown|stale`; unknown capacity is null, not zero. `free` is configured idle
assignment capacity only, never measured CPU/GPU. Snapshot never includes
message/work body, SID, token, key, raw credential, or local filesystem path.
Totals are computed within the caller's metadata scope before pagination;
`visible` is the returned count. A hub may add only accepted enrolled-host
reports, with authority and receiver age. Restart clears remote presence to
unknown until a new report.

### Reports

`report(sid,{seq,agents,board,events?})` is accepted only from that registered
device's current reporting session and an authorized report principal. `seq`
increases strictly within the session. Each agent must be registered to that
device. Agent shape is `{worker,state,free,assignmentCount}`; `state` is
`starting|ready|busy|unknown`, `free` is null or 0/1, and assignment count is
0/1. Board shape is `{id,inbox,pending,claimed,terminal}`. `id` must be the
device's exact local board. Event rows are `{seq,type,from,to,mid,state,code}`;
`seq` is the source audit sequence, `type` is `post|claim|release|ack|refusal`,
and no body/session data is accepted. Cap report size at 32 KiB including JSON.
The receiver timestamps it with broker time; sender timestamps are ignored.
Return `{accepted:true,receivedAt,staleAfter,seq}`. Deduplicate host events by
device ID + reporting session + source audit sequence and validate endpoints.

### Feed and event cursor

`src/feed.mjs` exports:

```js
createFeed(relay) -> Feed
feed.snapshot(options, authorization) -> Snapshot
feed.subscribe({ cursor, authorization, signal }) -> AsyncIterable<FeedFrame>
feed.close() -> void
```

The feed tails committed audit rows, not only in-process callbacks. Direct
handles and accepted report events therefore appear after commit. Host-reported
events are validated/deduplicated before insertion into the hub's accepted
metadata feed. A failed/denied operation can be represented as a refusal but
never as a successful pulse. RPC replay, retry, heartbeat, and retransmission
create no extra success event. Persisted audit is the observation source; the
live feed uses a bounded in-memory ring, not another event database.

Feed cursor is unpadded base64url canonical UTF-8 JSON, decoded maximum 512
bytes, with exactly these fields:

```json
{"v":1,"authority":"<store-id>","stream":"<random-stream-id>","seq":123,"scope":"<sha256>"}
```

`stream` is random for each Broker start. Cursor binds the authority, current
feed instance, audit sequence, and current permission-scope digest. A scope or
stream change, cursor before the ring's oldest event, or overflow returns a
`reset` frame and requires a fresh snapshot. The snapshot cursor is a boundary
from the same read snapshot; subscribing from it cannot miss a committed
change. A feed frame is exactly one of:

```json
{"event":"delta","cursor":"…","data":{"v":1,"stream":"…","seq":123,"time":0,"type":"post|claim|release|ack|refusal","from":"…","to":"…","mid":"…","state":"pending|claimed|posted|done|failed|rejected|null","code":"<fault-code>|null","committed":true}}
{"event":"reset","cursor":"…","reason":"old|scope|restart|overflow"}
{"event":"keepalive","time":0}
```

Delta cap is 16 KiB; feed ring 2,048 events; at most 8 streams per broker;
64 KiB queued output per stream; keepalive every 15 s. Host reports arrive
every 10 s by default and become stale after 30 s. Slow streams are closed and
must resnapshot; feeds never block a lease transaction or grow without bound.
Streams do not consume one of the normal 10 s RPC slots. Reconnect uses bounded
backoff. A hidden tab pauses animation; it renders current state after
resynchronization, not historical pulses.

### HTTP view routes and board forwarding

- `GET /v1/topology`: authenticated scoped snapshot.
- `GET /v1/events?cursor=<one-token>`: authenticated SSE; use Fetch streaming
  with Authorization in memory, never native EventSource with a URL secret.
- `GET /v1/board?board=<one>&kind=msg|work&after=<one>&limit=<one>&data=0|1`:
  authorized page through the same `list` query. Reject duplicate/unknown
  parameters before store lookup or forwarding.
- `/` and packaged static assets contain no runtime state and may load before
  authentication. Same-origin CSP; no wildcard CORS or mutation GET.

Remote host-board reads use one fixed config `views` binding and only that
host's existing `list` operation. Intersect viewer board/body permissions with
the binding before dispatch, never forward the viewer token, share the original
request deadline/admission budget, disable redirects, and cancel owned outbound
resources. Validate returned authority, board, kind, cursor, JSON schema, and
bytes; recheck current viewer authorization before delivery. On revocation or
invalid registry, discard the response. Never accept a URL/root/token from a
browser, task, report, or work payload. A missing binding returns unavailable
or denied, never an empty successful page. Topology remains metadata-only.

## 9. Cross-module exports and fault behavior

The package root re-exports only its nine declared runtime values. These
internal contracts are not public root exports. Keep each implementation in
the owner path from §2; no consumer may reach through Relay or Client private
fields.

```js
// CORE: src/validate.mjs
validateAddress(address: string) -> { device: string; runtime: string; slot: string }
validateEnvelope(value: unknown, options?: { board?: boolean }) -> { kind: Kind; data: Envelope; bytes: number }
canonicalJson(value: unknown, maxBytes?: number) -> { json: string; bytes: number }
fingerprint(value: unknown) -> string // lowercase SHA-256 hex

// CORE: src/relay.mjs
open(options: OpenOptions) -> Relay
setup(options: SetupOptions) -> Device
openForBroker(options: { root: string; role: StoreRole }) -> Relay
relayRoot(relay: Relay) -> string
dispatchRpc(relay: Relay, call: RpcCall) -> RpcOutcome
dispatchLocalPool(relay: Relay, call: LocalPoolCall) -> RpcOutcome
inspectAttempt(relay: Relay, input: AttemptInput, authorization: Authorization | null) -> AttemptStatus | null

// CORE: src/sqlite.mjs
openDatabase(options: { root: string; create: boolean; readOnly: boolean; busyTimeoutMs?: number }) -> StoreHandle
withTransaction<T>(store: StoreHandle, mode: "read" | "write", fn: (tx: Transaction) => T) -> T

// CORE: src/feed.mjs
createFeed(relay: Relay) -> Feed
feed.snapshot(options: SnapshotOptions, authorization: Authorization) -> Snapshot
feed.subscribe(input: { cursor: string; authorization: Authorization; signal: AbortSignal }) -> AsyncIterable<FeedFrame>
feed.close() -> void

// NETWORK/POOL: src/auth.mjs
loadRegistry(filePath: string) -> RegistrySnapshot
authenticate(snapshot: RegistrySnapshot, authorizationHeader: string | string[]) -> Principal
authorize(snapshot: RegistrySnapshot, principal: Principal, operation: RpcOperation, args: object) -> Authorization
authorizeBoardRead(snapshot: RegistrySnapshot, principal: Principal, board: BoardId, kind: Kind, includeData: boolean) -> Authorization

// NETWORK/POOL: src/config.mjs
readConfig(configFile: string) -> BrokerConfig

// NETWORK/POOL: src/broker.mjs and src/client.mjs
serve(options: BrokerOptions) -> Promise<Broker>
connect(options: ClientOptions) -> Promise<Client>
invokeClient(client: Client, input: { rid: string; op: RpcOperation; args: object; deadline: number }) -> Promise<RpcOutcome>

// NETWORK/POOL: src/pool.mjs
createPool(options: PoolOptions) -> Pool
```

Shared internal schemas:

```ts
type PublicOperation =
  | "register" | "enroll" | "join" | "resume" | "renew" | "leave"
  | "send" | "post" | "claim" | "touch" | "ack" | "release"
  | "get" | "list" | "stats" | "audit" | "report" | "snapshot";
type InternalAttemptOperation = "attempt";
type RpcOperation = PublicOperation | InternalAttemptOperation;
type MutationOperation = Exclude<PublicOperation, "get" | "list" | "stats" | "audit" | "snapshot">;
interface Authorization {
  principal: Principal;
  operation: RpcOperation;
  scopeKey: string;
}
interface RpcArgs {
  register: { runtime: string; options?: RegisterOptions };
  enroll: { device: Device };
  join: { worker: WorkerAddress; options?: JoinOptions };
  resume: { sid: string };
  renew: { sid: string };
  leave: { sid: string };
  send: { sid: string; to: WorkerAddress; envelope: Envelope; options?: KeyOptions };
  post: { sid: string; board: BoardId; envelope: Envelope; options?: PostOptions };
  claim: { sid: string; options?: ClaimOptions };
  touch: { sid: string; lease: string };
  ack: { sid: string; lease: string; outcome: AckOutcome };
  release: { sid: string; lease: string };
  get: { id: string; options?: GetOptions };
  list: { options?: ListOptions };
  stats: Record<string, never>;
  audit: { options?: AuditOptions };
  report: { sid: string; report: ReportInput };
  snapshot: { options?: SnapshotOptions };
  attempt: AttemptInput;
}
type RpcCall = {
  [Op in RpcOperation]: {
    authorization: Authorization;
    rid: string;
    op: Op;
    args: RpcArgs[Op];
    beforeCommit: () => void;
  }
}[RpcOperation];
type LocalPoolCall =
  | { rid: string; op: "claim"; args: { sid: string; options?: ClaimOptions } }
  | { rid: string; op: "ack"; args: { sid: string; lease: string; outcome: AckOutcome } }
  | { rid: string; op: "release"; args: { sid: string; lease: string } };
interface RpcOutcome {
  v: 1;
  rid: string;
  committedAt: number | null;
  replayed: boolean;
  result: unknown;
  remainingMs: number | null;
}
interface RegistrySnapshot {
  version: 1;
  credentials: ReadonlyArray<{ principal: string; tokenDigest: string; grant: Grant; scopeKey: string }>;
  digestIndex: ReadonlyMap<string, string>;
}
interface StorePolicy {
  sessionMs: number;
  claimMs: number;
  keyMs: number;
  terminalRetentionMs: number;
  auditRetentionMs: number;
  pendingMessages: number;
  pendingBytes: number;
  retainedMessages: number;
  retainedBytes: number;
  auditRows: number;
  auditBytes: number;
  rpcRetentionMs: number;
  rpcRows: number;
  rpcBytes: number;
}
interface StoreHandle {
  root: string;
  file: string;
  db: DatabaseSync;
  authority: string;
  role: StoreRole;
  device: Device;
  policy: StorePolicy;
  readOnly: boolean;
  closed: boolean;
}
interface Transaction {
  db: DatabaseSync;
  now: number;
  mode: "read" | "write";
  authority: string;
}
```

Operation arguments contain only the exact fields shown below. Optional options
objects default to empty; unknown keys are refused. The return value is the
same schema as the named method in src/index.d.ts, except attempt returns
AttemptStatus or null:

| Operation | args | result |
|---|---|---|
| register | {runtime,options?} | Agent |
| enroll | {device} | EnrollmentReceipt |
| join | {worker,options?} | Session |
| resume / renew | {sid} | Session |
| leave | {sid} | EndReceipt |
| send | {sid,to,envelope,options?} | AdmissionReceipt |
| post | {sid,board,envelope,options?} | AdmissionReceipt |
| claim | {sid,options?} | Lease or null |
| touch | {sid,lease} | Lease |
| ack | {sid,lease,outcome} | Receipt |
| release | {sid,lease} | ReleaseReceipt |
| get | {id,options?} | Message or null |
| list | {options?} | Page<Message> |
| stats | {} | Stats |
| audit | {options?} | Page<AuditEvent> |
| report | {sid,report} | ReportReceipt |
| snapshot | {options?} | Snapshot |
| attempt | {sid,lease} | AttemptStatus or null |

All mutations above use the atomic RPC journal; read operations are not
journaled. Reads still authenticate and scope before returning any data.
dispatchRpc rejects a call whose authorization operation differs from op or
whose principal differs from the authenticated grant snapshot.

src/sqlite.mjs exports no store or transaction object to Network/Pool. It opens
the root-owned relay.sqlite file and applies `foreign_keys=ON` plus the selected
`busy_timeout` on every connection. Writable connections initialize/verify
WAL and set `synchronous=FULL`. A readOnly handle uses
`DatabaseSync(path,{readOnly:true})`, never creates a directory/database/WAL
or changes journal mode, and refuses write transactions. StoreHandle is private to CORE; the shape here
defines the only fields core files may rely on. withTransaction uses BEGIN for
a consistent read and BEGIN IMMEDIATE for mutation, validates the persisted
clock high-water mark for every write, and rolls back on any exception without
replacing the original fault. Read transactions never expire claims, update
the high-water clock, purge, or initialize data.

The same CORE transaction handler backs direct Relay methods, dispatchRpc, and
dispatchLocalPool. `dispatchLocalPool` accepts only the exact claim/ack/release
union in `LocalPoolCall`; it uses the journal key principal
`local:<store-authority>` and the supplied stable `rid`. It writes the same
bounded RPC journal as remote calls, but has no network credential or public
entry point. This gives a board reservation a crash-safe exact local claim and
settlement replay. `inspectAttempt(..., null)` is allowed only to code holding
that local Relay handle; a non-null Authorization applies remote principal and
session scope. Neither form returns a body.

For a mutation, dispatchRpc checks journal capacity, then the principal/request
key and canonical {v,op,args} hash, then calls that handler and inserts the
minimal receipt/result reference in one transaction. No public mutator call
followed by a separate journal write is allowed. RPC result references retain
the exact Device, Message, Session, Lease, or receipt outcome needed for replay.
A same-hash repeat returns the committed outcome with replayed=true and causes
no second activity event. A different hash returns rpc_conflict. A live claim
replay returns only the same still-current lease; terminal or superseded
attempts return an explicit stale/expired fault and never claim again. Terminal
ack/leave/release replay returns its immutable receipt after principal, owner,
and non-superseded epoch checks; it never reopens, re-acks, re-releases, or
changes a later attempt. Enrollment replay returns the original persisted
device receipt. Journal retention is 24 hours, 100,000 rows, and 32 MiB of
encoded outcome metadata. Admit space before mutation; full means no mutation.
Purge cannot delete anything referenced by a retained journal row.

The JavaScript call union is represented by the table above; the wire body
cannot carry a principal, authority, root, role, permission, filesystem path,
or clock. The remote attempt operation is restricted to the calling principal's
exact current worker session and lease. It returns no payload.

Client chooses one random rid for every public call. invokeClient accepts an
internal fixed rid and one absolute performance.now() deadline and retries at
most three times inside that same deadline. It never generates a replacement
rid. Pool passes the reserved rid for claim and the persisted settleRid for
ack/release. A lost result beyond the retry deadline is uncertain. A Broker
restart preserves journal and sessions; Broker time, not Client wall time,
decides expiry. Client.authority is learned from authenticated /v1/health and
is the exact store authority returned by that Broker.

connect({url,tokenFile,caFile?,mode?}) rejects userinfo, query, fragment,
unexpected path/origin, and unsupported schemes. HTTP is allowed only with
explicit mode:"local" and a literal 127.0.0.1 or ::1 URL. HTTPS keeps normal
certificate and hostname verification; caFile adds a per-client trust root.
Node24 Client and fixed-view forwarding use node:http.request or
node:https.request with explicit CA options. They do not use global fetch,
process-global TLS settings, or an agent that can follow redirects. Every 3xx
is rejected without resending Authorization. Request and response streams are
bounded while reading, cancellation destroys only the owned request/socket,
and one total deadline covers connect, write, response, and retries. The token
file is private (0600 on POSIX), contains exactly one 43-character base64url
token plus optional final newline, and is loaded into memory only. Never put it
in argv, URLs, persistent data, browser storage, diagnostics, or errors.
Client.close closes only resources owned by that Client.

The browser UI uses native fetch POST and ReadableStream for SSE. It keeps its
Bearer token only in memory, uses same-origin requests, disables redirects
where the browser API permits, and never uses EventSource, cookies, URL
secrets, localStorage, or sessionStorage. Server-side remote board forwarding
uses the fixed views binding with node:https.request and that binding's CA and
token only. It accepts only the exact board/list query, never forwards the
viewer's token, uses no redirects, shares the incoming deadline, bounds and
cancels output, validates authority/board/kind/cursor, and re-loads auth before
delivering the page.

Feed types are exact:

```ts
interface FeedDelta {
  v: 1;
  stream: string;
  seq: number;
  time: number;
  type: "post" | "claim" | "release" | "ack" | "refusal";
  from: string | null;
  to: string | null;
  mid: string | null;
  state: MessageState | null;
  code: FaultCode | null;
  committed: boolean;
}
type FeedFrame =
  | { event: "delta"; cursor: string; data: FeedDelta }
  | { event: "reset"; cursor: string; reason: "old" | "scope" | "restart" | "overflow" }
  | { event: "keepalive"; time: number };
```

A delta is emitted only from an appended audit row after commit. For post,
claim, release, and ack, committed is true and the event may create a success
pulse. A refusal audit row has type refusal and committed=false; it never
creates a success pulse. No FeedFrame includes bodies, SIDs, tokens, keys,
principals, or local paths. Feed authorization is rechecked before every batch
and keepalive.
The first snapshot's feed cursor and feed boundary are created in one read
transaction; subscribing from that cursor sees every later commit or a reset.
Feed output limits, cursor schema, and reset behavior are fixed in §8.

Fault is constructed as new Fault(code,message,context?) with public code and
context. Stable codes are input, data, missing, schema, active, session, expired,
target, device_conflict, board, key_conflict, ack_conflict, owner, lease, full,
busy, clock, storage, auth, denied, protocol, tls, rpc_conflict, uncertain,
cursor, reset, rate, timeout, and unavailable. Messages are short and safe.
Local diagnostics may retain a cause; wire faults contain only the code, safe
message, and explicitly allowlisted opaque IDs or retry timing. Never echo
payload, token, private path, certificate key, or stack.

## 10. Limits, test boundary, and qualification

`src/validate.mjs` is the only owner of the frozen `LIMITS` object. Every field
in the public `Limits` declaration is listed below; values are integers and
units are explicit. `open()` may persist caller-selected `sessionMs`,
`claimMs`, and `keyMs` within their listed ranges. All other store/network
limits are fixed. Broker config may select only pool values within their
listed ranges and listener/profile settings; it cannot raise any hard cap.

| `LIMITS` field | Default or fixed value | Accepted range / hard cap |
|---|---:|---|
| `sessionMs` | 120,000 ms | 1,000–3,600,000 ms |
| `claimMs` | 30,000 ms | 1,000 ms through selected `sessionMs` |
| `resumeMs` | 300,000 ms | Fixed |
| `keyMs` | 86,400,000 ms | 1,000–2,592,000,000 ms |
| `payloadBytes` | 65,536 bytes | Fixed canonical-envelope UTF-8 cap |
| `deviceNameChars` | 63 characters | Fixed; 1–63 ASCII allowed characters |
| `runtimeNameChars` | 32 characters | Fixed; 1–32 ASCII allowed characters |
| `slotDigitsMin` | 3 digits | Fixed lower bound; `prime` is separate |
| `slotDigitsMax` | 32 digits | Fixed upper bound |
| `pageDefault` | 50 rows | Fixed |
| `pageMax` | 200 rows | Hard cap |
| `workerAddressBytes` | 160 bytes | Fixed ASCII cap |
| `needsMax` | 16 tags | Fixed unique-tag cap |
| `tagCharsMax` | 32 characters | Fixed ASCII cap |
| `seriesCharsMax` | 64 characters | Fixed ASCII cap |
| `keyBytesMax` | 128 bytes | Fixed UTF-8 cap; no NUL/control characters |
| `pendingMessages` | 10,000 rows | Hard cap for pending + claimed work/addressed rows; posted Inbox rows are excluded |
| `pendingBytes` | 134,217,728 bytes | Hard cap for pending + claimed payload bytes |
| `retainedMessages` | 50,000 rows | Hard cap across all retained message rows, including posted Inbox history |
| `retainedBytes` | 268,435,456 bytes | Hard cap across retained payload bytes |
| `terminalRetentionMs` | 604,800,000 ms | Fixed 7-day maximum age for eligible posted/terminal rows |
| `auditRetentionMs` | 2,592,000,000 ms | Fixed 30-day maximum age |
| `auditRows` | 100,000 rows | Hard cap |
| `auditBytes` | 33,554,432 bytes | Hard cap for encoded audit metadata |
| `rpcRetentionMs` | 86,400,000 ms | Fixed 24-hour maximum age |
| `rpcRows` | 100,000 rows | Hard cap |
| `rpcBytes` | 33,554,432 bytes | Hard cap for encoded RPC result metadata |
| `headerBytes` | 8,192 bytes | Hard cap |
| `requestBytes` | 131,072 bytes | Hard cap including framing; payload retains its separate 65,536-byte cap |
| `responseBytes` | 1,048,576 bytes | Hard cap; paginate before encoding exceeds it |
| `requestDeadlineMs` | 10,000 ms | Fixed whole broker request deadline |
| `clientDeadlineMs` | 10,000 ms | Fixed whole client operation deadline, including retries |
| `connectionDeadlineMs` | 3,000 ms | Fixed connection sub-deadline within client deadline |
| `busyTimeoutMs` | 5,000 ms | Fixed local SQLite timeout |
| `brokerBusyTimeoutMs` | 100 ms | Fixed broker SQLite timeout |
| `concurrentRequests` | 32 requests | Hard broker-wide cap |
| `concurrentPerPrincipal` | 8 requests | Hard per-principal cap |
| `ratePerMinute` | 60 requests | Fixed per-principal rolling minute rate |
| `rateBurst` | 10 requests | Fixed per-principal burst |
| `snapshotDevices` | 64 devices | Hard cap |
| `snapshotAgents` | 512 agents | Hard page cap |
| `reportBytes` | 32,768 bytes | Hard encoded report cap |
| `eventBytes` | 16,384 bytes | Hard encoded feed-delta cap |
| `feedEvents` | 2,048 events | Hard in-memory ring cap |
| `feedStreams` | 8 streams | Hard per-broker cap |
| `streamQueuedBytes` | 65,536 bytes | Hard per-stream queued-output cap |
| `keepaliveMs` | 15,000 ms | Fixed interval |
| `reportIntervalMs` | 10,000 ms | Fixed suggested report interval |
| `reportStaleMs` | 30,000 ms | Fixed stale boundary |
| `maxCredentials` | 256 credentials | Hard registry-entry cap |
| `rateIdleMs` | 120,000 ms | Fixed idle-entry eviction age; limiter map is also capped at `maxCredentials` |
| `poolMaxAgents` | 8 agents | Configurable 1–512; includes ready, starting, running, and unknown numbered local workers, not `prime` |
| `poolMaxJobs` | 1 assignment | Configurable 1–128; held board assignments across both authorities |
| `poolPollMs` | 1,000 ms | Configurable 100–60,000 ms |
| `poolMinBackoffMs` | 250 ms | Configurable 100–5,000 ms |
| `poolMaxBackoffMs` | 10,000 ms | Configurable 100–60,000 ms and not less than minimum |
| `launchMaxChildren` | 16 children | Hard cap; effective default budget is 0 because `launch` defaults to null; enabled config selects 1–16 |
| `launchReadyTimeoutMs` | 10,000 ms | Configurable 1,000–60,000 ms when launch is enabled |

The fixed client retry ceiling is three attempts of the exact original request;
it is bounded by the one 10,000 ms deadline and does not extend lease expiry.

`npm run check` checks JavaScript syntax, strict TypeScript declarations,
package contents, and presence of all frozen contract modules. It never invokes
`npm test` or Node's test runner. `npm test` is the separate automated test
entry. `npm run demo` and `npm run capture` are bounded synthetic/demo
entrypoints and must use actual Relay operations/receipts, not fixture output.
Tests and demo capture use disposable temporary roots, loopback-only listeners,
ephemeral TLS/proxy identities, bounded timers, and `try/finally` cleanup.
Cleanup closes only handles/processes created by that test and preserves the
primary failure while reporting cleanup failure. Never use real credentials,
real agent sessions, production data, host services, or network policy.

Isolated loopback HTTPS/TLS plus synthetic device identities can exercise the
actual remote wire client/broker, scopes, RPC transaction/replay, redirect
refusal, one-hop fixed-view forwarding, timeouts, cancellation, and bounds.
This is protocol evidence only. Two physically separate authorized hosts and
their operator-owned LAN/private-network policy are required before claiming
LAN or tailnet reachability/access-control qualification. A local synthetic
identity cannot establish that boundary. CI covers Linux Node 24 and 26; other
platform support remains unclaimed until storage/concurrency scenarios run
there.

## 11. CLI contract

`src/cli.mjs` parses arguments, reads bounded JSON input, and forwards to
`open()`/`Relay` or `connect()`/`Client`; it contains no SQL, lease logic,
queue mutation, or second state engine. Validate the entire route/flag set
before opening a root, reading credentials, or creating a socket. `--root` and
`--url` are mutually exclusive. Remote routes replace `--root PATH` with
`--url HTTPS_URL --token-file FILE`, optional `--ca-file FILE`, and explicit
`--mode` only where HTTP local mode is used. A bearer token is never an argv
value or URL component.

| Command | Frozen invocation and action |
|---|---|
| setup | `relay setup --root PATH [--device NAME] [--role host|hub]`; persist supplied name or one captured hostname fallback. A first hub setup requires `--device`; role never changes after setup. |
| register | `relay register RUNTIME --root PATH [--slot SLOT] [--cap TAG]`; repeat `--cap` for the bounded set; print the canonical address. Remote registration requires the host-allocated slot. |
| enroll | `relay enroll --root PATH --config FILE`; bind this root's identity at the configured hub using its fixed credentials; create no listener or remote root. |
| join | `relay join WORKER --root PATH [--replace]`; replacement is explicit. |
| resume / renew / leave | `relay resume SID --root PATH`; `relay renew SID --root PATH`; `relay leave SID --root PATH`; affect only the supplied exact session. |
| send | `relay send TO --sid SID --root PATH [--key KEY]`; read exactly one envelope JSON value from stdin. |
| post | `relay post BOARD --sid SID --root PATH [--need TAG] [--series ID] [--key KEY]`; read one envelope; needs/series are refused for `{msg}`. |
| claim | `relay claim --sid SID --root PATH [--board BOARD] [--kind KIND]`; output one lease or JSON `null`; board claims are work-only and raw claims do not bypass Pool budgets. |
| touch / ack / release | `relay touch LEASE --sid SID --root PATH`; `relay ack LEASE --sid SID --root PATH --outcome STATE`; `relay release LEASE --sid SID --root PATH`. |
| get | `relay get MSG --root PATH [--data]`; body remains hidden unless explicitly requested and authorized. |
| list | `relay list --root PATH [--to WORKER] [--board BOARD] [--kind KIND] [--state STATE] [--data]`; `--to` and `--board` are exclusive. |
| stats / audit | `relay stats --root PATH`; `relay audit --root PATH [--after CURSOR]`; audit is bounded and payload-free. |
| snapshot | `relay snapshot --root PATH [--device ID] [--limit N] [--after CURSOR]`; read-only, scoped topology JSON; creates no state. |
| purge | `relay purge --root PATH --before TIME [--dry]`; local administration only. |
| serve | `relay serve --root PATH --config FILE`; explicit foreground listener; local administration only. |

`send`/`post` read at most 65,536 encoded UTF-8 bytes plus the bounded newline
framing, reject multiple JSON values/trailing input, and never interpolate
payload text into a shell. JSON results go to stdout; diagnostics go to stderr;
JSON output has no ANSI styling. Exit codes are 0 for success (including an
empty claim), 2 for invalid input, 3 for a contract refusal, and 1 for
storage/runtime failure. Local-only administration is not tunneled as a remote
operation. No CLI command changes firewall, private-network membership, proxy
policy, certificates, services, or external agent configuration.

### Bounded verification and cleanup

- Every test creates a fresh `mkdtemp()` root beneath `os.tmpdir()` and proves
  its resolved path is inside that directory before deletion. Never point a
  test at the project root, a user store, or a pre-existing database.
- Local protocol tests bind only `127.0.0.1`/`::1` and port `0`; TLS tests use
  test-only synthetic certificate material. Do not contact LAN, a private
  network, a real hub, or an operator proxy.
- Process-race tests call `spawn(process.execPath, exactArgs, {shell:false})`.
  Each child gets at most 30 seconds; send `SIGTERM` on cleanup, wait at most
  2 seconds, then `SIGKILL` only that verified child and wait at most another
  2 seconds. Do not kill by a broad name or PID pattern.
- Network requests use the 10-second client deadline and 3-second connection
  deadline. Test waits and lease lifetimes use short disposable store settings;
  every timer is owned, bounded, and cleared in `finally`. No test leaves an
  interval, listener, socket, child, DB handle, or temp directory behind.
- Close only resources created by the current test. If cleanup fails after a
  test failure, report both while preserving the original failure as primary.
  Test credentials are random per run, stay in memory/private temp files, and
  are removed with that test root. Test fixtures and state are excluded from
  the npm package.
- `npm run check` contains no test-runner or demo invocation. CI separately
  runs `npm test` on Linux Node 24 and 26; the demo/capture commands are not CI
  substitutes for automated tests or physical-host qualification.
