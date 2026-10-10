# Storage

Each Relay authority uses one local SQLite database at `<root>/relay.sqlite`.
The broker owns the database for remote clients. Clients do not open broker
files. WAL and shared-memory sidecars remain beside the database; WAL is not a
multi-machine coordination mechanism.

On POSIX, fresh store directories are `0700` and owned database, lock,
configuration, and credential files are `0600`. Relay does not chmod unrelated
parents. A final database or lock symlink is refused. Unknown schema,
corruption, failed integrity validation, permission errors, and storage faults
do not reset an existing store. Migrations require a backup and an explicit
versioned step; importing a live store is outside the first release.

`setup({root, device?, role?})` creates the initial identity. Host is the
default role. First hub setup requires an explicit device name and `role:"hub"`.
Device identity and role are immutable. `init` is the record creation time in
UTC epoch milliseconds and never means readiness.

Each connection enables foreign keys and a bounded busy timeout. Local writes
use `BEGIN IMMEDIATE`, WAL, `synchronous=FULL`, and one persisted high-water
clock guard. If wall time moves behind the saved high-water value, mutations
refuse with `clock`; reads remain available. A missing-store read uses
`open({root, readOnly:true})`, returns `missing`, and creates no directory,
database, WAL, expiry change, or cleanup record.

One message table stores addressed messages and board entries. It holds one
canonical `{msg}` or `{work}` envelope, its derived kind, and the same persistent
sequence/receipt/lease relationships. Inbox `posted` rows are append-only and
have no lease. Work claims get a fresh attempt ID. Expiry can make work
available again; external execution can repeat after interruption.

Mutations, audit entries, and remote RPC outcomes commit atomically. The
bounded RPC journal retains minimal receipt references for 24 hours; it does
not store a second payload or state engine. A matching request ID and content
can return its original result. Changed content conflicts. Purge preserves live
work and message/session/lease/receipt rows referenced by retained keys or RPC
records.

The package targets Node.js `>=24.0.0` and a local filesystem. Windows, macOS,
network filesystems, and shared SQLite mounts are not claimed until their
storage and concurrency cases are qualified.
