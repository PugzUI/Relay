# Relay 1.0

Relay is an AHP 1.0 browser **client**. The single authoritative session
service is the separately installed AHP host, not Relay.

- Use the official `@microsoft/agent-host-protocol` SDK, including the
  `/hosts` multi-host layer. Do not implement a competing AHP protocol client,
  state engine, scheduler, message queue, SQLite store, or agent launcher.
- Do not add provider-specific adapters, compatibility shims, or transition modes.
  ACP agents are hosted by the AHP service.
- Relay's responsibility is an accurate PugzUI interface for actual host state:
  topology, live sessions and turns, approvals, cancellation, and diagnostics.
  All mutations must go to the owning AHP host.
- Respect host identity, URI and generation boundaries on every action.
  Never treat a transport write as work completion; wait for authoritative
  server state. On disconnection, mark data stale and disable mutations.
- Never persist, print, export, or embed connection tokens in generated files,
  markup, browser storage, shell arguments, or URLs shared with the user.
  In-browser WebSocket authentication is limited to the ephemeral socket URL;
  use encrypted transport for remote hosts.
- Preserve the visual contract in DESIGN.md: black, neutral, lime, sharp edges,
  native SVG topology, reduced motion. Never display synthetic activity.
- Keep code and dependencies minimal. Prefer subtraction to abstraction.
  Existing implementations do not have special preservation rights.
- Unit tests and fixtures do not qualify provider behavior. Verify real AHP
  host connections, event updates, approvals, cancellation and restart recovery.
- Do not mutate production host services, configured native agents, firewall,
  Tailscale policy or unrelated repositories as part of UI verification.
