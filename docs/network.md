# Network operation

Network mode is optional. Local `setup` and `open` start no listener. Only
`serve` binds a listener, after it validates the selected root, role, config,
credentials, transport, and port. Default application port is `4200`; an
occupied port fails rather than selecting a fallback.

| Mode | Listener | Required boundary |
|---|---|---|
| `local` | HTTP on literal loopback | Credentials still required |
| `lan` | HTTPS on one explicit local unicast address | Certificate/key, client trust, exact peer allowlist, Relay credentials |
| `tailscale` | HTTP on literal loopback | Separately managed private HTTPS proxy and access policy, plus Relay credentials |

Remote CLI operations use `--url` and `--token-file`; tokens are never argv or
URL data. `--ca-file` adds a per-client trust root. Plain HTTP requires explicit
`--mode local` and a literal loopback URL. TLS verification is not disabled.
Redirects are refused so authorization is not forwarded to another origin.
The broker keeps the database and authoritative expiry clock on its own local
disk.

The operator config and credential registry use strict schemas. Credentials
are separate per principal and store only token digests. Worker registration,
session ownership, recipients, board posting/claiming, Inbox/work body reads,
inspection, and topology visibility are separate grants. Enrollment alone does
not grant worker or board access. A broker lock is tied to verified process
identity; an uncertain lock is left for review, not removed by PID alone.

## Qualification status

No LAN or Tailscale reachability, certificate, access-policy, two-host, or
private-proxy qualification has been recorded for this checkout. A loopback
HTTP/HTTPS harness can test protocol behavior, scopes, bounded bodies, and
replay. It cannot prove physical-host reachability or tailnet policy.

[`examples/network.mjs`](../examples/network.mjs) is a disposable same-machine
HTTP/HTTPS exercise with independent hub and host stores, synthetic credentials
and workers, and fixed loopback listeners on `4200` (hub HTTP), `4201` (host
HTTP), and `4202` (an ephemeral HTTPS terminator forwarding only to the hub's
fixed loopback listener). It records an addressed message, hub bounty work,
and host-local work. Port overrides are explicit environment values; a bind
conflict stops the example. It requires the OpenSSL command to create its
one-run loopback certificate. It does not configure LAN, Tailscale, or host
policy, and has not yet been replayed against the missing network
implementation.

Tailscale setup and private Serve policy are operator-owned deployment work.
Relay commands and examples do not install Tailscale, alter firewall rules,
join a tailnet, enable Funnel, provision certificates, or reset proxy routes.
Before documenting a qualified private Serve route, record the actual client
and server versions, `tailscale serve status`, target, HTTPS endpoint, and
allowed/denied device observations for that run. There is no qualified version
or route evidence to pin here yet.

Do not treat a hostname, reported device, or tailnet membership as Relay
authorization. Do not put tokens, session IDs, message bodies, credential
paths, or private-key material in logs, URLs, or captures.
