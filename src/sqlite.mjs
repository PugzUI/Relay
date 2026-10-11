import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync as openFileSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup as backupDatabase, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Fault, storageFault } from "./fault.mjs";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
const SCHEMA_VERSION = 3;
const SUPPORTED_SCHEMA_VERSIONS = new Set([2, 3]);
const DELIVERY_TABLES = ["delivery_owners", "delivery_bindings", "delivery_attempts", "delivery_attempt_scopes", "delivery_targets"];
const LEGACY_TABLES = ["meta", "devices", "boards", "agents", "sessions", "messages", "leases", "receipts", "send_keys", "audit", "rpc", "reservations", "launches", "reports", "report_events"];
const privateMode = process.platform !== "win32";

function rejectSymlink(path, missingOkay = true) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Fault("schema", "Store target is a symlink");
    if (!info.isFile()) throw new Fault("schema", "Store target is not a regular file");
  } catch (error) { if (error.code !== "ENOENT" || !missingOkay) throw error; }
}

function validateSchema(db, version) {
  if (!SUPPORTED_SCHEMA_VERSIONS.has(version)) throw new Fault("schema", "Unknown store schema version");
  const integrity = db.prepare("PRAGMA integrity_check").get();
  if (!integrity || integrity.integrity_check !== "ok") throw new Fault("schema", "Store integrity check failed");
  const schema = db.prepare("SELECT value FROM meta WHERE key='schema'").get();
  if (!schema || schema.value !== String(version)) throw new Fault("schema", "Store schema metadata is invalid");
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name));
  const required = version === 2 ? LEGACY_TABLES : [...LEGACY_TABLES, ...DELIVERY_TABLES];
  if (required.some((name) => !tables.has(name)) || version === 2 && DELIVERY_TABLES.some((name) => tables.has(name))) throw new Fault("schema", "Store tables do not match the declared schema");
}

export function openDatabase({ root, create, readOnly, busyTimeoutMs = 5000 }) {
  if (typeof root !== "string" || root.length === 0) throw new Fault("input", "Store root is required");
  const requested = resolve(root);
  if (readOnly) {
    let info;
    try { info = lstatSync(requested); } catch (error) { if (error.code === "ENOENT") throw new Fault("missing", "Store does not exist"); throw storageFault(error); }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Fault("schema", "Store root must be a real directory");
    const file = join(requested, "relay.sqlite");
    try {
      rejectSymlink(file, false);
      rejectSymlink(`${file}-wal`);
      rejectSymlink(`${file}-shm`);
    } catch (error) {
      if (error.code === "ENOENT") throw new Fault("missing", "Store database does not exist", { cause: error });
      throw storageFault(error);
    }
    return openSync(requested, file, false, true, busyTimeoutMs);
  }
  try {
    if (create) mkdirSync(requested, { recursive: true, mode: 0o700 });
    const info = lstatSync(requested);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Fault("schema", "Store root must be a real directory");
    if (privateMode) chmodSync(requested, 0o700);
    const actualRoot = realpathSync(requested);
    const file = join(actualRoot, "relay.sqlite");
    rejectSymlink(file);
    rejectSymlink(`${file}-wal`);
    rejectSymlink(`${file}-shm`);
    let exists = true;
    try { lstatSync(file); } catch (error) { if (error.code === "ENOENT") exists = false; else throw error; }
    if (!exists && !create) throw new Fault("missing", "Store database does not exist");
    return openSync(actualRoot, file, create, false, busyTimeoutMs);
  } catch (error) { throw storageFault(error); }
}

