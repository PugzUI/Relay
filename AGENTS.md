# Relay

Relay is the standalone project at `PugzUI/Relay`. Read the supplied PRD and the frozen implementation contract before coding.

## Product scope

- Relay must work independently for users outside this environment. Executor, MCP, the private agent framework, and AI Intercom are not runtime dependencies or release prerequisites.
- Replacing AI Intercom is a later, separately scoped migration. Do not integrate Relay into that stack or disable the installed Intercom while delivering this product.
- Prioritize real message/work delivery, native agent integration, failure handling, and direct end-to-end verification. A populated interface or synthetic worker receipt does not prove native agent delivery.
- User-facing demos, screenshot galleries, and showcase work are deferred until the product works. Keep disposable verification fixtures under `tests/`, outside the public commands and package. Do not present fixtures as product readiness.

## Delivery authority

The owner requested the complete project and explicitly authorized all project choices through readiness and push to `main`. Project-scoped automated tests, isolated local HTTP/HTTPS/process/browser verification, commits and publication to `PugzUI/Relay` are authorized. Do not change host services, firewall/Tailscale policy, installed agent configuration, other repositories, or production data. Never expose credentials or real agent sessions.

## Implementation

- Node native SQLite, HTTP/HTTPS, crypto; JavaScript ESM, JSDoc and consumer declarations. One storage/lease engine, one wire protocol, one CLI.
- The private planning PRD is supplied separately. Public documentation must not include private donor paths, source revisions, real homelab addresses or session IDs.
- Use the current project name Relay. Keep `init` as immutable creation time in UTC epoch milliseconds, never a readiness flag.
- The scope includes local and authenticated remote relays, enrolled device-qualified workers, central bounty and local boards, bounded local pool/prime launch, and one live topology page with `Inbox | Bounties` panes.
- Explicit msg/work envelopes; no message-text classification. No queue replication, peer mesh, DAG scheduler, arbitrary remote execution, React, dashboard framework or second state engine.
- Flat black/neutral surfaces, readable white/light-grey type, lime activity, sharp zero-radius corners, no nested cards. Native browser modules and SVG/CSS. No subtitle, lead, hero caption, sales prose, badge wall or invented traffic. Only operational labels and real committed state. Presentation copy remains owner-controlled; omit unsupplied marketing slots from the release rather than inventing them.
- Credentialed requests use fixed destinations, strict argument validation, bounded resources and correct permission checks. No redirected credentials, bearer secrets in argv/URLs, shell interpolation of work payloads, or unbounded logs.
- Implement failure paths and cleanup. Keep application mutations and RPC journal commit atomic. Historical receipts are not current execution authority.
- No fabricated output or unsupported cross-platform/network qualification claims.

## Parallel work

The primary checkout integrates. `.wt/tree1` through `tree4` are independent worker slots. Keep lane file ownership explicit; do not write another lane, merge other branches, push or overwrite shared contract files unless specifically assigned. Each worker commits its own complete lane and reports its exact commit, checks, coverage and remaining blockers. Do not hide failures or return a stub as complete.

The owner-provided Hermes Intercom session belongs to the orchestrator only. Workers must adopt their own native startup binding, never impersonate `hermes:default`, replace its session or heartbeat it.
