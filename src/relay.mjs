import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase, withTransaction } from "./sqlite.mjs";
import { Fault } from "./fault.mjs";
import { LIMITS, canonicalJson, fingerprint, validateAddress, validateDeviceName, validateEnvelope, validateKey, validateRuntime, validateSlot, validateTags } from "./validate.mjs";

const id = () => randomUUID();
const openRelays = new WeakMap();
const localPoolAuthorizations = new WeakSet();
const safeJson = (value) => {
  try { return JSON.parse(value); }
  catch { throw new Fault("schema", "Persisted JSON data is invalid"); }
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const own = (obj, key) => Object.hasOwn(obj, key);
const input = (ok, message) => { if (!ok) throw new Fault("input", message); };
const tx = (relay, mode, fn) => withTransaction(relay._store, mode, fn);
const faultCodes = new Set(["input", "data", "missing", "schema", "active", "session", "expired", "target", "device_conflict", "board", "key_conflict", "ack_conflict", "owner", "lease", "full", "busy", "clock", "storage", "auth", "denied", "protocol", "tls", "rpc_conflict", "uncertain", "cursor", "reset", "rate", "timeout", "unavailable"]);
const reportEventStates = { post: ["posted", "pending"], claim: ["claimed"], release: ["pending"], ack: ["done", "failed", "rejected"], refusal: [null] };

function readMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); }
  catch { throw new Fault("schema", "Store metadata is invalid"); }
}
function writeMeta(db, key, value) { db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); }
function retentionKey(board, kind) { return `${board}|${kind}`; }
function readMessagePruned(db) {
  const counts = readMeta(db, "messagePruned") ?? {};
  const boardCount = Number(db.prepare("SELECT COUNT(*) AS n FROM boards").get().n);
  if (!counts || typeof counts !== "object" || Array.isArray(counts) || Object.keys(counts).length > boardCount * 2) throw new Fault("schema", "Message retention metadata is invalid");
  for (const [key, count] of Object.entries(counts)) {
    const separator = key.lastIndexOf("|");
    const board = key.slice(0, separator); const kind = key.slice(separator + 1);
    if (separator < 1 || !["msg", "work"].includes(kind) || !db.prepare("SELECT 1 FROM boards WHERE id=?").get(board) || !Number.isSafeInteger(count) || count < 0) throw new Fault("schema", "Message retention metadata is invalid");
  }
  return counts;
}
function deviceRow(row) { return { id: row.id, name: row.name, init: row.init }; }
function agentRow(row) { return { id: row.id, device: row.device, runtime: row.runtime, slot: row.slot, caps: safeJson(row.caps), epoch: row.epoch, init: row.init }; }
function sessionRow(row) { return { id: row.id, worker: row.worker, epoch: row.epoch, until: row.until, ended: row.ended ?? null }; }
function boardRow(row) { return { id: row.id, kind: row.kind, device: row.device ?? null, authority: row.authority }; }

function initStore(store, options = {}) {
  const requestedRole = options.role;
  if (requestedRole !== undefined) input(requestedRole === "host" || requestedRole === "hub", "Invalid store role");
  return withTransaction(store, "write", ({ db, now }) => {
    const existing = readMeta(db, "device");
    if (existing) {
      if (options.device !== undefined && existing.name !== validateDeviceName(options.device)) throw new Fault("device_conflict", "Store already has a different device name");
      if (requestedRole !== undefined && readMeta(db, "role") !== requestedRole) throw new Fault("input", "Store role cannot be changed");
      return deviceRow(db.prepare("SELECT * FROM devices WHERE id=?").get(existing.id));
    }
    const role = requestedRole ?? "host";
    if (role === "hub" && options.device === undefined) throw new Fault("input", "Hub setup requires a device name");
    const name = validateDeviceName(options.device ?? hostname());
    const device = { id: id(), name, init: now };
    const policy = {
      sessionMs: options.sessionMs ?? LIMITS.sessionMs,
      claimMs: options.claimMs ?? LIMITS.claimMs,
      keyMs: options.keyMs ?? LIMITS.keyMs,
      terminalRetentionMs: LIMITS.terminalRetentionMs, auditRetentionMs: LIMITS.auditRetentionMs,
      pendingMessages: LIMITS.pendingMessages, pendingBytes: LIMITS.pendingBytes,
      retainedMessages: LIMITS.retainedMessages, retainedBytes: LIMITS.retainedBytes,
      auditRows: LIMITS.auditRows, auditBytes: LIMITS.auditBytes,
      rpcRetentionMs: LIMITS.rpcRetentionMs, rpcRows: LIMITS.rpcRows, rpcBytes: LIMITS.rpcBytes,
    };
    input(Number.isInteger(policy.sessionMs) && policy.sessionMs >= 1000 && policy.sessionMs <= 3600000, "Invalid session lifetime");
    input(Number.isInteger(policy.claimMs) && policy.claimMs >= 1000 && policy.claimMs <= policy.sessionMs, "Invalid claim lifetime");
    input(Number.isInteger(policy.keyMs) && policy.keyMs >= 1000 && policy.keyMs <= 2592000000, "Invalid key lifetime");
    db.prepare("INSERT INTO devices(id,name,folded,init) VALUES(?,?,?,?)").run(device.id, device.name, device.name.toLowerCase(), now);
    const hostBoard = `host:${device.id}`;
    db.prepare("INSERT INTO boards(id,kind,device,init) VALUES(?,?,?,?)").run(hostBoard, "host", device.id, now);
    if (role === "hub") db.prepare("INSERT INTO boards(id,kind,device,init) VALUES('bounty','bounty',NULL,?)").run(now);
    writeMeta(db, "device", device); writeMeta(db, "role", role); writeMeta(db, "authority", id());
    writeMeta(db, "policy", policy); writeMeta(db, "slotCounters", {}); writeMeta(db, "auditPruned", 0);
    return device;
  });
}

function loadStore(store, options = {}) {
  const meta = tx({ _store: store }, "read", ({ db }) => ({
    device: readMeta(db, "device"), role: readMeta(db, "role"), authority: readMeta(db, "authority"), policy: readMeta(db, "policy"),
  }));
  if (!meta.device) throw new Fault("schema", "Store identity is missing");
  if (typeof meta.device.id !== "string" || !meta.device.id || meta.device.id.length > 128 || !Number.isSafeInteger(meta.device.init) || meta.device.init < 0 || !["host", "hub"].includes(meta.role) || typeof meta.authority !== "string" || !meta.authority || meta.authority.length > 128) throw new Fault("schema", "Store metadata is incomplete");
  validateDeviceName(meta.device.name);
  const fixedPolicy = { terminalRetentionMs: LIMITS.terminalRetentionMs, auditRetentionMs: LIMITS.auditRetentionMs,
    pendingMessages: LIMITS.pendingMessages, pendingBytes: LIMITS.pendingBytes, retainedMessages: LIMITS.retainedMessages,
    retainedBytes: LIMITS.retainedBytes, auditRows: LIMITS.auditRows, auditBytes: LIMITS.auditBytes,
    rpcRetentionMs: LIMITS.rpcRetentionMs, rpcRows: LIMITS.rpcRows, rpcBytes: LIMITS.rpcBytes };
  const policyFields = ["sessionMs", "claimMs", "keyMs", ...Object.keys(fixedPolicy)].sort();
  if (!meta.policy || typeof meta.policy !== "object" || Array.isArray(meta.policy) || JSON.stringify(Reflect.ownKeys(meta.policy).sort()) !== JSON.stringify(policyFields) ||
    !Number.isInteger(meta.policy.sessionMs) || meta.policy.sessionMs < 1000 || meta.policy.sessionMs > 3600000 ||
    !Number.isInteger(meta.policy.claimMs) || meta.policy.claimMs < 1000 || meta.policy.claimMs > meta.policy.sessionMs ||
    !Number.isInteger(meta.policy.keyMs) || meta.policy.keyMs < 1000 || meta.policy.keyMs > 2592000000 ||
    Object.entries(fixedPolicy).some(([field, expected]) => meta.policy[field] !== expected)) throw new Fault("schema", "Store policy is invalid");
  const counters = tx({ _store: store }, "read", ({ db }) => readMeta(db, "slotCounters"));
  if (!counters || typeof counters !== "object" || Array.isArray(counters) || Object.entries(counters).some(([runtime, value]) => {
    try { validateRuntime(runtime); return typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 10n ** 32n - 1n; }
    catch { return true; }
  })) throw new Fault("schema", "Store slot counters are invalid");
  const expectedBoards = meta.role === "hub" ? 2 : 1;
  const boardState = tx({ _store: store }, "read", ({ db }) => ({
    count: Number(db.prepare("SELECT COUNT(*) AS n FROM boards").get().n),
    host: db.prepare("SELECT 1 FROM boards WHERE id=? AND kind='host' AND device=?").get(`host:${meta.device.id}`, meta.device.id),
    bounty: db.prepare("SELECT 1 FROM boards WHERE id='bounty' AND kind='bounty' AND device IS NULL").get(),
  }));
  if (boardState.count !== expectedBoards || !boardState.host || Boolean(boardState.bounty) !== (meta.role === "hub")) throw new Fault("schema", "Store boards do not match its persisted role");
  if (options.device !== undefined && options.device !== meta.device.name) throw new Fault("device_conflict", "Store has a different device identity");
  if (options.role !== undefined && options.role !== meta.role) throw new Fault("input", "Store role does not match");
  for (const field of ["sessionMs", "claimMs", "keyMs"]) if (options[field] !== undefined && options[field] !== meta.policy[field]) throw new Fault("input", `Store ${field} differs from persisted policy`);
  return { ...store, ...meta };
}

