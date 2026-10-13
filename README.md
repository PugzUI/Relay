# Relay

Relay is a standalone Node.js package and CLI for addressed worker messages,
board work, and a read-only topology view. It requires no Executor, MCP server,
AI Intercom installation, account, or private home-directory configuration.

## Status

The store, CLI/SDK, authenticated broker, topology interface, and opt-in delivery
supervisor are implemented. A first-party OpenCode plugin is implemented but
not fully qualified. Idle notice delivery was observed on isolated OpenCode
2.0.27, including direct loading from an installed archive. Other required
native adapters and the remaining native cases are incomplete.
Relay is not yet ready for the full native-agent release;
see [delivery status](docs/delivery.md) and [verification](docs/verification.md).

Replacing an existing Intercom deployment is not part of this release.

## Install from source

```sh
git clone https://github.com/PugzUI/Relay.git
cd Relay
npm ci
```

Node.js `>=24.0.0` and a local filesystem are required. No runtime dependencies
are declared. Installation starts no store, agent, or network listener.

## CLI

Local inspection and mutation use a selected store root. Read commands open it
read-only and do not initialize a missing store.

```sh
node src/cli.mjs setup --root './relay data' --device workstation
node src/cli.mjs register worker --root './relay data' --cap inspect
node src/cli.mjs join workstation:worker:001 --root './relay data'
printf '%s\n' '{"msg":"ready"}' | node src/cli.mjs send workstation:worker:001 --sid SESSION --root './relay data'
```

Replace `SESSION` with the session `id` returned by `join`. A send or board post reads
one JSON envelope from stdin: `{ "msg": "text" }` or
`{ "work": { "task": "inspect" } }`. Text is never classified as work.
`--json` writes compact JSON; normal output escapes terminal control bytes.
Bearer tokens are read from private files and are never command arguments or
URL values.

## API

```js
import { open } from "./src/index.mjs";

const relay = open({ root: "./relay data" });
try {
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const receipt = relay.send(session.id, worker.id, { msg: "ready" });
  console.log(receipt.id, receipt.repeat);
} finally {
  relay.close();
}
```

See [API reference](docs/api.md), [storage](docs/storage.md),
[limits](docs/limits.md), [network](docs/network.md), [boards](docs/boards.md),
and [topology](docs/topology.md).

## Interface

The broker serves one read-only topology page with selected-board
`Inbox | Bounties` panes. It displays committed store state, not simulated
agent activity. Browser connection does not establish native agent readiness.

Create a broker configuration with the permissions described in
[network setup](docs/network.md), then serve the initialized store explicitly:

```sh
node src/cli.mjs serve --root './relay data' --config './relay.json'
```

Open the configured origin and connect with its private bearer token. The token
stays in browser memory and is not stored in a URL. The interface does not
start agents, submit prompts, or acknowledge work.

## Delivery and authority

Each store owns its records, board scope, and expiry clock. A hub owns the
shared `bounty` board; each host owns its `host:<device-id>` board. A host may
connect to one configured hub, but databases and queues are not replicated.
The hub never opens a host database.

Accepted enqueue, claim, and acknowledgement state is persisted. A worker can
repeat work after interruption or lease expiry, including after an external
side effect occurred but before acknowledgement. Make external effects
idempotent when duplication matters. A keyed send deduplicates admission during
key retention; it does not provide exactly-once execution.

Relay’s durable queue does not itself invoke an agent session or wake an idle
runtime. Optional native delivery is disabled by default and remains
unqualified; see the
[delivery contract and client inventory](docs/delivery.md).

## Network and setup

Local setup starts no listener. `serve` is an explicit operation; its default
application port is `4200`. Local HTTP binds literal loopback. LAN mode requires
an explicit local address, TLS trust, and an exact peer allowlist. Tailscale
mode uses loopback behind operator-managed private HTTPS. Credentials and
Relay permissions remain required in every mode. See [network boundaries and
qualification](docs/network.md).

This repository has no LAN or private-network qualification evidence yet.
No Relay setup operation changes firewall, Tailscale, certificate, proxy, or
service configuration.

## Development

```sh
npm run check
npm test
```

`check` validates syntax, declarations, package contents, and frozen module
presence; it does not run tests. `test` is separate. Disposable verification
fixtures are under `tests/` and are excluded from the package. Fixture success
does not qualify native agent delivery. See
[verification evidence and remaining boundaries](docs/verification.md).

See [acceptance cases](docs/acceptance.md)
and [the frozen contract](docs/contract.md) for implementation and qualification
boundaries. Licensed under [MIT](LICENSE).
