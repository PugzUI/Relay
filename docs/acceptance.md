# Relay acceptance cases

Each case uses a disposable store. A passing case needs recorded evidence from
the implementation and environment under test. Listing a case here does not
claim that it has passed.

| ID | Scenario | Required result |
|---|---|---|
| A01 | Send, claim, acknowledge | Message, lease, and receipt IDs connect; the terminal row is persisted. |
| A02 | Repeat a keyed send with the same content and different object-key order | Return the existing receipt; do not add a queue row. |
| A03 | Repeat a key with changed target or content | Return `key_conflict`; add no row and return no false receipt. |
| A04 | Two processes claim one message | At most one gets the accepted claim; the other gets empty or bounded contention refusal. |
| A05 | Kill a claim holder, wait for expiry, reclaim | Create a new attempt ID and preserve pending work through restart. |
| A06 | Old attempt acknowledges after the same session reclaims | Return `lease`; leave the newer claim unchanged. |
| A07 | Explicitly replace a live session | Increase the epoch; reject old renew, claim, and acknowledge mutations. |
| A08 | Resume the exact expired session inside and outside the recovery window | Recover only inside the window; refuse outside it; never create another identity. |
| A09 | Acknowledge twice, then repeat with a conflicting outcome | Return the original receipt for the repeat; return `ack_conflict` for the changed outcome. |
| A10 | Expiry boundary and touch | Treat `now >= until` as expired; do not revive a claim or extend it beyond its session. |
| A11 | Sparse arrays, cycles, non-finite values, or unsupported data | Return `data`; perform no partial write or lossy conversion. |
| A12 | Unknown target, full queue, oversized input | Refuse explicitly and retain already accepted rows. |
| A13 | SQLite busy, disk full, corrupt store, or unknown schema | Return a typed fault; never reset the store or report false success. |
| A14 | Clock moves behind the stored high-water mark | Mutations return `clock`; read-only inspection remains available. |
| A15 | Purge while keys or live work remain | Retain protected records; dry-run removal count matches the eligible records. |
| A16 | Missing store followed by ordinary list, audit, or get | Create no state and print no payload by default. |
| A17 | CLI quoting, Unicode, spaces, NUL, and invalid flags | Preserve valid values; reject invalid input before mutation. |
| A18 | Render README and replay the documented quick start | Links and assets resolve; output is from a real run and labels remain readable. |
| A19 | Fresh local install and mixed root/URL selectors | Start no listener or network dependency by default; refuse ambiguous selectors before effects. |
| A20 | LAN with missing auth/TLS, wildcard bind, bad certificate, or untrusted peer | Fail closed; do not bind more broadly, use plaintext, or skip certificate verification. |
| A21 | Authorized two-host LAN/Tailscale send, claim, and acknowledge | Preserve the same receipt and attempt rules; keep the database on broker-local storage. |
| A22 | Missing/revoked token, forged identity header, or known foreign session | Refuse without disclosing payload/state or changing another principal's records. |
| A23 | Allowed sender with forbidden recipient; foreign list/audit/get | Enforce exact recipient and inspection scope before pagination; reveal no global inventory or payload. |
| A24 | Lost claim/send/join/ack/leave/release reply and retained replay | Return the operation-specific receipt or an expiry/supersession refusal; retain terminal receipts without reopening or repeating mutations; changed input returns `rpc_conflict`. |
| A25 | Broker restart, client outage, delayed reply, or client clock skew | Recover from the retained journal/session rules; refuse stale attempts; use the broker clock for expiry. |
| A26 | Chunked/oversized input, duplicate auth, slow body, overload, rate cap, or reconnect storm | Bound memory and limiter state; keep one client deadline across retries; return complete typed refusals without late mutation. |
| A27 | Purge/journal full or stale lock during remote traffic | Protect retained references; fail journal admission atomically; preserve a live broker lock. |
| A28 | Credential rotation/revocation, invalid registry, duplicate token digest, and terminal replay | Admit only a validated atomic registry snapshot; fail closed on invalid reload; preserve the transaction boundary and principal/epoch/ownership checks. |
| A29 | Private proxy route/policy inspection and denied third device | Show that the route is private and the denied identity cannot connect; make no public-ingress or foreign proxy changes. |
| A30 | Network example/docs and local-only cleanup | Use real synthetic receipts and explicit prerequisites; close only owned listeners/processes; change no host policy automatically. |
| A31 | Supplied device name, hostname fallback, restart, and hostname change | Keep the exact persisted name and ID; do not re-register or rename implicitly. |
| A32 | Invalid/duplicate/case-fold device name or foreign namespace | Refuse without adding a suffix, merging identities, or expanding permission. |
| A33 | Concurrent numbered registration and prime restart/replacement | Allocate unique monotonic addresses; prevent the old slot/session from claiming under another worker's authority. |
| A34 | Same agent address at local and hub authorities | Keep recipients, sessions, and receipts authority-specific; do not copy queues. |
| A35 | Two eligible devices claim one bounty job | Accept one work lease; return empty/bounded refusal to the other; create no duplicate accepted attempt. |
| A36 | Capability mismatch, no free slot, uncertain hub claim followed by local claim | Leave ineligible work untouched; keep the reservation until the original outcome or expiry is established. |
| A37 | Claim a host-local board from another device or during an outage | Refuse cross-device ownership; create no substitute bounty board or replicated local job. |
| A38 | Serial jobs with an earlier ineligible, released, expired, or failed member | Allow one live series attempt; do not skip the earlier unfinished member; post success-dependent successors only after `done`. |
| A39 | Hub disconnect/restart while local work is available | Continue local work; report global uncertainty/expiry; mark remote presence/capacity unknown until a valid report. |
| A40 | Prime launch with spare demand, zero budget, denied recipe, or failed readiness | Launch only authorized budgeted children; require ready registration before assignment; leave work pending after launch failure. |
| A41 | Lost launch reply, prime replacement, stale/native handle, or unrelated process | Reconcile an owned launch once; refuse unresolved ambiguity; do not recursively spawn, duplicate launch, or kill unrelated processes. |
| A42 | Scoped snapshot with clipping and remote reported counts | Separate exact permitted totals from visible rows; label authority and age; invent no remote state or body. |
| A43 | Real relay events, replay, failed send, heartbeat, and direct-handle write | Light activity only for committed accepted events; observe other-handle commits; create no duplicate/fake success pulse. |
| A44 | Snapshot/subscribe boundary, old cursor, restart, hidden tab, and reconnect | Lose no state across the boundary; require snapshot/reset when needed; do not replay old activity as current. |
| A45 | Burst/oversized reports, stale agents, slow/denied viewer | Bound cache, output, and admission; avoid transaction blockage; close expired/revoked streams; do not treat stale capacity as live. |
| A46 | Localhost/LAN/Tailscale `4200` profiles and occupied port | Bind only the explicit profile/trust target; qualify external private endpoints separately; do not pick another port or downgrade exposure. |
| A47 | Board view at wide/narrow widths, keyboard, reduced motion, empty/offline/error | Show peer Inbox/Bounties panes, readable stable IDs, flat sharp surfaces, and actual backend state for owner review. |
| A48 | Exact envelopes, both/neither keys, text containing `work:`, changed-kind keyed repeat | Accept one explicit kind; refuse malformed input; never classify text as work; never reclassify a keyed row. |
| A49 | Independent kind queries, mixed history/work, paging, concurrent posts, malformed/duplicate pane query | Filter board/kind/permission before exact totals; reject malformed queries before lookup/forwarding; skip and append no duplicate rows. |
| A50 | Two readers open, scroll, and follow one Inbox | Keep shared append-only text; do not lease, acknowledge, dequeue, charge a job slot, or mutate global read state. |
| A51 | Topology-only grant versus board-body grant; remote redirect, timeout, cancellation, or mid-read revocation | Return only scoped pages; never forward credentials across redirects/downgrades or deliver after denial; bound/cancel owned requests; keep bodies/SIDs/tokens out of feeds and render terminal/HTML controls inertly. |
| A52 | Inbox admission, active keys/RPC references, cutoff/purge, and restart | Bound and expose posted history retention; protect live work and replay references; keep messages/jobs in one store/table. |
| A53 | First setup as host/hub, immutable role, read-only open on missing/existing stores | Default to host; require a supplied name for first hub setup; reject role changes; make no files for a missing read-only root; reject mutations through a read-only handle. |
| A54 | Authenticated remote enrollment and registration | Enroll only the exact preauthorized device ID/name; return the same receipt on repeat; refuse collisions; grant no worker/session/board rights; require a host-allocated numbered slot for remote registration. |
| A55 | Credential revocation or request-deadline expiry while a mutation waits for SQLite's write lock | Revalidate through the post-lock synchronous gate; roll back application, audit, and RPC-journal writes together; return no late success. |
| A56 | Pool restart after reserved claim, accepted claim before bind, or lost settlement reply | Retry the exact saved request ID against the same authority/session; reconcile exact attempt state; retain capacity through ambiguity; do not count Inbox messages against board-job capacity. |
| A57 | Launch bootstrap, readiness, task/result frame, and process reconciliation | Assign nothing before nonce/session/device/runtime/capability validation; match each result to one lease; keep ambiguous native ownership budgeted and never signal by PID alone. |