function assertOptions(value, allowed, label) {
  input(value === undefined || (value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)), `Invalid ${label}`);
  for (const key of Reflect.ownKeys(value ?? {})) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new Fault("input", `Unknown ${label} option`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Fault("input", `Invalid ${label} option`);
  }
  return value ?? {};
}
function getSession(db, sid, now, { live = true, principal = undefined } = {}) {
  input(typeof sid === "string" && sid.length > 0 && sid.length <= 128, "Invalid session ID");
  const session = db.prepare("SELECT s.*,a.epoch AS current_epoch FROM sessions s JOIN agents a ON a.id=s.worker WHERE s.id=?").get(sid);
  if (!session || session.ended !== null || session.epoch !== session.current_epoch) throw new Fault("session", "Session is not current", { sid });
  if (principal !== undefined && session.principal !== principal) throw new Fault("denied", "Session is outside this principal scope", { sid });
  if (live && now >= session.until) throw new Fault("expired", "Session has expired", { sid });
  return session;
}
function expireWorker(db, worker, now) {
  const leases = db.prepare("SELECT l.id,l.mid FROM leases l JOIN messages m ON m.id=l.mid JOIN sessions s ON s.id=l.sid WHERE m.state='claimed' AND l.state='live' AND l.until<=? AND s.worker=?").all(now, worker);
  for (const lease of leases) {
    db.prepare("UPDATE leases SET state='expired' WHERE id=? AND state='live'").run(lease.id);
    db.prepare("UPDATE messages SET state='pending' WHERE id=? AND state='claimed'").run(lease.mid);
  }
}
function insertAudit(db, now, row) {
  const encoded = Buffer.byteLength(JSON.stringify([now, row.type, row.worker ?? null, row.sid ?? null, row.mid ?? null, row.lease ?? null, row.code ?? null, row.from ?? null, row.to ?? null, row.state ?? null]));
  const usageSql = "SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(type AS BLOB))+COALESCE(length(CAST(worker AS BLOB)),0)+COALESCE(length(CAST(sid AS BLOB)),0)+COALESCE(length(CAST(mid AS BLOB)),0)+COALESCE(length(CAST(lease AS BLOB)),0)+COALESCE(length(CAST(code AS BLOB)),0)+COALESCE(length(CAST(source AS BLOB)),0)+COALESCE(length(CAST(target AS BLOB)),0)+COALESCE(length(CAST(state AS BLOB)),0)+32),0) AS bytes FROM audit";
  const usage = db.prepare(usageSql).get();
  if (Number(usage.rows) >= LIMITS.auditRows || Number(usage.bytes) + encoded > LIMITS.auditBytes) {
    const candidates = db.prepare("SELECT seq FROM audit WHERE time<=? ORDER BY seq LIMIT 1000").all(now - LIMITS.auditRetentionMs);
    if (candidates.length) {
      const end = candidates.at(-1).seq;
      const removed = Number(db.prepare("DELETE FROM audit WHERE seq<=?").run(end).changes);
      writeMeta(db, "auditPruned", (readMeta(db, "auditPruned") ?? 0) + removed);
    }
    const remaining = db.prepare(usageSql).get();
    if (Number(remaining.rows) >= LIMITS.auditRows || Number(remaining.bytes) + encoded > LIMITS.auditBytes) throw new Fault("full", "Audit capacity is full");
  }
  const result = db.prepare("INSERT INTO audit(time,type,worker,sid,mid,lease,code,source,target,state) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(now, row.type, row.worker ?? null, row.sid ?? null, row.mid ?? null, row.lease ?? null, row.code ?? null, row.from ?? null, row.to ?? null, row.state ?? null);
  return Number(result.lastInsertRowid);
}
function releaseSessionClaims(db, sid, epoch, now) {
  const rows = db.prepare("SELECT l.id,l.mid,m.recipient FROM leases l JOIN messages m ON m.id=l.mid WHERE l.sid=? AND l.epoch=? AND l.state='live' AND m.state='claimed'").all(sid, epoch);
  for (const row of rows) {
    db.prepare("UPDATE leases SET state='released' WHERE id=?").run(row.id);
    db.prepare("UPDATE messages SET state='pending' WHERE id=?").run(row.mid);
    insertAudit(db, now, { type: "release", worker: row.recipient, sid, mid: row.mid, lease: row.id });
  }
}

export class Relay {
  constructor(store) { this._store = store; this.device = store.device; this.authority = store.authority; }

  register(runtime, options, authorization = null) {
    validateRuntime(runtime); options = assertOptions(options, ["slot", "caps"], "register");
    const caps = validateTags(options.caps ?? []);
    return tx(this, "write", ({ db, now }) => {
      const localDevice = readMeta(db, "device");
      const bound = authorization?.principal?.grant?.register?.[0];
      const device = bound
        ? db.prepare("SELECT * FROM devices WHERE id=? AND name=?").get(bound.deviceId, bound.deviceName)
        : localDevice;
      if (!device) throw new Fault("denied", "Registration device is not enrolled");
      const local = device.id === localDevice.id;
      if (!local && (readMeta(db, "role") !== "hub" || bound.allocate || options.slot === undefined || options.slot === "prime")) throw new Fault("denied", "Remote registration requires an enrolled numbered slot");
      const counters = readMeta(db, "slotCounters") ?? {};
      let slot = options.slot;
      if (slot === undefined) {
        if (!local || (bound && !bound.allocate)) throw new Fault("denied", "Registration slot allocation is not permitted");
        let next = BigInt(counters[runtime] ?? "0") + 1n;
        while (db.prepare("SELECT 1 FROM agents WHERE device=? AND runtime=? AND slot=?").get(device.id, runtime, next.toString().padStart(3, "0"))) next++;
        slot = next.toString().padStart(3, "0");
        counters[runtime] = next.toString(); writeMeta(db, "slotCounters", counters);
      } else {
        validateSlot(slot, { prime: true });
        if (local && slot !== "prime" && BigInt(slot) > BigInt(counters[runtime] ?? "0")) { counters[runtime] = BigInt(slot).toString(); writeMeta(db, "slotCounters", counters); }
      }
      const worker = `${device.name}:${runtime}:${slot}`;
      validateAddress(worker);
      const prior = db.prepare("SELECT * FROM agents WHERE id=?").get(worker);
      if (prior) {
        if (prior.device !== device.id || prior.runtime !== runtime || prior.slot !== slot) throw new Fault("device_conflict", "Worker address collides with another identity");
        if (prior.caps !== JSON.stringify(caps)) throw new Fault("device_conflict", "Worker is already registered with different capabilities");
        return agentRow(prior);
      }
      db.prepare("INSERT INTO agents(id,device,runtime,slot,caps,epoch,init) VALUES(?,?,?,?,?,0,?)").run(worker, device.id, runtime, slot, JSON.stringify(caps), now);
      insertAudit(db, now, { type: "register", worker, state: "registered" });
      return agentRow(db.prepare("SELECT * FROM agents WHERE id=?").get(worker));
    });
  }

  enroll(value, authorization = null) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Fault("input", "Invalid device");
    const keys = Object.keys(value).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["id", "init", "name"])) throw new Fault("input", "Invalid device fields");
    input(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128, "Invalid device ID");
    validateDeviceName(value.name); input(Number.isSafeInteger(value.init) && value.init >= 0, "Invalid device init");
    return tx(this, "write", ({ db, now }) => {
      if (readMeta(db, "role") !== "hub") throw new Fault("board", "Only a hub enrolls devices");
      if (authorization) {
        const grant = authorization.principal?.grant;
        if (!grant?.enroll?.some((entry) => entry.deviceId === value.id && entry.deviceName === value.name)) throw new Fault("denied", "Device enrollment is not permitted");
      }
      const byId = db.prepare("SELECT * FROM devices WHERE id=?").get(value.id);
      const byName = db.prepare("SELECT * FROM devices WHERE folded=?").get(value.name.toLowerCase());
      if ((byId && byId.name !== value.name) || (byName && byName.id !== value.id)) throw new Fault("device_conflict", "Device identity conflicts with an enrolled device");
      if (!byId) {
        if (Number(db.prepare("SELECT COUNT(*) AS n FROM devices").get().n) >= LIMITS.snapshotDevices) throw new Fault("full", "Device limit is full");
        db.prepare("INSERT INTO devices(id,name,folded,init) VALUES(?,?,?,?)").run(value.id, value.name, value.name.toLowerCase(), now);
        insertAudit(db, now, { type: "enroll", to: value.id, state: "enrolled" });
      }
      return { ...deviceRow(byId ?? db.prepare("SELECT * FROM devices WHERE id=?").get(value.id)), repeat: Boolean(byId) };
    });
  }

  join(worker, options) {
    validateAddress(worker); options = assertOptions(options, ["replace"], "join"); input(options.replace === undefined || typeof options.replace === "boolean", "Invalid replace option");
    return tx(this, "write", ({ db, now }) => {
      const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(worker);
      if (!agent) throw new Fault("target", "Worker is not registered");
      expireWorker(db, worker, now);
      const active = db.prepare("SELECT * FROM sessions WHERE worker=? AND epoch=? AND ended IS NULL AND until>? ORDER BY init DESC LIMIT 1").get(worker, agent.epoch, now);
      if (active && !options.replace) throw new Fault("active", "Worker already has a live session", { sid: active.id });
      if (active) {
        releaseSessionClaims(db, active.id, active.epoch, now);
        db.prepare("UPDATE sessions SET ended=? WHERE id=?").run(now, active.id);
      }
      const epoch = agent.epoch + 1;
      db.prepare("UPDATE agents SET epoch=? WHERE id=?").run(epoch, worker);
      const sid = id(); const until = now + this._store.policy.sessionMs;
      db.prepare("INSERT INTO sessions(id,worker,epoch,until,ended,principal,init) VALUES(?,?,?,?,NULL,NULL,?)").run(sid, worker, epoch, until, now);
      insertAudit(db, now, { type: "session", worker, state: "joined" });
      return { id: sid, worker, epoch, until, ended: null };
    });
  }

  resume(sid) {
    return tx(this, "write", ({ db, now }) => {
      const row = db.prepare("SELECT s.*,a.epoch AS current_epoch FROM sessions s JOIN agents a ON a.id=s.worker WHERE s.id=?").get(sid);
      if (!row || row.ended !== null || row.epoch !== row.current_epoch) throw new Fault("session", "Session cannot be resumed", { sid });
      if (now > row.until + LIMITS.resumeMs) throw new Fault("expired", "Session recovery window has expired", { sid });
      expireWorker(db, row.worker, now);
      const until = now + this._store.policy.sessionMs;
      db.prepare("UPDATE sessions SET until=? WHERE id=?").run(until, sid);
      return { id: sid, worker: row.worker, epoch: row.epoch, until, ended: null };
    });
  }

  renew(sid) {
    return tx(this, "write", ({ db, now }) => {
      const row = getSession(db, sid, now);
      const until = now + this._store.policy.sessionMs;
      db.prepare("UPDATE sessions SET until=? WHERE id=?").run(until, sid);
      return { id: sid, worker: row.worker, epoch: row.epoch, until, ended: null };
    });
  }

  leave(sid) {
    return tx(this, "write", ({ db, now }) => {
      const row = getSession(db, sid, now, { live: false });
      releaseSessionClaims(db, sid, row.epoch, now);
      db.prepare("UPDATE sessions SET ended=? WHERE id=?").run(now, sid);
      insertAudit(db, now, { type: "session", worker: row.worker, sid, state: "left" });
      return { sid, epoch: row.epoch, ended: now };
    });
  }

  #admit(sid, target, board, envelope, options, kind) {
    const normalized = validateEnvelope(envelope, { board: Boolean(board) });
    const needs = normalized.kind === "work" ? validateTags(options.needs ?? [], "needs") : [];
    if (normalized.kind === "msg" && (options.needs !== undefined || options.series !== undefined)) throw new Fault("input", "needs and series require work");
    const series = options.series;
    if (series !== undefined && (typeof series !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(series))) throw new Fault("input", "Invalid series ID");
    const key = options.key === undefined ? null : validateKey(options.key);
    return tx(this, "write", ({ db, now }) => {
      const session = getSession(db, sid, now);
      const sender = session.worker;
      if (kind === "send" && !db.prepare("SELECT 1 FROM agents WHERE id=?").get(target)) throw new Fault("target", "Recipient is not registered");
      if (kind === "post") {
        const boardRow = db.prepare("SELECT * FROM boards WHERE id=?").get(target);
        if (!boardRow) throw new Fault("board", "Board does not exist");
        if (boardRow.kind === "host" && (boardRow.device !== readMeta(db, "device").id || boardRow.device !== db.prepare("SELECT device FROM agents WHERE id=?").get(sender)?.device)) throw new Fault("denied", "Host board is not locally writable");
      }
      if (key !== null) {
        db.prepare("DELETE FROM send_keys WHERE until<=?").run(now);
        const prior = db.prepare("SELECT k.*,m.init FROM send_keys k JOIN messages m ON m.id=k.mid WHERE k.sender=? AND k.key=?").get(sender, key);
        const hash = fingerprint({ target, board: kind === "post" ? target : null, kind: normalized.kind, data: normalized.data, needs, series: series ?? null });
        if (prior) {
          if (prior.hash !== hash) throw new Fault("key_conflict", "Key was retained for different content", { id: prior.mid });
          return { id: prior.mid, repeat: true, init: prior.init };
        }
      }
      const totals = db.prepare("SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes,COALESCE(SUM(CASE WHEN state IN ('pending','claimed') THEN 1 ELSE 0 END),0) AS pending,COALESCE(SUM(CASE WHEN state IN ('pending','claimed') THEN length(CAST(data AS BLOB)) ELSE 0 END),0) AS pendingBytes FROM messages").get();
      if (totals.rows >= this._store.policy.retainedMessages || totals.bytes + normalized.bytes > this._store.policy.retainedBytes) throw new Fault("full", "Retained message capacity is full");
      const posted = kind === "post" && normalized.kind === "msg";
      if (!posted && (totals.pending >= this._store.policy.pendingMessages || totals.pendingBytes + normalized.bytes > this._store.policy.pendingBytes)) throw new Fault("full", "Outstanding message capacity is full");
      const mid = id(); const seq = Number(db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages").get().n);
      db.prepare("INSERT INTO messages(id,seq,sender,recipient,board,kind,needs,series,data,state,init) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(mid, seq, sender, kind === "send" ? target : null, kind === "post" ? target : null, normalized.kind, JSON.stringify(needs), series ?? null, normalized.json, posted ? "posted" : "pending", now);
      if (key !== null) {
        const hash = fingerprint({ target, board: kind === "post" ? target : null, kind: normalized.kind, data: normalized.data, needs, series: series ?? null });
        db.prepare("INSERT INTO send_keys(sender,key,mid,hash,until) VALUES(?,?,?,?,?)").run(sender, key, mid, hash, now + this._store.policy.keyMs);
      }
      insertAudit(db, now, { type: "post", worker: sender, sid, mid, from: sender, to: target, state: posted ? "posted" : "pending" });
      return { id: mid, repeat: false, init: now };
    });
  }
  send(sid, to, envelope, options) { validateAddress(to); return this.#admit(sid, to, null, envelope, assertOptions(options, ["key"], "send"), "send"); }
  post(sid, board, envelope, options) {
    if (typeof board !== "string" || !(board === "bounty" || /^host:[A-Za-z0-9._-]{1,128}$/.test(board))) throw new Fault("input", "Invalid board ID");
    return this.#admit(sid, board, board, envelope, assertOptions(options, ["key", "needs", "series"], "post"), "post");
  }

  claim(sid, options) {
    options = assertOptions(options, ["board", "kind"], "claim");
    if (options.board !== undefined && !(typeof options.board === "string" && (options.board === "bounty" || /^host:[A-Za-z0-9._-]{1,128}$/.test(options.board)))) throw new Fault("input", "Invalid board ID");
    if (options.kind !== undefined && !["msg", "work"].includes(options.kind)) throw new Fault("input", "Invalid claim kind");
    if (options.board && options.kind === "msg") throw new Fault("input", "Board claims only accept work");
    return tx(this, "write", ({ db, now }) => {
      const session = getSession(db, sid, now);
      if (options.board && !db.prepare("SELECT 1 FROM boards WHERE id=?").get(options.board)) throw new Fault("board", "Board does not exist");
      const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(session.worker);
      if (options.board) {
        const board = db.prepare("SELECT * FROM boards WHERE id=?").get(options.board);
        if (board.kind === "host" && (board.device !== readMeta(db, "device").id || board.device !== agent.device)) throw new Fault("denied", "Host board belongs to another device");
        if (board.kind === "bounty" && readMeta(db, "role") !== "hub") throw new Fault("board", "Bounty board is not local");
      }
      expireWorker(db, session.worker, now);
      const candidates = options.board
        ? db.prepare("SELECT * FROM messages WHERE board=? AND kind='work' AND state='pending' ORDER BY seq").all(options.board)
        : db.prepare("SELECT * FROM messages WHERE recipient=? AND state='pending' AND (? IS NULL OR kind=?) ORDER BY seq").all(session.worker, options.kind ?? null, options.kind ?? null);
      let chosen;
      for (const row of candidates) {
        if (options.board) {
          if (row.series) {
            const earlier = db.prepare("SELECT id,state FROM messages WHERE board=? AND series=? AND seq<? AND state IN ('pending','claimed') ORDER BY seq LIMIT 1").get(row.board, row.series, row.seq);
            if (earlier) continue;
          }
        }
        const needs = safeJson(row.needs);
        if (needs.every((tag) => safeJson(agent.caps).includes(tag))) { chosen = row; break; }
      }
      if (!chosen) return null;
      const until = Math.min(now + this._store.policy.claimMs, session.until);
      if (now >= until) throw new Fault("expired", "Session has no remaining claim time", { sid });
      const leaseId = id(); const attempt = chosen.attempt + 1;
      db.prepare("UPDATE messages SET state='claimed',attempt=? WHERE id=? AND state='pending'").run(attempt, chosen.id);
      db.prepare("INSERT INTO leases(id,mid,sid,epoch,until,attempt,state) VALUES(?,?,?,?,?,?,'live')").run(leaseId, chosen.id, sid, session.epoch, until, attempt);
      insertAudit(db, now, { type: "claim", worker: session.worker, sid, mid: chosen.id, lease: leaseId, from: chosen.sender, to: session.worker, state: "claimed" });
      return { id: leaseId, mid: chosen.id, sid, epoch: session.epoch, until, attempt, kind: chosen.kind, ...safeJson(chosen.data) };
    });
  }

  touch(sid, leaseId) {
    const result = tx(this, "write", ({ db, now }) => {
      const session = getSession(db, sid, now, { live: false });
      if (now >= session.until) { expireWorker(db, session.worker, now); return { fault: "session" }; }
      const lease = db.prepare("SELECT l.*,m.state AS message_state,m.kind,m.data FROM leases l JOIN messages m ON m.id=l.mid WHERE l.id=?").get(leaseId);
      if (!lease || lease.sid !== sid || lease.epoch !== session.epoch || lease.state !== "live" || lease.message_state !== "claimed") throw new Fault("lease", "Lease is not current", { lease: leaseId });
      if (now >= lease.until) { this.#expireLease(db, lease); return { fault: "lease" }; }
      const until = Math.min(now + this._store.policy.claimMs, session.until);
      db.prepare("UPDATE leases SET until=? WHERE id=?").run(until, leaseId);
      return { id: leaseId, mid: lease.mid, sid, epoch: lease.epoch, until, attempt: lease.attempt, kind: lease.kind, ...safeJson(lease.data) };
    });
    if (result?.fault === "session") throw new Fault("expired", "Session has expired", { sid });
    if (result?.fault === "lease") throw new Fault("expired", "Lease has expired", { lease: leaseId });
    return result;
  }

  #expireLease(db, lease) {
    db.prepare("UPDATE leases SET state='expired' WHERE id=? AND state='live'").run(lease.id);
    db.prepare("UPDATE messages SET state='pending' WHERE id=? AND state='claimed'").run(lease.mid);
  }
  ack(sid, leaseId, outcome) {
    if (!["done", "failed", "rejected"].includes(outcome)) throw new Fault("input", "Invalid acknowledgement outcome");
    const result = tx(this, "write", ({ db, now }) => {
      const session = getSession(db, sid, now, { live: false });
      if (now >= session.until) { expireWorker(db, session.worker, now); return { fault: "session" }; }
      const prior = db.prepare("SELECT * FROM receipts WHERE lease=?").get(leaseId);
      if (prior && prior.sid === sid && prior.epoch === session.epoch) {
        if (prior.outcome !== outcome) throw new Fault("ack_conflict", "Lease was acknowledged differently", { mid: prior.mid });
        return { mid: prior.mid, lease: leaseId, sid, epoch: prior.epoch, outcome: prior.outcome, time: prior.time };
      }
      const lease = db.prepare("SELECT l.*,m.state AS message_state,m.recipient FROM leases l JOIN messages m ON m.id=l.mid WHERE l.id=?").get(leaseId);
      if (!lease || lease.sid !== sid || lease.epoch !== session.epoch || lease.state !== "live" || lease.message_state !== "claimed") throw new Fault("lease", "Lease is not current", { lease: leaseId });
      if (now >= lease.until) { this.#expireLease(db, lease); return { fault: "lease" }; }
      db.prepare("UPDATE leases SET state=? WHERE id=?").run(outcome, leaseId);
      db.prepare("UPDATE messages SET state=?,acked=? WHERE id=?").run(outcome, now, lease.mid);
      db.prepare("INSERT INTO receipts(mid,lease,sid,epoch,outcome,time) VALUES(?,?,?,?,?,?)").run(lease.mid, leaseId, sid, session.epoch, outcome, now);
      insertAudit(db, now, { type: "ack", worker: session.worker, sid, mid: lease.mid, lease: leaseId, from: lease.recipient, to: session.worker, state: outcome });
      return { mid: lease.mid, lease: leaseId, sid, epoch: session.epoch, outcome, time: now };
    });
    if (result?.fault === "session") throw new Fault("expired", "Session has expired", { sid });
    if (result?.fault === "lease") throw new Fault("expired", "Lease has expired", { lease: leaseId });
    return result;
  }
  release(sid, leaseId) {
    const result = tx(this, "write", ({ db, now }) => {
      const session = getSession(db, sid, now, { live: false });
      if (now >= session.until) { expireWorker(db, session.worker, now); return { fault: "session" }; }
      const lease = db.prepare("SELECT l.*,m.state AS message_state,m.recipient,m.sender FROM leases l JOIN messages m ON m.id=l.mid WHERE l.id=?").get(leaseId);
      if (!lease || lease.sid !== sid || lease.epoch !== session.epoch || lease.state !== "live" || lease.message_state !== "claimed") throw new Fault("lease", "Lease is not current", { lease: leaseId });
      if (now >= lease.until) { this.#expireLease(db, lease); return { fault: "lease" }; }
      db.prepare("UPDATE leases SET state='released' WHERE id=?").run(leaseId);
      db.prepare("UPDATE messages SET state='pending' WHERE id=?").run(lease.mid);
      insertAudit(db, now, { type: "release", worker: session.worker, sid, mid: lease.mid, lease: leaseId, from: lease.sender, to: lease.recipient, state: "pending" });
      return { mid: lease.mid, lease: leaseId, sid, epoch: session.epoch, outcome: "released", time: now };
    });
    if (result?.fault === "session") throw new Fault("expired", "Session has expired", { sid });
    if (result?.fault === "lease") throw new Fault("expired", "Lease has expired", { lease: leaseId });
    return result;
  }

  #message(row, withData = false) {
    if (!row) return null;
    const result = { id: row.id, seq: row.seq, from: row.sender ?? null, to: row.recipient ?? null, board: row.board ?? null,
      kind: row.kind, needs: safeJson(row.needs), series: row.series ?? null, state: row.state, init: row.init, acked: row.acked ?? null };
    if (withData) result.data = safeJson(row.data);
    return result;
  }
  get(messageId, options, authorization = null) {
    options = assertOptions(options, ["data"], "get"); input(options.data === undefined || typeof options.data === "boolean", "Invalid data option");
    input(typeof messageId === "string" && messageId.length > 0 && messageId.length <= 128, "Invalid message ID");
    return tx(this, "read", ({ db }) => {
      const row = db.prepare("SELECT * FROM messages WHERE id=?").get(messageId);
      if (!row || (authorization && !canReadMessage(authorization, row))) return null;
      if (options.data === true && authorization && !canReadBody(authorization, row)) throw new Fault("denied", "Message body is outside this principal scope");
      const body = options.data === true && (!authorization || canReadBody(authorization, row));
      return this.#message(row, body);
    });
  }
  list(options, authorization = null) {
    options = assertOptions(options, ["to", "board", "kind", "state", "after", "limit", "data"], "list");
    if (options.to !== undefined && options.board !== undefined) throw new Fault("input", "to and board filters are exclusive");
    if (options.to !== undefined) validateAddress(options.to);
    if (options.board !== undefined && !(typeof options.board === "string" && (options.board === "bounty" || /^host:[A-Za-z0-9._-]{1,128}$/.test(options.board)))) throw new Fault("input", "Invalid board ID");
    if (options.kind !== undefined && !["msg", "work"].includes(options.kind)) throw new Fault("input", "Invalid kind");
    const states = ["pending", "claimed", "posted", "done", "failed", "rejected"];
    if (options.state !== undefined && !states.includes(options.state)) throw new Fault("input", "Invalid message state");
    const limit = options.limit ?? LIMITS.pageDefault;
    input(Number.isInteger(limit) && limit >= 1 && limit <= LIMITS.pageMax, "Invalid page limit");
    input(options.data === undefined || typeof options.data === "boolean", "Invalid data option");
    if (options.after !== undefined) input(typeof options.after === "string" && options.after.length > 0 && options.after.length <= 1400, "Invalid message cursor");
    const filter = { to: options.to ?? null, board: options.board ?? null, kind: options.kind ?? null, state: options.state ?? null, limit };
    const filterHash = sha(canonicalJson(filter).json); const scope = authorization?.scopeKey ?? "local";
    return tx(this, "read", ({ db }) => {
      let boundary, last = 0;
      if (options.after) {
        const token = decodeCursor(options.after);
        if (token.authority !== this.authority || token.scope !== scope || token.filter !== filterHash) throw new Fault("cursor", "Cursor does not match this query");
        boundary = token.boundary; last = token.last;
      } else boundary = Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM messages").get().n);
      const clauses = ["seq<=?"]; const params = [boundary];
      if (filter.to) { clauses.push("recipient=?"); params.push(filter.to); }
      if (filter.board) { clauses.push("board=?"); params.push(filter.board); }
      if (filter.kind) { clauses.push("kind=?"); params.push(filter.kind); }
      if (filter.state) { clauses.push("state=?"); params.push(filter.state); }
      const where = clauses.join(" AND ");
      const visibleRows = db.prepare(`SELECT * FROM messages WHERE ${where} ORDER BY seq`).all(...params)
        .filter((row) => !authorization || canReadMessage(authorization, row));
      const total = visibleRows.length;
      const rows = visibleRows.filter((row) => row.seq > last).slice(0, limit + 1);
      const more = rows.length > limit; if (more) rows.pop();
      const nextLast = rows.length ? rows.at(-1).seq : last;
      const next = more ? encodeCursor({ v: 1, authority: this.authority, scope, filter: filterHash, boundary, last: nextLast }) : null;
      const firstRows = (filter.board || filter.kind) ? db.prepare(`SELECT * FROM messages WHERE seq<=?${filter.to ? " AND recipient=?" : ""}${filter.board ? " AND board=?" : ""}${filter.kind ? " AND kind=?" : ""} ORDER BY seq`).all(...[boundary, filter.to, filter.board, filter.kind].filter((value) => value !== null)) : [];
      const firstSeq = firstRows.find((row) => !authorization || canReadMessage(authorization, row))?.seq ?? null;
      const prunedMeta = readMessagePruned(db);
      const pruned = filter.board ? [filter.kind ?? "msg", ...(filter.kind ? [] : ["work"])].reduce((sum, kind) => {
        const row = { board: filter.board, kind };
        return sum + (!authorization || canReadMessage(authorization, row) ? (prunedMeta[retentionKey(filter.board, kind)] ?? 0) : 0);
      }, 0) : 0;
      if (options.data === true && authorization && rows.some((row) => !canReadBody(authorization, row))) throw new Fault("denied", "Message body is outside this principal scope");
      const page = { items: rows.map((row) => this.#message(row, options.data === true)), total, visible: rows.length, complete: !more,
        cursor: encodeCursor({ v: 1, authority: this.authority, scope, filter: filterHash, boundary, last: nextLast }), next, firstSeq, pruned };
      return page;
    });
  }
  stats() {
    return tx(this, "read", ({ db, now }) => {
      const counts = Object.fromEntries(db.prepare("SELECT state,COUNT(*) AS n FROM messages GROUP BY state").all().map((r) => [r.state, Number(r.n)]));
      const msg = db.prepare("SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM messages").get();
      return { authority: this.authority, time: now, messages: { pending: counts.pending ?? 0, claimed: counts.claimed ?? 0, posted: counts.posted ?? 0, done: counts.done ?? 0, failed: counts.failed ?? 0, rejected: counts.rejected ?? 0, rows: Number(msg.rows), bytes: Number(msg.bytes) },
        sessions: { live: Number(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE ended IS NULL AND until>?").get(now).n), ended: Number(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE ended IS NOT NULL").get().n) },
        leases: { live: Number(db.prepare("SELECT COUNT(*) AS n FROM leases WHERE state='live' AND until>?").get(now).n), total: Number(db.prepare("SELECT COUNT(*) AS n FROM leases").get().n) },
        receipts: Number(db.prepare("SELECT COUNT(*) AS n FROM receipts").get().n), devices: Number(db.prepare("SELECT COUNT(*) AS n FROM devices").get().n),
        agents: Number(db.prepare("SELECT COUNT(*) AS n FROM agents").get().n), boards: Number(db.prepare("SELECT COUNT(*) AS n FROM boards").get().n),
        audit: { rows: Number(db.prepare("SELECT COUNT(*) AS n FROM audit").get().n), pruned: readMeta(db, "auditPruned") ?? 0 } };
    });
  }
  audit(options) {
    options = assertOptions(options, ["after", "limit"], "audit");
    const limit = options.limit ?? LIMITS.pageDefault; input(Number.isInteger(limit) && limit >= 1 && limit <= LIMITS.pageMax, "Invalid page limit");
    if (options.after !== undefined) input(typeof options.after === "string" && options.after.length > 0 && options.after.length <= 1400, "Invalid audit cursor");
    const filterHash = sha(canonicalJson({ kind: "audit", limit }).json);
    return tx(this, "read", ({ db }) => {
      let boundary, last = 0;
      if (options.after) { const token = decodeCursor(options.after); if (token.authority !== this.authority || token.scope !== "local" || token.filter !== filterHash) throw new Fault("cursor", "Cursor does not match audit query"); boundary = token.boundary; last = token.last; }
      else boundary = Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM audit").get().n);
      const total = Number(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE seq<=?").get(boundary).n);
      const rows = db.prepare("SELECT * FROM audit WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?").all(last, boundary, limit + 1);
      const more = rows.length > limit; if (more) rows.pop(); const nextLast = rows.length ? rows.at(-1).seq : last;
      return { items: rows.map((r) => ({ seq: r.seq, time: r.time, type: r.type, worker: r.worker, sid: r.sid, mid: r.mid, lease: r.lease, code: r.code })), total, visible: rows.length, complete: !more,
        cursor: encodeCursor({ v: 1, authority: this.authority, scope: "local", filter: filterHash, boundary, last: nextLast }),
        next: more ? encodeCursor({ v: 1, authority: this.authority, scope: "local", filter: filterHash, boundary, last: nextLast }) : null,
        firstSeq: db.prepare("SELECT MIN(seq) AS n FROM audit").get().n ?? null, pruned: readMeta(db, "auditPruned") ?? 0 };
    });
  }
  report(sid, report, authorization = null) {
    input(report && typeof report === "object" && !Array.isArray(report), "Invalid report");
    canonicalJson(report, LIMITS.reportBytes);
    input(Number.isSafeInteger(report.seq) && report.seq >= 1, "Invalid report");
    const rootKeys = Object.keys(report).sort();
    const expectedKeys = report.events === undefined ? ["agents", "board", "seq"] : ["agents", "board", "events", "seq"];
    if (JSON.stringify(rootKeys) !== JSON.stringify(expectedKeys)) throw new Fault("input", "Invalid report fields");
    input(Array.isArray(report.agents) && report.agents.length <= LIMITS.snapshotAgents, "Invalid report agents");
    const board = report.board;
    input(board && typeof board === "object" && !Array.isArray(board) && JSON.stringify(Object.keys(board).sort()) === JSON.stringify(["claimed", "id", "inbox", "pending", "terminal"]), "Invalid report board");
    for (const field of ["inbox", "pending", "claimed", "terminal"]) input(Number.isSafeInteger(board[field]) && board[field] >= 0, "Invalid report counts");
    if (report.events !== undefined) {
      input(Array.isArray(report.events) && report.events.length <= LIMITS.feedEvents, "Invalid report events");
      for (const event of report.events) {
        input(JSON.stringify(Object.keys(event ?? {}).sort()) === JSON.stringify(["code", "from", "mid", "seq", "state", "to", "type"]), "Invalid report event fields");
        input(event && Number.isSafeInteger(event.seq) && event.seq >= 1 && ["post", "claim", "release", "ack", "refusal"].includes(event.type), "Invalid report event");
        input(typeof event.from === "string" && typeof event.to === "string" && (event.mid === null || typeof event.mid === "string"), "Invalid report event endpoints");
        input(Buffer.byteLength(event.from) <= LIMITS.workerAddressBytes && Buffer.byteLength(event.to) <= LIMITS.workerAddressBytes && (event.mid === null || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.mid)), "Invalid report event size");
        input(event.code === null || faultCodes.has(event.code), "Invalid report event code");
        input(reportEventStates[event.type].includes(event.state) && (event.type === "refusal" ? event.code !== null : event.code === null), "Invalid report event state");
      }
    }
    for (const item of report.agents) {
      input(JSON.stringify(Object.keys(item ?? {}).sort()) === JSON.stringify(["assignmentCount", "free", "state", "worker"]), "Invalid report agent fields");
      validateAddress(item.worker);
      input(item && typeof item.worker === "string" && ["starting", "ready", "busy", "unknown"].includes(item.state), "Invalid report agent");
      input(item.free === null || item.free === 0 || item.free === 1, "Invalid reported capacity");
      input(item.assignmentCount === 0 || item.assignmentCount === 1, "Invalid assignment count");
    }
    return tx(this, "write", ({ db, now }) => {
      const session = getSession(db, sid, now);
      const device = db.prepare("SELECT * FROM devices WHERE id=(SELECT device FROM agents WHERE id=?)").get(session.worker);
      if (authorization) {
        const principal = authorization.principal;
        if (!principal?.id || session.principal !== principal.id || principal.grant?.reportDevice !== device.id) throw new Fault("denied", "Report is outside this principal scope");
      }
      const exactBoard = `host:${device.id}`;
      if (board.id !== exactBoard) throw new Fault("denied", "Report board is outside the device namespace");
      const prior = db.prepare("SELECT * FROM reports WHERE device=?").get(device.id);
      if (prior && prior.sid === sid && prior.epoch === session.epoch && report.seq <= prior.seq) throw new Fault("input", "Report sequence must increase");
      for (const item of report.agents) {
        const agent = db.prepare("SELECT id FROM agents WHERE id=? AND device=?").get(item.worker, device.id);
        if (!agent) throw new Fault("denied", "Report contains a foreign worker");
      }
      const endpointExists = (endpoint) => endpoint === exactBoard || Boolean(db.prepare("SELECT 1 FROM agents WHERE id=? AND device=?").get(endpoint, device.id));
      for (const event of report.events ?? []) {
        if (!endpointExists(event.from) || !endpointExists(event.to)) throw new Fault("denied", "Report event contains a foreign endpoint");
      }
      db.prepare("INSERT INTO reports(device,sid,epoch,seq,received,report) VALUES(?,?,?,?,?,?) ON CONFLICT(device) DO UPDATE SET sid=excluded.sid,epoch=excluded.epoch,seq=excluded.seq,received=excluded.received,report=excluded.report")
        .run(device.id, sid, session.epoch, report.seq, now, JSON.stringify(report));
      insertAudit(db, now, { type: "report", worker: session.worker, state: "reported" });
      for (const event of report.events ?? []) {
        const inserted = db.prepare("INSERT OR IGNORE INTO report_events(device,sid,source_seq,time,type,source,target,mid,state,code) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(device.id, sid, event.seq, now, event.type, event.from, event.to, event.mid, event.state, event.code);
        if (inserted.changes) insertAudit(db, now, { type: event.type, worker: event.to, mid: event.mid, code: event.code, from: event.from, to: event.to, state: event.state });
      }
      return { accepted: true, receivedAt: now, staleAfter: LIMITS.reportStaleMs, seq: report.seq };
    });
  }

  snapshot(options, stream = randomUUID(), scope = "local") {
    options = assertOptions(options, ["device", "limit", "after"], "snapshot");
    const limit = options.limit ?? LIMITS.snapshotAgents;
    input(Number.isInteger(limit) && limit >= 1 && limit <= LIMITS.snapshotAgents, "Invalid snapshot limit");
    if (options.device !== undefined) input(typeof options.device === "string" && options.device.length > 0 && options.device.length <= 128, "Invalid device filter");
    if (options.after !== undefined) input(typeof options.after === "string" && options.after.length > 0 && options.after.length <= 1400, "Invalid snapshot cursor");
    const filter = { device: options.device ?? null, limit };
    const filterHash = sha(canonicalJson(filter).json);
    return tx(this, "read", ({ db, now }) => {
      const currentBoundary = Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM audit").get().n);
      let boundary = currentBoundary;
      let lastAgent = ""; let lastLink = ""; let tokenTime = now;
      if (options.after) {
        const token = decodeSnapshotCursor(options.after);
        if (token.authority !== this.authority || token.scope !== scope || token.filter !== filterHash) throw new Fault("reset", "Snapshot scope changed");
        if (token.boundary !== currentBoundary) throw new Fault("reset", "Snapshot changed during pagination");
        boundary = token.boundary; lastAgent = token.last.agent ?? ""; lastLink = token.last.link ?? ""; tokenTime = token.time;
      }
      const devices = db.prepare("SELECT * FROM devices WHERE (? IS NULL OR id=?) ORDER BY id LIMIT ?").all(filter.device, filter.device, LIMITS.snapshotDevices + 1);
      if (devices.length > LIMITS.snapshotDevices) throw new Fault("full", "Snapshot device limit exceeded");
      const agentsAll = db.prepare("SELECT * FROM agents WHERE (? IS NULL OR device=?) ORDER BY id").all(filter.device, filter.device);
      const reports = new Map(db.prepare("SELECT * FROM reports").all().map((row) => [row.device, row]));
      const reportData = new Map([...reports].map(([device, row]) => [device, safeJson(row.report)]));
      const agents = agentsAll.map((row) => {
        const report = reportData.get(row.device); const reported = report?.agents?.find((a) => a.worker === row.id);
        const active = db.prepare("SELECT COUNT(*) AS n FROM leases l JOIN messages m ON m.id=l.mid WHERE l.sid IN (SELECT id FROM sessions WHERE worker=? AND epoch=(SELECT epoch FROM agents WHERE id=?)) AND l.state='live' AND l.until>?").get(row.id, row.id, now).n;
        const age = reports.get(row.device) ? tokenTime - reports.get(row.device).received : Infinity;
        let state = "registered";
        if (age > LIMITS.reportStaleMs && reports.has(row.device)) state = "stale";
        else if (reported) state = reported.state;
        else if (active) state = "busy";
        return { ...agentRow(row), state, assignmentCount: Number(active), receivedAt: reports.get(row.device)?.received ?? null };
      });
      const boards = db.prepare("SELECT * FROM boards WHERE (? IS NULL OR device=? OR kind='bounty') ORDER BY id").all(filter.device, filter.device).map((row) => {
        const counts = db.prepare("SELECT kind,state,COUNT(*) AS n FROM messages WHERE board=? GROUP BY kind,state").all(row.id);
        const count = (kind, state) => Number(counts.find((r) => r.kind === kind && r.state === state)?.n ?? 0);
        const report = row.device ? reports.get(row.device) : null;
        return { id: row.id, kind: row.kind, device: row.device, authority: this.authority,
          inbox: row.kind === "host" && report ? safeJson(report.report).board.inbox : count("msg", "posted"),
          pending: row.kind === "host" && report ? safeJson(report.report).board.pending : count("work", "pending"),
          claimed: row.kind === "host" && report ? safeJson(report.report).board.claimed : count("work", "claimed"),
          terminal: count("work", "done") + count("work", "failed") + count("work", "rejected"),
          reported: Boolean(report), receivedAt: report?.received ?? null };
      });
      const links = db.prepare("SELECT m.id,m.sender,m.recipient,m.board,m.init,s.worker FROM messages m JOIN leases l ON l.mid=m.id AND l.state='live' JOIN sessions s ON s.id=l.sid JOIN agents a ON a.id=s.worker WHERE m.state='claimed' AND l.until>? AND s.ended IS NULL AND s.epoch=a.epoch AND (? IS NULL OR a.device=?) ORDER BY m.id")
        .all(tokenTime, filter.device, filter.device).map((row) => ({ id: `assignment:${row.id}`, from: row.board ?? row.sender ?? "", to: row.worker, kind: row.board ? "board" : "addressed", state: "active", mid: row.id, time: row.init }));
      const visibleAgents = agents.filter((a) => a.id > lastAgent).slice(0, limit);
      const visibleLinks = links.filter((item) => item.id > lastLink).slice(0, limit);
      const clipped = agents.filter((a) => a.id > lastAgent).length > visibleAgents.length || links.filter((item) => item.id > lastLink).length > visibleLinks.length;
      const cursor = encodeFeedCursor({ v: 1, authority: this.authority, stream, seq: boundary, scope });
      const next = clipped ? encodeSnapshotCursor({ v: 1, authority: this.authority, scope, filter: filterHash, boundary, time: tokenTime, last: {
        agent: visibleAgents.at(-1)?.id ?? lastAgent, link: visibleLinks.at(-1)?.id ?? lastLink,
      } }) : null;
      const visible = { devices: devices.length, agents: visibleAgents.length, boards: boards.length, links: visibleLinks.length };
      return { v: 1, authority: this.authority, time: tokenTime, cursor, devices: devices.map((r) => ({ ...deviceRow(r), authority: this.authority,
        receivedAt: reports.get(r.id)?.received ?? null, stale: reports.has(r.id) ? tokenTime - reports.get(r.id).received > LIMITS.reportStaleMs : false,
        free: reports.has(r.id) && tokenTime - reports.get(r.id).received <= LIMITS.reportStaleMs ? safeJson(reports.get(r.id).report).agents.reduce((sum, a) => sum + (a.free ?? 0), 0) : null })),
        agents: visibleAgents, boards, links: visibleLinks,
        totals: { devices: devices.length, agents: agents.length, boards: boards.length, links: links.length }, visible, complete: !clipped, next };
    });
  }
  purge(options) {
    options = assertOptions(options, ["before", "dry"], "purge");
    input(Number.isSafeInteger(options.before) && options.before >= 0, "Invalid purge cutoff"); input(options.dry === undefined || typeof options.dry === "boolean", "Invalid dry option");
    return tx(this, options.dry ? "read" : "write", ({ db, now }) => {
      const cutoff = Math.min(options.before, now - this._store.policy.terminalRetentionMs);
      const eligible = db.prepare("SELECT id,board,kind FROM messages m WHERE state IN ('posted','done','failed','rejected') AND COALESCE(acked,init)<=? AND NOT EXISTS(SELECT 1 FROM send_keys k WHERE k.mid=m.id AND k.until>?) AND NOT EXISTS(SELECT 1 FROM rpc r WHERE r.mid=m.id AND r.until>?) LIMIT 10000").all(cutoff, now, now);
      if (!options.dry) {
        const pruned = readMessagePruned(db);
        for (const row of eligible) {
          if (!row.board) continue;
          const key = retentionKey(row.board, row.kind);
          const count = pruned[key] ?? 0;
          if (!Number.isSafeInteger(count) || count >= Number.MAX_SAFE_INTEGER) throw new Fault("full", "Message retention count is full");
          pruned[key] = count + 1;
        }
        writeMeta(db, "messagePruned", pruned);
        db.prepare("DELETE FROM send_keys WHERE until<=?").run(now);
        for (const row of eligible) {
        db.prepare("DELETE FROM receipts WHERE mid=?").run(row.id); db.prepare("DELETE FROM leases WHERE mid=?").run(row.id); db.prepare("DELETE FROM messages WHERE id=?").run(row.id);
        }
      }
      return { dry: options.dry === true, eligible: eligible.length, removed: options.dry ? 0 : eligible.length, before: cutoff };
    });
  }
  close() { closeDatabase(this._store); }
}

function makeRelay(store) {
  Object.defineProperty(store, "root", { writable: false, configurable: false });
  const relay = new Relay(store);
  openRelays.set(relay, store);
  return relay;
}

function encodeCursor(token) { return Buffer.from(canonicalJson(token, 1024).json).toString("base64url"); }
function encodeSnapshotCursor(token) { return Buffer.from(canonicalJson(token, 1024).json).toString("base64url"); }
function encodeFeedCursor(token) { return Buffer.from(canonicalJson(token, 512).json).toString("base64url"); }
function decodeSnapshotCursor(value) {
  if (typeof value !== "string" || value.length > 1400 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Fault("reset", "Invalid snapshot cursor");
  try {
    const raw = Buffer.from(value, "base64url"); if (raw.length > 1024 || raw.toString("base64url") !== value) throw new Error();
    const token = JSON.parse(raw.toString("utf8"));
    if (JSON.stringify(Object.keys(token).sort()) !== JSON.stringify(["authority", "boundary", "filter", "last", "scope", "time", "v"]) || token.v !== 1 || !Number.isSafeInteger(token.boundary) || token.boundary < 0 || !Number.isSafeInteger(token.time) || token.time < 0 || !token.last || typeof token.last !== "object" || Array.isArray(token.last) || JSON.stringify(Object.keys(token.last).sort()) !== JSON.stringify(["agent", "link"]) || !["string", "object"].includes(typeof token.last.agent) || (token.last.agent !== null && typeof token.last.agent !== "string") || !["string", "object"].includes(typeof token.last.link) || (token.last.link !== null && typeof token.last.link !== "string") || canonicalJson(token, 1024).json !== raw.toString("utf8")) throw new Error();
    return token;
  } catch { throw new Fault("reset", "Invalid snapshot cursor"); }
}
function decodeCursor(value) {
  if (typeof value !== "string" || value.length > 1400 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Fault("cursor", "Invalid cursor");
  try { const raw = Buffer.from(value, "base64url"); if (raw.length > 1024 || raw.toString("base64url") !== value) throw new Error(); const token = JSON.parse(raw.toString("utf8"));
    if (JSON.stringify(Object.keys(token).sort()) !== JSON.stringify(["authority", "boundary", "filter", "last", "scope", "v"]) || token.v !== 1 || !Number.isSafeInteger(token.boundary) || !Number.isSafeInteger(token.last) || [token.authority, token.filter, token.scope].some((part) => typeof part !== "string") || canonicalJson(token, 1024).json !== raw.toString("utf8")) throw new Error(); return token;
  } catch { throw new Fault("cursor", "Invalid cursor"); }
}

export function open(options) {
  assertOptions(options, ["root", "device", "role", "sessionMs", "claimMs", "keyMs", "readOnly"], "open");
  if (typeof options.root !== "string" || !options.root || options.root.includes("\0")) throw new Fault("input", "Store root is required");
  if (options.device !== undefined) validateDeviceName(options.device);
  if (options.role !== undefined && !["host", "hub"].includes(options.role)) throw new Fault("input", "Invalid store role");
  if (options.readOnly !== undefined && typeof options.readOnly !== "boolean") throw new Fault("input", "Invalid readOnly option");
  const sessionMs = options.sessionMs ?? LIMITS.sessionMs; const claimMs = options.claimMs ?? LIMITS.claimMs; const keyMs = options.keyMs ?? LIMITS.keyMs;
  input(Number.isInteger(sessionMs) && sessionMs >= 1000 && sessionMs <= 3600000, "Invalid session lifetime");
  input(Number.isInteger(claimMs) && claimMs >= 1000 && claimMs <= sessionMs, "Invalid claim lifetime");
  input(Number.isInteger(keyMs) && keyMs >= 1000 && keyMs <= 2592000000, "Invalid key lifetime");
  if (options.role === "hub" && options.device === undefined) {
    // Existing hub opens may omit the name; a new hub setup may not.
    const dbPath = join(options.root, "relay.sqlite");
    if (!existsSync(dbPath)) throw new Fault("input", "Hub setup requires a device name");
  }
  if (!existsSync(join(options.root, "relay.sqlite"))) validateDeviceName(options.device ?? hostname());
  const store = openDatabase({ root: options.root, create: !options.readOnly, readOnly: options.readOnly === true });
  try {
    if (!options.readOnly) initStore(store, options);
    const loaded = loadStore(store, options);
    return makeRelay(loaded);
  } catch (error) { closeDatabase(store); throw error; }
}
export function relayRoot(relay) {
  const store = openRelays.get(relay);
  if (!store) throw new Fault("input", "Invalid Relay handle");
  if (store.closed) throw new Fault("storage", "Store handle is closed");
  return store.root;
}
export function setup(options) {
  assertOptions(options, ["root", "device", "role"], "setup");
  if (typeof options.root !== "string" || !options.root || options.root.includes("\0")) throw new Fault("input", "Store root is required");
  if (options.device !== undefined) validateDeviceName(options.device);
  if (options.role !== undefined && !["host", "hub"].includes(options.role)) throw new Fault("input", "Invalid store role");
  if (options.role === "hub" && options.device === undefined && !existsSync(join(options.root, "relay.sqlite"))) throw new Fault("input", "Hub setup requires a device name");
  if (!existsSync(join(options.root, "relay.sqlite"))) validateDeviceName(options.device ?? hostname());
  const store = openDatabase({ root: options.root, create: true, readOnly: false });
  try { const device = initStore(store, options); closeDatabase(store); return device; }
  catch (error) { closeDatabase(store); throw error; }
}
export function openForBroker(options) {
  const store = openDatabase({ root: options.root, create: false, readOnly: false, busyTimeoutMs: LIMITS.brokerBusyTimeoutMs });
  try {
    const loaded = loadStore(store, { role: options.role });
    return makeRelay(loaded);
  } catch (error) { closeDatabase(store); throw error; }
}

const readOps = new Set(["get", "list", "stats", "audit", "snapshot", "attempt"]);
const rpcOps = new Set(["register", "enroll", "join", "resume", "renew", "leave", "send", "post", "claim", "touch", "ack", "release", "get", "list", "stats", "audit", "report", "snapshot", "attempt"]);
const rpcFields = {
  register: ["runtime", "options"], enroll: ["device"], join: ["worker", "options"], resume: ["sid"], renew: ["sid"], leave: ["sid"],
  send: ["sid", "to", "envelope", "options"], post: ["sid", "board", "envelope", "options"], claim: ["sid", "options"],
  touch: ["sid", "lease"], ack: ["sid", "lease", "outcome"], release: ["sid", "lease"], get: ["id", "options"], list: ["options"],
  stats: [], audit: ["options"], report: ["sid", "report"], snapshot: ["options"], attempt: ["sid", "lease"],
};
function grantHas(list, value) { return Array.isArray(list) && list.includes(value); }
function canReadMessage(authorization, row) {
  const grant = authorization.principal.grant;
  if (row.board) return grantHas(row.kind === "msg" ? grant.inboxRead : grant.workRead, row.board);
  return grantHas(grant.workers, row.recipient) || grant.inspect?.messages === true;
}
function canReadBody(authorization, row) {
  const grant = authorization.principal.grant;
  if (row.board) return grantHas(row.kind === "msg" ? grant.inboxRead : grant.workRead, row.board);
  return grant.inspect?.messages === true;
}
function authorizeCore(relay, authorization, op, args) {
  const principal = authorization?.principal;
  if (!principal || typeof principal.id !== "string" || !principal.grant) throw new Fault("auth", "Missing principal authorization");
  const grant = principal.grant;
  const worker = (sid) => {
    const row = relay._store.db.prepare("SELECT worker,principal FROM sessions WHERE id=?").get(sid);
    if (!row || (!localPoolAuthorizations.has(authorization) && row.principal && row.principal !== principal.id) || !grantHas(grant.workers, row.worker)) throw new Fault("denied", "Worker is outside this principal scope", { sid });
    return row.worker;
  };
  if (op === "register") {
    const bound = grant.register?.[0];
    const local = bound?.deviceId === relay.device.id && bound?.deviceName === relay.device.name;
    if (!bound || !bound.runtimes.includes(args.runtime) || (bound.allocate && !local) || (!bound.allocate && args.options?.slot === undefined) || (!local && args.options?.slot === undefined) || args.options?.slot === "prime") throw new Fault("denied", "Registration is outside this principal scope");
  } else if (op === "enroll") {
    const device = args.device; if (!grant.enroll?.some((item) => item.deviceId === device.id && item.deviceName === device.name)) throw new Fault("denied", "Enrollment is outside this principal scope");
  } else if (op === "join") {
    if (!grantHas(grant.workers, args.worker)) throw new Fault("denied", "Worker is outside this principal scope");
  } else if (["resume", "renew", "leave", "claim", "touch", "ack", "release", "send", "post", "report", "attempt"].includes(op)) {
    const wid = worker(args.sid);
    if (op === "send" && !grantHas(grant.recipients, args.to)) throw new Fault("denied", "Recipient is outside this principal scope");
    if (op === "post" && !grantHas(grant.boardPost, args.board)) throw new Fault("denied", "Board is outside this principal scope");
    if (op === "claim" && args.options?.board && !grantHas(grant.boardClaim, args.options.board)) throw new Fault("denied", "Board is outside this principal scope");
    if (op === "claim" && !args.options?.board && !grantHas(grant.workers, wid)) throw new Fault("denied", "Worker is outside this principal scope");
    if (op === "report") {
      const session = relay._store.db.prepare("SELECT s.principal,s.epoch,a.epoch AS current_epoch,a.device FROM sessions s JOIN agents a ON a.id=s.worker WHERE s.id=?").get(args.sid);
      if (!session || session.principal !== principal.id || session.epoch !== session.current_epoch || grant.reportDevice !== session.device) throw new Fault("denied", "Report is outside this principal scope");
    }
  } else if (op === "get") {
    // Row-dependent scope is checked in the same transaction below.
  } else if (["list", "stats", "audit", "snapshot"].includes(op)) {
    if (op === "audit" && !grant.inspect?.audit) throw new Fault("denied", "Audit inspection is not permitted");
    if (op === "snapshot" && !grant.inspect?.topology) throw new Fault("denied", "Topology inspection is not permitted");
    if (op === "stats" && !grant.inspect?.messages) throw new Fault("denied", "Message inspection is not permitted");
    if (op === "list") {
      const query = args.options ?? {};
      if (query.to && !grantHas(grant.workers, query.to) && !grant.inspect?.messages) throw new Fault("denied", "Message inspection is not permitted");
      if (query.board && !grantHas(query.kind === "msg" ? grant.inboxRead : grant.workRead, query.board)) throw new Fault("denied", "Board inspection is not permitted");
      if (query.data && query.board && !grantHas(query.kind === "msg" ? grant.inboxRead : grant.workRead, query.board)) throw new Fault("denied", "Board body inspection is not permitted");
    }
  }
}

function replayResult(relay, row, authorization) {
  const result = safeJson(row.result);
  if (row.sid) {
    const session = relay._store.db.prepare("SELECT s.*,a.epoch AS current_epoch FROM sessions s JOIN agents a ON a.id=s.worker WHERE s.id=?").get(row.sid);
    const local = localPoolAuthorizations.has(authorization);
    if (!session || (!local && session.principal !== authorization.principal.id) || session.epoch !== row.epoch || session.epoch !== session.current_epoch) throw new Fault("session", "Request outcome belongs to a superseded session", { sid: row.sid });
  }
  if (row.op === "claim") {
    const lease = relay._store.db.prepare("SELECT l.*,m.kind,m.data,m.state AS message_state FROM leases l JOIN messages m ON m.id=l.mid WHERE l.id=?").get(row.lease);
    if (!lease || lease.state !== "live" || lease.message_state !== "claimed" || lease.until <= Date.now() || lease.sid !== row.sid || lease.epoch !== row.epoch) throw new Fault("expired", "Claim replay is no longer live", { lease: row.lease });
    return { id: lease.id, mid: lease.mid, sid: lease.sid, epoch: lease.epoch, until: lease.until, attempt: lease.attempt, kind: lease.kind, ...safeJson(lease.data) };
  }
  return result;
}

function invoke(relay, op, args, authorization) {
  switch (op) {
    case "register": return relay.register(args.runtime, args.options, authorization);
    case "enroll": return relay.enroll(args.device, authorization);
    case "join": return relay.join(args.worker, args.options);
    case "resume": return relay.resume(args.sid);
    case "renew": return relay.renew(args.sid);
    case "leave": return relay.leave(args.sid);
    case "send": return relay.send(args.sid, args.to, args.envelope, args.options);
    case "post": return relay.post(args.sid, args.board, args.envelope, args.options);
    case "claim": return relay.claim(args.sid, args.options);
    case "touch": return relay.touch(args.sid, args.lease);
    case "ack": return relay.ack(args.sid, args.lease, args.outcome);
    case "release": return relay.release(args.sid, args.lease);
    case "get": return relay.get(args.id, args.options, authorization);
    case "list": return relay.list(args.options, authorization);
    case "stats": return relay.stats();
    case "audit": return relay.audit(args.options);
    case "report": return relay.report(args.sid, args.report, authorization);
    case "snapshot": return relay.snapshot(args.options, undefined, authorization.scopeKey);
    case "attempt": return inspectAttempt(relay, args, authorization);
    default: throw new Fault("protocol", "Unsupported operation");
  }
}

export function dispatchRpc(relay, { authorization, rid, op, args, beforeCommit }) {
  input(rpcOps.has(op) && authorization?.operation === op, "RPC operation is not authorized");
  input(typeof rid === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(rid), "Invalid request ID");
  input(args && typeof args === "object" && !Array.isArray(args), "Invalid operation arguments");
  if (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null) throw new Fault("input", "Invalid operation arguments");
  canonicalJson(args, LIMITS.requestBytes);
  if (Object.keys(args).some((key) => !rpcFields[op].includes(key))) throw new Fault("input", "Unknown operation argument");
  for (const required of rpcFields[op]) {
    if (!["options"].includes(required) && !own(args, required)) throw new Fault("input", "Missing operation argument");
  }
  input(typeof beforeCommit === "function", "Missing final authorization gate");
  authorizeCore(relay, authorization, op, args);
  const principal = authorization.principal.id;
  const hash = fingerprint({ v: 1, op, args });
  const write = !readOps.has(op);
  return tx(relay, write ? "write" : "read", ({ db, now }) => {
    if (write) {
      db.prepare("DELETE FROM rpc WHERE until<=?").run(now);
      const usage = db.prepare("SELECT COUNT(*) AS rows,COALESCE(SUM(bytes),0) AS bytes FROM rpc").get();
      if (Number(usage.rows) >= relay._store.policy.rpcRows) throw new Fault("full", "RPC journal is full");
    }
    const prior = db.prepare("SELECT * FROM rpc WHERE principal=? AND rid=?").get(principal, rid);
    if (prior) {
      if (prior.hash !== hash || prior.op !== op) throw new Fault("rpc_conflict", "Request ID was used for different content");
      const result = replayResult(relay, prior, authorization);
      beforeCommit();
      return { v: 1, rid, committedAt: prior.committed, replayed: true, result, remainingMs: op === "claim" && result ? Math.max(0, result.until - Date.now()) : null };
    }
    const result = invoke(relay, op, args, authorization);
    let sid = args.sid ?? result?.sid ?? (op === "join" ? result?.id : null);
    const originalSession = sid ? db.prepare("SELECT worker,epoch FROM sessions WHERE id=?").get(sid) : null;
    let epoch = result?.epoch ?? originalSession?.epoch ?? null;
    let worker = result?.worker ?? originalSession?.worker ?? null;
    if (op === "join" && result) {
      worker = result.worker; sid = result.id; epoch = result.epoch;
      db.prepare("UPDATE sessions SET principal=? WHERE id=?").run(principal, sid);
    }
    const lease = op === "claim" && result ? result.id : args.lease ?? null;
    const mid = op === "claim" && result ? result.mid : result?.mid ?? result?.id ?? null;
    const stored = op === "claim" ? (result ? { claimed: true } : null) : result;
    const json = JSON.stringify(stored);
    const bytes = Buffer.byteLength(json);
    if (Number(db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM rpc").get().n) + bytes > relay._store.policy.rpcBytes) throw new Fault("full", "RPC journal byte capacity is full");
    if (op !== "attempt") db.prepare("INSERT INTO rpc(principal,rid,op,hash,committed,until,worker,sid,epoch,mid,lease,result,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(principal, rid, op, hash, now, now + relay._store.policy.rpcRetentionMs, worker, sid, epoch, mid, lease, json, bytes);
    beforeCommit();
    return { v: 1, rid, committedAt: op === "attempt" ? null : now, replayed: false, result, remainingMs: op === "claim" && result ? Math.max(0, result.until - Date.now()) : null };
  });
}

export function dispatchLocalPool(relay, { rid, op, args }) {
  input(["claim", "ack", "release"].includes(op), "Invalid local pool operation");
  const worker = args.sid ? relay._store.db.prepare("SELECT worker FROM sessions WHERE id=?").get(args.sid)?.worker : "";
  const authorization = { operation: op, principal: { id: `local:${relay.authority}`, grant: { workers: [worker], boardClaim: ["bounty", `host:${relay.device.id}`] } }, scopeKey: "local" };
  const beforeCommit = () => {};
  localPoolAuthorizations.add(authorization);
  try { return dispatchRpc(relay, { authorization, rid, op, args, beforeCommit }); }
  finally { localPoolAuthorizations.delete(authorization); }
}

export function inspectAttempt(relay, { sid, lease }, authorization = null) {
  input(typeof sid === "string" && sid.length > 0 && sid.length <= 128 && typeof lease === "string" && lease.length > 0 && lease.length <= 128, "Invalid attempt identity");
  return tx(relay, "read", ({ db, now }) => {
    const row = db.prepare("SELECT l.*,m.state AS message_state,m.recipient,s.worker,a.epoch AS current_epoch FROM leases l JOIN messages m ON m.id=l.mid JOIN sessions s ON s.id=l.sid JOIN agents a ON a.id=s.worker WHERE l.id=?").get(lease);
    if (!row) return null;
    if (row.sid !== sid) throw new Fault("denied", "Attempt belongs to another session");
    if (authorization) authorizeCore(relay, authorization, "attempt", { sid, lease });
    const state = row.epoch !== row.current_epoch ? "superseded" : row.state === "live" && row.until <= now ? "expired" : row.state === "live" ? "live" : row.state;
    return { mid: row.mid, worker: row.worker, sid: row.sid, epoch: row.epoch, lease: row.id, attempt: row.attempt, until: row.until, state };
  });
}

function reservationRow(row) {
  return { worker: row.worker, localSid: row.local_sid, remoteSid: row.remote_sid, board: row.board, rid: row.rid,
    authority: row.authority, state: row.state, mid: row.mid, lease: row.lease, epoch: row.epoch, until: row.until,
    settleRid: row.settle_rid, settleOutcome: row.settle_outcome };
}
export function reserveCapacity(relay, value) {
  canonicalJson(value, LIMITS.requestBytes);
  const allowed = ["worker", "localSid", "remoteSid", "board", "rid", "authority", "maxJobs"];
  input(value && Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => own(value, key)), "Invalid reservation");
  validateAddress(value.worker); input(typeof value.localSid === "string" && value.localSid.length > 0 && value.localSid.length <= 128 && typeof value.rid === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.rid), "Invalid reservation identity");
  input(value.remoteSid === null || (typeof value.remoteSid === "string" && value.remoteSid.length <= 128), "Invalid remote session");
  input(typeof value.authority === "string" && value.authority.length > 0 && value.authority.length <= 128, "Invalid authority");
  input(typeof value.board === "string" && (value.board === "bounty" || /^host:[A-Za-z0-9._-]{1,128}$/.test(value.board)), "Invalid reservation board");
  validateAddress(value.worker); input(Number.isInteger(value.maxJobs) && value.maxJobs >= 1 && value.maxJobs <= 128, "Invalid maxJobs");
  return tx(relay, "write", ({ db, now }) => {
    const local = value.authority === relay.authority;
    const localSession = getSession(db, value.localSid, now);
    if (localSession.worker !== value.worker) throw new Fault("owner", "Reservation worker does not own the local session");
    if (local && !db.prepare("SELECT 1 FROM boards WHERE id=?").get(value.board)) throw new Fault("board", "Local reservation board does not exist");
    const prior = db.prepare("SELECT * FROM reservations WHERE worker=?").get(value.worker);
    if (prior) {
      if (prior.local_sid !== value.localSid || prior.remote_sid !== value.remoteSid || prior.board !== value.board || prior.rid !== value.rid || prior.authority !== value.authority) throw new Fault("rpc_conflict", "Worker already has a different reservation");
      return reservationRow(prior);
    }
    if (Number(db.prepare("SELECT COUNT(*) AS n FROM reservations").get().n) >= value.maxJobs) throw new Fault("full", "Board assignment capacity is reserved");
    if (local !== (value.remoteSid === null)) throw new Fault("input", "Reservation session does not match board authority");
    db.prepare("INSERT INTO reservations(worker,local_sid,remote_sid,board,rid,authority,state) VALUES(?,?,?,?,?,?,'reserved')").run(value.worker, value.localSid, value.remoteSid, value.board, value.rid, value.authority);
    return reservationRow(db.prepare("SELECT * FROM reservations WHERE worker=?").get(value.worker));
  });
}
export function bindCapacity(relay, value) {
  canonicalJson(value, LIMITS.requestBytes);
  input(value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), "Invalid reservation binding");
  input(JSON.stringify(Reflect.ownKeys(value).sort()) === JSON.stringify(["authority", "lease", "rid", "worker"]), "Invalid reservation binding fields");
  validateAddress(value.worker);
  input(typeof value.rid === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.rid) && typeof value.authority === "string" && value.authority.length > 0 && value.authority.length <= 128, "Invalid reservation binding identity");
  const lease = value.lease;
  input(lease && typeof lease === "object" && !Array.isArray(lease) && typeof lease.id === "string" && lease.id.length > 0 && lease.id.length <= 128 && typeof lease.mid === "string" && lease.mid.length > 0 && lease.mid.length <= 128 && typeof lease.sid === "string" && lease.sid.length > 0 && lease.sid.length <= 128 && Number.isSafeInteger(lease.epoch) && lease.epoch >= 0 && Number.isSafeInteger(lease.until) && lease.until >= 0 && Number.isSafeInteger(lease.attempt) && lease.attempt >= 1 && lease.kind === "work", "Invalid accepted work lease");
  return tx(relay, "write", ({ db }) => {
    const row = db.prepare("SELECT * FROM reservations WHERE worker=? AND rid=? AND authority=?").get(value.worker, value.rid, value.authority);
    if (!row) throw new Fault("missing", "Reservation does not exist");
    if (value.lease.kind !== "work" || value.lease.sid !== (row.remote_sid ?? row.local_sid)) throw new Fault("lease", "Lease does not match the reserved authority");
    if (row.state === "held") {
      if (row.lease !== value.lease.id || row.mid !== value.lease.mid) throw new Fault("rpc_conflict", "Reservation is bound to another attempt");
      return reservationRow(row);
    }
    db.prepare("UPDATE reservations SET state='held',mid=?,lease=?,epoch=?,until=? WHERE worker=?").run(value.lease.mid, value.lease.id, value.lease.epoch, value.lease.until, value.worker);
    return reservationRow(db.prepare("SELECT * FROM reservations WHERE worker=?").get(value.worker));
  });
}
export function listCapacity(relay, options = {}) {
  assertOptions(options, ["worker"], "capacity");
  return tx(relay, "read", ({ db }) => (options.worker ? db.prepare("SELECT * FROM reservations WHERE worker=?").all(options.worker) : db.prepare("SELECT * FROM reservations ORDER BY worker").all()).map(reservationRow));
}
export function beginCapacitySettlement(relay, value) {
  canonicalJson(value, LIMITS.requestBytes);
  input(value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Reflect.ownKeys(value).sort()) === JSON.stringify(["authority", "outcome", "rid", "settleRid", "worker"]), "Invalid settlement request");
  validateAddress(value.worker);
  input(typeof value.rid === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.rid) && typeof value.authority === "string" && value.authority.length > 0 && value.authority.length <= 128 && typeof value.settleRid === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.settleRid) && ["done", "failed", "rejected", "release"].includes(value.outcome), "Invalid settlement request");
  return tx(relay, "write", ({ db }) => {
    const row = db.prepare("SELECT * FROM reservations WHERE worker=? AND rid=? AND authority=?").get(value.worker, value.rid, value.authority);
    if (!row || row.state !== "held") throw new Fault("missing", "Held reservation does not exist");
    if (row.settle_rid && (row.settle_rid !== value.settleRid || row.settle_outcome !== value.outcome)) throw new Fault("rpc_conflict", "Settlement request changed");
    db.prepare("UPDATE reservations SET settle_rid=?,settle_outcome=? WHERE worker=?").run(value.settleRid, value.outcome, value.worker);
    return reservationRow(db.prepare("SELECT * FROM reservations WHERE worker=?").get(value.worker));
  });
}
export function resolveCapacity(relay, value) {
  canonicalJson(value, LIMITS.requestBytes);
  input(value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Reflect.ownKeys(value).sort()) === JSON.stringify(["proof", "rid", "worker"]), "Invalid reservation resolution");
  validateAddress(value.worker);
  input(typeof value.rid === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.rid) && value.proof && typeof value.proof === "object" && !Array.isArray(value.proof), "Invalid reservation resolution");
  return tx(relay, "write", ({ db }) => {
    const row = db.prepare("SELECT * FROM reservations WHERE worker=? AND rid=?").get(value.worker, value.rid);
    if (!row) return null;
    const proof = value.proof;
    if (proof.kind === "claim") {
      if (proof.rid !== row.rid || row.authority !== proof.authority || row.state !== "reserved" || !["empty", "refused"].includes(proof.outcome) || Reflect.ownKeys(proof).sort().join(",") !== "authority,kind,outcome,rid") throw new Fault("lease", "Claim proof does not resolve this reservation");
    } else if (proof.kind === "attempt") {
      if (proof.rid !== row.rid || row.authority !== proof.authority || row.state !== "held" || row.mid !== proof.mid || row.lease !== proof.lease || row.epoch !== proof.epoch || !["done", "failed", "rejected", "released", "expired", "superseded"].includes(proof.state) || Reflect.ownKeys(proof).sort().join(",") !== "authority,epoch,kind,lease,mid,rid,state") throw new Fault("lease", "Attempt proof does not resolve this reservation");
    } else throw new Fault("input", "Invalid reservation proof");
    db.prepare("DELETE FROM reservations WHERE worker=?").run(value.worker);
    return null;
  });
}