function openSync(root, file, create, readOnly, busyTimeoutMs) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly });
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.min(30000, Math.trunc(busyTimeoutMs)))}`);
    let version = db.prepare("PRAGMA user_version").get().user_version;
    if (!readOnly && version === 0 && create) {
      const tables = Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n);
      if (tables !== 0) throw new Fault("schema", "Existing database has no recognized schema");
      db.exec(readFileSync(schemaPath, "utf8"));
      db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(String(SCHEMA_VERSION));
    }
    db.exec("BEGIN");
    try {
      version = db.prepare("PRAGMA user_version").get().user_version;
      validateSchema(db, version);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    if (!readOnly) {
      const journal = db.prepare("PRAGMA journal_mode=WAL").get();
      if (journal?.journal_mode !== "wal") throw new Fault("storage", "Store cannot enter WAL mode");
      db.exec("PRAGMA synchronous=FULL");
      if (privateMode) chmodSync(file, 0o600);
    }
    return { root, file, db, readOnly, schemaVersion: version, closed: false };
  } catch (error) {
    try { db?.close(); } catch {}
    if (readOnly && error.code === "ENOENT") throw new Fault("missing", "Store database does not exist", { cause: error });
    throw storageFault(error);
  }
}

function verifyBackupPath(store, destination) {
  if (typeof destination !== "string" || destination.length === 0 || destination.includes("\0")) throw new Fault("input", "Backup path is required");
  const path = resolve(destination);
  if (path === store.file) throw new Fault("input", "Backup path must differ from the store database");
  const parent = dirname(path);
  let parentInfo;
  try { parentInfo = lstatSync(parent); } catch (error) { throw storageFault(error); }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || realpathSync(parent) !== parent) throw new Fault("input", "Backup parent must be a real directory");
  if (privateMode && (parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o022) !== 0)) throw new Fault("denied", "Backup parent must be owned and not group/world writable");
  try { lstatSync(path); throw new Fault("active", "Backup destination already exists"); }
  catch (error) { if (error instanceof Fault) throw error; if (error.code !== "ENOENT") throw storageFault(error); }
  return path;
}

async function createBackupSnapshot(store, parent, version) {
  let temporary;
  let descriptor;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      temporary = join(parent, `.relay-backup-${randomUUID()}.tmp`);
      try { descriptor = openFileSync(temporary, "wx", 0o600); break; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    if (descriptor === undefined) throw new Fault("storage", "Cannot reserve a private backup file");
    closeSync(descriptor); descriptor = undefined;
    await backupDatabase(store.db, temporary);
    chmodSync(temporary, 0o600);
    const backupDb = new DatabaseSync(temporary, { readOnly: true });
    try { validateSchema(backupDb, version); }
    finally { backupDb.close(); }
    descriptor = openFileSync(temporary, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
    try { unlinkSync(temporary); } catch {}
    throw storageFault(error);
  }
}

function publishBackupSnapshot(store, temporary, destination) {
  const path = verifyBackupPath(store, destination);
  const parent = dirname(path);
  linkSync(temporary, path);
  unlinkSync(temporary);
  if (process.platform !== "win32") {
    const descriptor = openFileSync(parent, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  return path;
}

function deliverySchemaSql() {
  const source = readFileSync(schemaPath, "utf8");
  const startMarker = "-- DELIVERY_SCHEMA_V3_START";
  const endMarker = "-- DELIVERY_SCHEMA_V3_END";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Fault("schema", "Delivery schema migration is unavailable");
  return source.slice(start + startMarker.length, end).trim();
}

/** Explicit, backed-up schema-only migration. Existing queues are never rebuilt or reset. */
export async function migrateDatabase({ root, to, backup: backupPath, deliveryEnabled } = {}) {
  if (typeof root !== "string" || !root || root.includes("\0") || ![2, 3].includes(to)) throw new Fault("input", "Migration arguments are invalid");
  if (to === 2 && deliveryEnabled !== false) throw new Fault("input", "Rollback requires delivery to be explicitly disabled");
  const store = openDatabase({ root, create: false, readOnly: false });
  try {
    const from = store.schemaVersion;
    if (!SUPPORTED_SCHEMA_VERSIONS.has(from) || from === to) throw new Fault("schema", "Requested migration source or target is invalid");
    const db = store.db;
    const destination = verifyBackupPath(store, backupPath);
    const parent = dirname(destination);
    for (let attempt = 0; attempt < 3; attempt++) {
      const versionBefore = Number(db.prepare("PRAGMA user_version").get().user_version);
      if (versionBefore !== from) throw new Fault("schema", "Store schema changed during migration");
      const dataVersion = Number(db.prepare("PRAGMA data_version").get().data_version);
      const temporary = await createBackupSnapshot(store, parent, from);
      let begun = false;
      let retry = false;
      try {
        db.exec("BEGIN IMMEDIATE"); begun = true;
        const lockedVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
        const lockedDataVersion = Number(db.prepare("PRAGMA data_version").get().data_version);
        if (lockedVersion !== from) throw new Fault("schema", "Store schema changed during migration");
        if (lockedDataVersion !== dataVersion) {
          db.exec("ROLLBACK"); begun = false; retry = true;
        } else {
          if (to === 2) {
            const owner = db.prepare("SELECT owner_hash FROM delivery_owners WHERE singleton=1").get();
            const unresolved = db.prepare("SELECT COUNT(*) AS n FROM delivery_targets WHERE attempt IS NOT NULL OR lock_nonce IS NOT NULL").get();
            if (!owner || owner.owner_hash !== null || Number(unresolved.n) !== 0) throw new Fault("active", "Rollback requires a stopped owner and no unresolved target gate");
            const attempts = db.prepare("SELECT COUNT(*) AS n FROM delivery_attempts WHERE state IN ('reserved','submitting','admitted','context_observed','turn_started','held','uncertain')").get();
            if (Number(attempts.n) !== 0) throw new Fault("active", "Rollback requires no unresolved attempts");
          }
          const published = publishBackupSnapshot(store, temporary, destination);
          if (to === 3) db.exec(deliverySchemaSql());
          else {
            for (const table of ["delivery_attempt_scopes", "delivery_attempts", "delivery_bindings", "delivery_targets", "delivery_owners"]) db.exec(`DROP TABLE ${table}`);
          }
          db.prepare("UPDATE meta SET value=? WHERE key='schema'").run(String(to));
          db.exec(`PRAGMA user_version=${to}`);
          validateSchema(db, to);
          db.exec("COMMIT"); begun = false; store.schemaVersion = to;
          return Object.freeze({ from, to, backup: published });
        }
      } catch (error) {
        if (begun) { try { db.exec("ROLLBACK"); } catch {} }
        try { unlinkSync(temporary); } catch {}
        throw error;
      }
      if (retry) unlinkSync(temporary);
    }
    throw new Fault("busy", "Store changed during every migration backup attempt");
  } catch (error) {
    throw storageFault(error);
  } finally { closeDatabase(store); }
}

export function withTransaction(store, mode, fn) {
  if (store.closed) throw new Fault("storage", "Store handle is closed");
  if (mode === "write" && store.readOnly) throw new Fault("denied", "Store is read-only");
  const db = store.db;
  let begun = false;
  const nested = (store.txDepth ?? 0) > 0;
  const savepoint = `relay_${store.txDepth ?? 0}`;
  if (nested && mode === "write" && store.txMode !== "write") throw new Fault("storage", "Cannot write inside a read transaction");
  try {
    if (nested) db.exec(`SAVEPOINT ${savepoint}`);
    else {
      db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN"); begun = true;
      const row = db.prepare("SELECT value FROM meta WHERE key='clock'").get();
      const wall = Date.now();
      const highWater = row ? Number(row.value) : null;
      if (row && (!Number.isSafeInteger(highWater) || highWater < 0)) throw new Fault("schema", "Store clock is invalid");
      if (mode === "write" && row && wall < highWater) throw new Fault("clock", "System clock moved behind the store high-water mark");
      const now = row ? Math.max(wall, highWater) : wall;
      if (mode === "write") db.prepare("INSERT INTO meta(key,value) VALUES('clock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now));
      store.txNow = now; store.txMode = mode;
    }
    store.txDepth = (store.txDepth ?? 0) + 1;
    const now = store.txNow;
    const result = fn({ db, now, mode, authority: store.authority });
    store.txDepth--;
    if (nested) db.exec(`RELEASE SAVEPOINT ${savepoint}`); else {
      if (privateMode) for (const sidecar of [`${store.file}-wal`, `${store.file}-shm`]) if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
      db.exec("COMMIT"); store.txNow = undefined; store.txMode = undefined;
    }
    begun = false;
    return result;
  } catch (error) {
    if (store.txDepth > (nested ? 1 : 0)) store.txDepth--;
    if (begun || nested) {
      try { if (nested) { db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); db.exec(`RELEASE SAVEPOINT ${savepoint}`); }
        else { db.exec("ROLLBACK"); store.txNow = undefined; store.txMode = undefined; } } catch {}
    }
    throw storageFault(error);
  }
}

export function closeDatabase(store) {
  if (!store.closed) { store.closed = true; store.db.close(); }
}
