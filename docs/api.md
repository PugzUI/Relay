# API and CLI

The consumer declarations in [`src/index.d.ts`](../src/index.d.ts) define the
public JavaScript API. Public runtime exports are `Fault`, `Relay`, `open`,
`setup`, `Broker`, `serve`, `Client`, `connect`, and `LIMITS`. Local `open()` is
synchronous; `connect()` and `serve()` are asynchronous. Only explicit `serve`
starts a listener.

`Relay` methods are synchronous. `Client` provides the same permitted methods
as promises and owns only its outbound resources. Closing a client does not end
its sessions or close a broker. The broker owns its database handle, listener,
and broker lock.

## Operation groups

| Group | Methods | Notes |
|---|---|---|
| Setup and identity | `setup`, `register`, `enroll` | Setup fixes store role and device identity; enrollment creates no worker permission. |
| Sessions | `join`, `resume`, `renew`, `leave` | Exact worker/session identity and monotonically fenced epochs. |
| Admission | `send`, `post` | One `{msg}` or `{work}` envelope; optional retained key. |
| Leases | `claim`, `touch`, `ack`, `release` | Each accepted attempt has a distinct lease ID. |
| Reads | `get`, `list`, `stats`, `audit`, `snapshot` | Payloads are hidden unless requested and authorized; reads do not initialize or clean a store. |
| Local maintenance | `purge`, `close` | Purge is bounded to eligible terminal rows; close releases this handle. |

`Envelope` contains exactly one key: `{msg: string}` with nonempty text, or
`{work: JsonValue}`. `kind` is derived from that key. Post `needs` and `series`
are options and require work. A board Inbox row is `posted` history without a
lease; board work uses the normal claim, touch, ack, and release path.

`send` and `post` return `{id,repeat,init}`. `claim` returns a lease or `null`.
An acknowledgement returns its persisted receipt; a release returns a requeue
receipt. `list` and `audit` return stable pages with exact permitted totals,
visible rows, current cursor, and optional next cursor. The authority and
permission scope bind continuation tokens.

## CLI

```text
relay setup --root PATH [--device NAME] [--role host|hub]
relay register RUNTIME --root PATH [--slot SLOT] [--cap TAG ...]
relay enroll --root PATH --config FILE
relay join WORKER --root PATH [--replace]
relay resume|renew|leave SID --root PATH
relay send TO --sid SID --root PATH [--key KEY] < envelope.json
relay post BOARD --sid SID --root PATH [--need TAG ...] [--series ID] [--key KEY] < envelope.json
relay claim --sid SID --root PATH [--board BOARD] [--kind msg|work]
relay touch|release LEASE --sid SID --root PATH
relay ack LEASE --sid SID --root PATH --outcome done|failed|rejected
relay get MSG --root PATH [--data]
relay list --root PATH [--to WORKER|--board BOARD] [--kind KIND] [--state STATE] [--data]
relay stats --root PATH
relay audit --root PATH [--after CURSOR]
relay snapshot --root PATH [--device ID] [--limit N] [--after CURSOR]
relay purge --root PATH --before EPOCH_MS [--dry]
relay serve --root PATH --config FILE
```

For remote operation routes, use `--url HTTPS_ORIGIN --token-file FILE`, with
optional `--ca-file FILE` for a private LAN trust root. HTTP is accepted only
with `--mode local` and literal `127.0.0.1` or `::1`. Mixed `--root` and
`--url` selectors fail before opening state or a socket. `setup`, `enroll`,
`purge`, and `serve` are local-only. Enrollment reads identity from the local
root and its fixed hub binding from the operator config.

`send` and `post` read one UTF-8 JSON envelope, bounded to 65,536 bytes plus
framing. The CLI rejects duplicate JSON object keys, trailing values, invalid
UTF-8, duplicate/unknown flags, and malformed command arity before dispatch.
It does not classify text or implement a second state machine. JSON results
use stdout; safe diagnostics use stderr. Exit status is `0` for success,
including an empty claim, `2` for invalid input, `3` for a contract refusal,
and `1` for storage/runtime failure.

The CLI code and argument tests are present in this lane. Full command replay
remains pending integration of the core and network modules.