function launchRecord(row) { return { id: row.id, device: row.device, primeSid: row.prime_sid, primeEpoch: row.prime_epoch,
  runtime: row.runtime, requestId: row.request_id, recipeHash: row.recipe_hash, capabilities: safeJson(row.capabilities), state: row.state,
  handle: row.handle ? safeJson(row.handle) : null, worker: row.worker, sid: row.sid, epoch: row.epoch, readyAt: row.ready_at,
  exitAt: row.exit_at, exitCode: row.exit_code, signal: row.signal, init: row.init, changed: row.changed }; }
function validateNativeHandle(value) {
  input(value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Reflect.ownKeys(value).sort()) === JSON.stringify(["nonce", "pid", "platform", "processStart"]), "Invalid native process handle");
  input(typeof value.platform === "string" && value.platform.length > 0 && value.platform.length <= 32 && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.processStart === "string" && value.processStart.length > 0 && value.processStart.length <= 256 && typeof value.nonce === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.nonce), "Invalid native process handle");
  return value;
}
export function reserveLaunch(relay, value) {
  canonicalJson(value, LIMITS.requestBytes);
  input(value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Reflect.ownKeys(value).sort()) === JSON.stringify(["capabilities", "demand", "maxChildren", "primeSid", "readySpare", "requestId", "recipeHash", "runtime"].sort()), "Invalid launch reservation");
  input(typeof value.primeSid === "string" && value.primeSid.length > 0 && value.primeSid.length <= 128 && typeof value.requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.requestId) && typeof value.recipeHash === "string" && /^[a-f0-9]{64}$/.test(value.recipeHash), "Invalid launch identity");
  validateRuntime(value.runtime);
  const capabilities = validateTags(value.capabilities);
  return tx(relay, "write", ({ db, now }) => {
    const session = getSession(db, value.primeSid, now);
    const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(session.worker);
    if (agent.slot !== "prime" || agent.device !== relay.device.id) throw new Fault("denied", "Launch requires this device prime session");
    input(Number.isInteger(value.demand) && value.demand >= 0 && value.demand <= 512 && Number.isInteger(value.readySpare) && value.readySpare >= 0 && value.readySpare <= 512 && Number.isInteger(value.maxChildren) && value.maxChildren >= 1 && value.maxChildren <= 16, "Invalid launch capacity");
    const prior = db.prepare("SELECT * FROM launches WHERE request_id=?").get(value.requestId);
    if (prior) {
      if (prior.prime_sid !== value.primeSid || prior.runtime !== value.runtime || prior.recipe_hash !== value.recipeHash || prior.capabilities !== JSON.stringify(capabilities) || prior.demand !== value.demand || prior.ready_spare !== value.readySpare || prior.max_children !== value.maxChildren) throw new Fault("rpc_conflict", "Launch request changed");
      return launchRecord(prior);
    }
    if (value.demand <= value.readySpare || Number(db.prepare("SELECT COUNT(*) AS n FROM launches WHERE device=? AND state IN ('starting','running','unknown')").get(relay.device.id).n) >= value.maxChildren) return null;
    const record = { id: id(), device: relay.device.id, primeSid: value.primeSid, primeEpoch: session.epoch, runtime: value.runtime, requestId: value.requestId,
      recipeHash: value.recipeHash, capabilities, state: "starting", handle: null, worker: null, sid: null, epoch: null, readyAt: null, exitAt: null, exitCode: null, signal: null, init: now, changed: now };
    db.prepare("INSERT INTO launches(id,device,prime_sid,prime_epoch,runtime,request_id,recipe_hash,capabilities,state,demand,ready_spare,max_children,init,changed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(record.id, record.device, record.primeSid, record.primeEpoch, record.runtime, record.requestId, record.recipeHash, JSON.stringify(record.capabilities), record.state, value.demand, value.readySpare, value.maxChildren, now, now);
    return record;
  });
}
export function listLaunches(relay, options = {}) {
  assertOptions(options, ["activeOnly"], "launch list");
  return tx(relay, "read", ({ db }) => (options.activeOnly ? db.prepare("SELECT * FROM launches WHERE state IN ('starting','running','unknown') ORDER BY init").all() : db.prepare("SELECT * FROM launches ORDER BY init").all()).map(launchRecord));
}
export function updateLaunch(relay, value) {
  canonicalJson(value, LIMITS.requestBytes);
  input(value && typeof value === "object" && !Array.isArray(value), "Invalid launch update");
  const shape = `${value.from}:${value.to}`;
  const fields = {
    "starting:running": ["from", "handle", "id", "ready", "to"], "unknown:running": ["from", "handle", "id", "ready", "to"],
    "starting:unknown": ["from", "handle", "id", "to"], "running:unknown": ["from", "handle", "id", "to"],
    "starting:exited": ["exitCode", "from", "handle", "id", "signal", "to"], "running:exited": ["exitCode", "from", "handle", "id", "signal", "to"], "unknown:exited": ["exitCode", "from", "handle", "id", "signal", "to"],
    "starting:failed": ["from", "id", "reason", "to"],
  }[shape];
  input(fields && JSON.stringify(Reflect.ownKeys(value).sort()) === JSON.stringify([...fields].sort()), "Invalid launch update fields");
  input(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128, "Invalid launch ID");
  if (value.to === "running" || value.to === "exited" || value.handle !== undefined) validateNativeHandle(value.handle);
  return tx(relay, "write", ({ db, now }) => {
    const row = db.prepare("SELECT * FROM launches WHERE id=?").get(value.id);
    if (!row || row.state !== value.from) throw new Fault("active", "Launch state changed");
    if (value.to === "running") {
      const h = value.handle; const ready = value.ready;
      input(ready && typeof ready === "object" && !Array.isArray(ready) && JSON.stringify(Reflect.ownKeys(ready).sort()) === JSON.stringify(["caps", "epoch", "nonce", "sid", "worker"]), "Invalid launch readiness");
      const address = validateAddress(ready.worker);
      const readyCaps = validateTags(ready.caps);
      if (typeof ready.sid !== "string" || ready.sid.length === 0 || ready.sid.length > 128 || !Number.isSafeInteger(ready.epoch) || ready.epoch < 1 || ready.nonce !== h.nonce || address.device !== relay.device.name || address.runtime !== row.runtime || address.slot === "prime" || JSON.stringify(readyCaps) !== row.capabilities) throw new Fault("protocol", "Launch readiness does not match its reservation");
      if (row.handle && JSON.stringify(safeJson(row.handle)) !== JSON.stringify(h)) throw new Fault("protocol", "Launch process handle changed");
      const session = db.prepare("SELECT s.*,a.device,a.runtime,a.caps,a.slot,a.epoch AS current_epoch FROM sessions s JOIN agents a ON a.id=s.worker WHERE s.id=? AND s.worker=?").get(ready.sid, ready.worker);
      if (!session || session.epoch !== ready.epoch || session.epoch !== session.current_epoch || session.device !== row.device || session.runtime !== row.runtime || session.slot === "prime" || session.caps !== row.capabilities || now >= session.until) throw new Fault("session", "Launch worker is not ready");
      db.prepare("UPDATE launches SET state='running',handle=?,worker=?,sid=?,epoch=?,ready_at=?,changed=? WHERE id=?").run(JSON.stringify(h), ready.worker, ready.sid, ready.epoch, now, now, row.id);
    } else if (value.to === "unknown") {
      if (value.handle && row.handle && JSON.stringify(value.handle) !== JSON.stringify(safeJson(row.handle))) throw new Fault("protocol", "Launch process handle changed");
      db.prepare("UPDATE launches SET state='unknown',handle=COALESCE(?,handle),changed=? WHERE id=?").run(value.handle ? JSON.stringify(value.handle) : null, now, row.id);
    } else if (value.to === "exited") {
      if ((row.handle && JSON.stringify(value.handle) !== JSON.stringify(safeJson(row.handle))) || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) || (value.signal !== null && (typeof value.signal !== "string" || value.signal.length > 32))) throw new Fault("protocol", "Invalid launch exit observation");
      db.prepare("UPDATE launches SET state='exited',handle=?,exit_at=?,exit_code=?,signal=?,changed=? WHERE id=?").run(JSON.stringify(value.handle), now, value.exitCode, value.signal, now, row.id);
    }
    else if (value.to === "failed" && value.reason === "spawn" && row.state === "starting") db.prepare("UPDATE launches SET state='failed',exit_at=?,changed=? WHERE id=?").run(now, now, row.id);
    else throw new Fault("input", "Invalid launch transition");
    return launchRecord(db.prepare("SELECT * FROM launches WHERE id=?").get(row.id));
  });
}
