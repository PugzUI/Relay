PRAGMA user_version = 2;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folded TEXT NOT NULL UNIQUE, init INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('host','bounty')),
  device TEXT REFERENCES devices(id), init INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id), runtime TEXT NOT NULL,
  slot TEXT NOT NULL, caps TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
  init INTEGER NOT NULL, UNIQUE(device,runtime,slot)
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, worker TEXT NOT NULL REFERENCES agents(id), epoch INTEGER NOT NULL,
  until INTEGER NOT NULL, ended INTEGER, principal TEXT, init INTEGER NOT NULL,
  UNIQUE(worker,epoch)
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_worker ON sessions(worker,epoch DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, sender TEXT REFERENCES agents(id),
  recipient TEXT REFERENCES agents(id), board TEXT REFERENCES boards(id),
  kind TEXT NOT NULL CHECK(kind IN ('msg','work')), needs TEXT NOT NULL,
  series TEXT, data TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','claimed','posted','done','failed','rejected')),
  init INTEGER NOT NULL, acked INTEGER, attempt INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS messages_board_kind_seq ON messages(board,kind,seq);
CREATE INDEX IF NOT EXISTS messages_to_kind_state_seq ON messages(recipient,kind,state,seq);
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY, mid TEXT NOT NULL REFERENCES messages(id), sid TEXT NOT NULL REFERENCES sessions(id),
  epoch INTEGER NOT NULL, until INTEGER NOT NULL, attempt INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('live','released','expired','done','failed','rejected'))
) STRICT;
CREATE INDEX IF NOT EXISTS leases_mid_state ON leases(mid,state);
CREATE TABLE IF NOT EXISTS receipts (
  mid TEXT PRIMARY KEY REFERENCES messages(id), lease TEXT NOT NULL REFERENCES leases(id),
  sid TEXT NOT NULL REFERENCES sessions(id), epoch INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('done','failed','rejected')), time INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS send_keys (
  sender TEXT NOT NULL REFERENCES agents(id), key TEXT NOT NULL, mid TEXT NOT NULL REFERENCES messages(id),
  hash TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY(sender,key)
) STRICT;
CREATE INDEX IF NOT EXISTS send_keys_until ON send_keys(until);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, type TEXT NOT NULL,
  worker TEXT, sid TEXT, mid TEXT, lease TEXT, code TEXT, source TEXT, target TEXT, state TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS rpc (
  principal TEXT NOT NULL, rid TEXT NOT NULL, op TEXT NOT NULL, hash TEXT NOT NULL,
  committed INTEGER NOT NULL, until INTEGER NOT NULL, worker TEXT, sid TEXT, epoch INTEGER,
  mid TEXT, lease TEXT, result TEXT NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY(principal,rid)
) STRICT;
CREATE INDEX IF NOT EXISTS rpc_until ON rpc(until);
CREATE TABLE IF NOT EXISTS reservations (
  worker TEXT PRIMARY KEY, local_sid TEXT NOT NULL, remote_sid TEXT, board TEXT NOT NULL,
  rid TEXT NOT NULL UNIQUE, authority TEXT NOT NULL, state TEXT NOT NULL,
  mid TEXT, lease TEXT, epoch INTEGER, until INTEGER, settle_rid TEXT, settle_outcome TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS launches (
  id TEXT PRIMARY KEY, device TEXT NOT NULL, prime_sid TEXT NOT NULL, prime_epoch INTEGER NOT NULL,
  runtime TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, recipe_hash TEXT NOT NULL,
  capabilities TEXT NOT NULL, state TEXT NOT NULL, handle TEXT, worker TEXT, sid TEXT,
  epoch INTEGER, ready_at INTEGER, exit_at INTEGER, exit_code INTEGER, signal TEXT,
  demand INTEGER NOT NULL, ready_spare INTEGER NOT NULL, max_children INTEGER NOT NULL,
  init INTEGER NOT NULL, changed INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS reports (
  device TEXT PRIMARY KEY REFERENCES devices(id), sid TEXT NOT NULL, epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL, received INTEGER NOT NULL, report TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS report_events (
  device TEXT NOT NULL, sid TEXT NOT NULL, source_seq INTEGER NOT NULL, time INTEGER NOT NULL,
  type TEXT NOT NULL, source TEXT, target TEXT, mid TEXT, state TEXT, code TEXT,
  PRIMARY KEY(device,sid,source_seq)
) STRICT;
