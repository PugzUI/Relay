# Relay

Relay is a browser fleet console for **Agent Host Protocol (AHP) 1.0**. It is a
client, not an agent daemon. The host is the sole authority for sessions,
providers, transcripts, approvals, tasks, and execution. Relay **persists no**
agent state or credentials and does not run a second scheduler.

## Run the console

Requires Node.js 24+ for the build and local static server.

```sh
npm ci
npm run check
npm start
```

Open http://127.0.0.1:4200 and connect an AHP host. The console binds to
loopback only. It can connect to any number of authorized AHP hosts.

To keep Relay running on the local Arch Linux workstation under the user
systemd manager, link the repository's unit (requires this checkout at
`~/workspace/Relay`) and enable it:

```sh
systemctl --user link ~/workspace/Relay/deploy/relay.service
systemctl --user enable --now relay.service
systemctl --user status relay.service
```

The frontend remains stateless and loopback-only; user lingering lets its
systemd unit run after reboot without logging into the desktop.

## Run the agent host

An AHP 1.0 server such as [ahpd](https://github.com/softov/ahpd) owns agent
sessions independently of Relay. Configure it with the projects and approved
agent backends, then run it under its built-in user systemd unit:

```sh
npm install --global @ahpd/server@0.13.0
ahpd configure
ahpd plugin install @ahpd/agent-acp@0.13.0
npm install --prefix ~/.config/ahpd --save-exact zod@4.6.7
ahpd service install
ahpd status
```

Configure the ACP plugin with only the agents you need. Each must have a
working native ACP command and credentials. For example, OpenCode exposes
`opencode acp`; Hermes exposes `hermes acp`.

In Relay, enter the host endpoint (`ws://127.0.0.1:9187`) and its access
token. Host discovery and sessions appear when the AHP handshake succeeds.
For a remote host, use `wss://` with authenticated, encrypted transport.
Host connections exist only in the current browser page; a full reload requires
reconnecting, but sessions and work remain owned by the host.

When creating a session, explicitly opt in to **Trust this workspace** only
for a repository whose project instructions and hooks you accept. Relay sends
the native `root/configChanged` / `workspaceTrust` action to the owning
AHP host. The grant is scoped to this host connection and re-sent after
reconnection, but never persisted by Relay. Untrusted project hooks are not
allowed to run implicitly.

**Security:** The AHP WebSocket browser transport conveys the host token as a
`tkn` query parameter because browsers cannot set a WebSocket Authorization
header. Relay code does not log or store tokens, but browser or host handshake
diagnostics can expose the full `?tkn=` URL after a failed connection. In
ahpd 0.13, a valid token admits WebSocket upgrades regardless of the request's
Origin; configured HTTP Origin restrictions do not guard this socket. Protect
DevTools and host/proxy logs, require tokens, bind the host to loopback or a
private network such as Tailscale, use TLS (`wss://`) for remote browsers, and
configure least-privilege host grants. AHP workspace paths are not an OS
sandbox. Trust only explicitly approved project folders; do not disable ACP
workspace-trust checks globally. Tool permissions remain owned by the agent host.

## What Relay does

- Shows live hosts, advertised agents, session activity, and workspace topology
  directly from official AHP state.
- Creates agent sessions, displays actual turns and tool activity, queues turns,
  cancels active work, and responds to confirmations and input requests.
- Uses host-resolved session configuration for isolation, branch/worktree settings
  and permissions; offers host-advertised models and paginated turn history.
- Shows host-advertised changesets and review options, with on-demand, bounded
  text before/after previews where the host permits resource reads.
- Reconnects to dropped hosts and refreshes the selected session from authoritative
  snapshots. Disconnected session details are marked unavailable.
- Does not cache transcripts or tokens, duplicate AHP state into SQLite, or
  interpret idle heuristics as completed work.

Sessions survive Relay closing because they are owned by the AHP host. Host
restarts and active-turn recovery depend on the chosen host/ACP agent and must
be verified for each deployment. Some native ACP providers are re-enumerated
under a new host session URI after a daemon restart; in that case, inspect the
restored session in the host catalog instead of retrying the old URI.

**Catalog scale:** The current AHP JavaScript multi-host client consumes only
the first `listSessions` page, and `ahpd@0.13.0` limits that response to 1,000
sessions per host. A host with more sessions may have additional results not
shown in Relay until the SDK supports catalog pagination. Relay does not claim
that a truncated host listing is complete.

## ChatGPT / Executor

Use [ahpc](https://github.com/softov/ahpc) as Executor's MCP connection:

```sh
npm install --global @softov/ahpc@0.9.0
ahpc --host ws://127.0.0.1:9187 \
  --connection-token-file ~/.config/ahpd/connection-token \
  mcp --mcp-tools automations,changes
```

This connects ChatGPT to the exact same host sessions; Relay needs no
Executor-specific backend, REST API, or GraphQL server.

For an Executor MCP client authorized to work in the Relay checkout, place a
scoped `trust` list in `~/.config/ahpc/config.json`:
`{ "trust": ["/home/user/workspace/Relay"] }`. Do not trust an entire
home directory for convenience.

In `@ahpd/agent-acp@0.13.0`, the ACP SDK's required `zod` peer dependency
is not installed automatically by `ahpd plugin install`. The pinned
`zod@4.6.7` installation above prevents the host from failing at startup
with `Cannot find package 'zod'`.

## Scope

Relay 1.0 intentionally removes the original message broker, queue, Pool,
delivery adapters, RPC journal, and second SQLite state engine. They were
not authoritative for native coding-agent sessions. There is no compatibility
mode or transitional daemon. The former agent-to-agent bounty service is not
part of the fleet product.

The original visual design specification is preserved in [DESIGN.md](DESIGN.md).
It governs the topology, square geometry, neutral palette and restrained motion.
