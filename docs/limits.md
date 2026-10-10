# Limits and delivery

These are contract bounds, not measured throughput or capacity claims.

| Resource | Bound |
|---|---:|
| Session lifetime | 120,000 ms default |
| Claim lifetime | 30,000 ms default; no later than session expiry |
| Session resume window | 300,000 ms after expiry |
| Send-key and RPC retention | 86,400,000 ms |
| Terminal message retention | At most 7 days |
| Audit retention | At most 30 days |
| Canonical payload | 65,536 encoded UTF-8 bytes |
| Pending and claimed rows | 10,000 and 128 MiB of payload |
| All retained message rows | 50,000 and 256 MiB of payload |
| Page size | 50 default; 200 maximum |
| Devices / snapshot agent page | 64 / 512 |
| Needs and capabilities | 16 unique validated tags |
| Series identifier | 1–64 ASCII characters |
| Send key | 1–128 UTF-8 bytes; no control characters |
| Audit journal | 100,000 rows / 32 MiB |
| RPC journal | 100,000 rows / 32 MiB |
| Local / broker SQLite busy timeout | 5,000 / 100 ms |
| Broker request / client deadline | 10 s / 10 s |
| Connection deadline | 3 s |
| Concurrent broker requests | 32 total; 8 per principal |
| Pool default | 8 agents, 1 board assignment, 1 s polling |
| Launch budget | Disabled by default; maximum 16 children when configured |

Reads do not expire claims, update clock state, purge, initialize, or compact
records. Terminal retention may be shortened by the earlier caller cutoff.
Pending/live rows and retained key/RPC references are protected. Inbox history
shares the retained-row limit but does not consume job capacity.

Send-key deduplication covers admission only. Leased work is at-least-once
across interruption: a process may perform an external effect and stop before
acknowledging it. Use an idempotent external operation when duplicate effects
matter. Relay does not provide exactly-once external execution.

The values above are frozen starting bounds. No benchmark or scalability
threshold has been recorded for this checkout. Two-host network qualification
and platform claims remain separate from local tests and package checks.
