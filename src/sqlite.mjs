import { chmodSync, mkdirSync, lstatSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Fault, storageFault } from "./fault.mjs";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
const SCHEMA_VERSION = 2;
const privateMode = process.platform !== "win32";

function rejectSymlink(path, missingOkay = true) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Fault("schema", "Store target is a symlink");
    if (!info.isFile()) throw new Fault("schema", "Store target is not a regular file");
  } catch (error) { if (error.code !== "ENOENT" || !missingOkay) throw error; }
}

export function openDatabase({ root, create, readOnly, busyTimeoutMs = 5000 }) {
  if (typeof root !== "string" || root.length === 0) throw new Fault("input", "Store root is required");
  const requested = resolve(root);
  if (readOnly) {
    let info;
    try { info = lstatSync(requested); } catch (error) { if (error.code === "ENOENT") throw new Fault("missing", "Store does not exist"); throw storageFault(error); }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Fault("schema", "Store root must be a real directory");
    const file = join(requested, "relay.sqlite");
    rejectSymlink(file, false);
    rejectSymlink(`${file}-wal`);
    rejectSymlink(`${file}-shm`);
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
    if (!readOnly) {
      const version = db.prepare("PRAGMA user_version").get().user_version;
      if (version === 0 && create) {
        const tables = Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n);
        if (tables !== 0) throw new Fault("schema", "Existing database has no recognized schema");
        db.exec(readFileSync(schemaPath, "utf8"));
        const meta = db.prepare("INSERT INTO meta(key,value) VALUES(?,?)");
        meta.run("schema", String(SCHEMA_VERSION));
      } else if (version !== SCHEMA_VERSION) throw new Fault("schema", "Unknown store schema version");
      const integrity = db.prepare("PRAGMA integrity_check").get();
      if (!integrity || integrity.integrity_check !== "ok") throw new Fault("schema", "Store integrity check failed");
      const schema = db.prepare("SELECT value FROM meta WHERE key='schema'").get();
      if (!schema || schema.value !== String(SCHEMA_VERSION)) throw new Fault("schema", "Store schema metadata is invalid");
      const journal = db.prepare("PRAGMA journal_mode=WAL").get();
      if (journal?.journal_mode !== "wal") throw new Fault("storage", "Store cannot enter WAL mode");
      db.exec("PRAGMA synchronous=FULL");
      if (privateMode) chmodSync(file, 0o600);
    } else {
      const version = db.prepare("PRAGMA user_version").get().user_version;
      if (version !== SCHEMA_VERSION) throw new Fault("schema", "Unknown store schema version");
      const integrity = db.prepare("PRAGMA integrity_check").get();
      if (!integrity || integrity.integrity_check !== "ok") throw new Fault("schema", "Store integrity check failed");
      const schema = db.prepare("SELECT value FROM meta WHERE key='schema'").get();
      if (!schema || schema.value !== String(SCHEMA_VERSION)) throw new Fault("schema", "Store schema metadata is invalid");
    }
    return { root, file, db, readOnly, closed: false };
  } catch (error) {
    try { db?.close(); } catch {}
    throw storageFault(error);
  }
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