An isolated loopback HTTPS/TLS harness with synthetic identities can provide
protocol evidence for network cases. It does not pass A21 or A29: those require
separately authorized physical hosts and their actual LAN/private-network
policy. Missing access leaves those qualification cases open.

## Native delivery (Relay/v2)

These are release requirements, not recorded results. Every case is pending;
native API documentation, a stub adapter, or a hook declaration does not pass a
case.

| ID | Scenario | Required observation | Status |
|---|---|---|---|
| D01 | Disabled/default | Ordinary account-free local Relay use starts no notifier, listener, native input, or process. | Pending |
| D02 | Real startup/context callback | A native lifecycle callback binds the exact synthetic session; its notice is visible to the model, not only stdout or a registration record. | Pending |
| D03 | Unattended idle activation | Addressed synthetic mail starts a turn in the same already-idle session without user input; current state is observed within reconciliation plus native submission bounds, excluding model-generation time. | Pending |
| D04 | Busy delivery | A controlled native tool remains uninterrupted; pending mail is visible at the documented next safe boundary, including work arriving while busy. | Pending |
| D05 | Context-only/unsupported | The adapter reports the missing capability, leaves work pending, and does not claim idle wake or substitute a new session. | Pending |
| D06 | Recipient isolation | Another worker, native session, authority, or profile receives no hint, body, or count from the target; runtime-name equality is insufficient. | Pending |
| D07 | Current-session fencing | Expired, replaced, or ended sessions and delayed native replies cannot notify or complete against a new binding/epoch. | Pending |
| D08 | Non-consuming summary | Repeated reads/notices leave queue, session lifetime, leases, outcomes, and RPC state unchanged; bodies are absent. | Pending |
| D09 | Lease boundary | A receiver cannot execute from a notice or old receipt alone; current claim, lease attempt, and settlement permissions remain required. | Pending |
| D10 | Inbox/work distinction | Board `{msg}` remains posted history; addressed `msg` uses normal claim rules; board work demand uses existing Pool eligibility/capacity only. | Pending |
| D11 | Burst/duplicate hints | Duplicate callbacks and concurrent local/hub hints for one native target coalesce through one gate; native acceptance alone cannot admit another activation. New/deferred state remains discoverable without a wake storm, duplicate lease, or false acknowledgement. | Pending |
| D12 | Release/expiry rediscovery | The same message becomes eligible again after release/expiry; admission-ID/sequence dedupe cannot suppress it permanently. Reads do not perform expiry mutation. | Pending |
| D13 | Startup catch-up | Work admitted before supervisor startup or during downtime is found by current-state reconciliation without retained feed events. | Pending |
| D14 | Feed reset/missed events | Broker restart, overflow, scope reset, stream saturation, or an omitted event recovers through fresh scoped reads without queue copying. | Pending |
| D15 | Crash before submission | A persisted unsent attempt is safely reconciled/retried; work remains pending and no false delivered state appears. | Pending |
| D16 | Crash after native acceptance | Recovery resolves or visibly retains uncertainty; it does not blindly start another turn or pretend exactly-once activation. | Pending |
| D17 | Concurrent supervisors | Competing processes for one root or two roots targeting one session cannot submit independently. A paused old owner is fenced; unresolved native calls retain the target slot through takeover. | Pending |
| D18 | Native hold/refusal | Refusal/approval is honored and observable; terminal input, alternate APIs, or process launch cannot bypass it. | Pending |
| D19 | Absent/launch disabled | Work remains durable and absence is reported; no implicit launch occurs. | Pending |
| D20 | Authorized bounded launch | Enabled local launch uses the existing recipe, budget, readiness proof, and ledger; ambiguous ownership stays blocked and remote payloads cannot select an executable. | Pending |
| D21 | Credential/scope changes | Revocation and unsafe registry replacement deny future reads/submissions; there are no credential redirects or cross-principal bindings. | Pending |
| D22 | Capacity/deadline/storage failure | Saturated bindings/calls/logs, SQLite contention, failed migration, corruption/disk error, or deadline exhaustion is reported safely without deleting pending work or unresolved attempts. | Pending |
| D23 | Shutdown/cancellation | Owned timers/feeds/handles stop; accepted-but-unconfirmed input remains uncertain; existing sessions and unowned processes are untouched. | Pending |
| D24 | Retention/privacy/output | Cleanup preserves unresolved coordination and pending work; bounded notices/logs/captures contain no payload, token, session handle, private path, or terminal-control injection. | Pending |
| D25 | Native support matrix | Every enabled client has exact version/surface evidence for required capabilities; synthetic adapter success is not promoted to native qualification. | Pending |
| D26 | Clean-checkout documentation | Actual release commands and a recorded message/claim/acknowledgement workflow reproduce documented behavior; no planned command is presented as implemented and no unsupported platform/network claim is added. Public demos are not a readiness gate. | Pending |

For D03, D04, and D25, retain both native session/turn observations and Relay
admission/claim/ack observations privately during qualification; publish only
redacted evidence. Sender acceptance and delivery-consumer logs alone do not
prove receiver behavior. A provider outage or unavailable native API remains a
limitation, not a successful observation.
