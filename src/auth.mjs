import { createHash, timingSafeEqual } from "node:crypto";
import { open as openFile } from "node:fs/promises";
import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { Fault } from "./fault.mjs";
import { parseJsonStrict } from "./config.mjs";

const denied = (message = "Operation denied") => { throw new Fault("denied", message); };
const input = (message = "Operation arguments are invalid") => { throw new Fault("input", message); };
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => obj(v) && Object.keys(v).every((k) => keys.includes(k));
const required = (v, keys) => exact(v, keys) && keys.every((k) => Object.hasOwn(v, k));
const text = (v, max = 256) => typeof v === "string" && Buffer.byteLength(v, "utf8") > 0 && Buffer.byteLength(v, "utf8") <= max && !/[\u0000-\u001f\u007f]/.test(v);
const address = (v) => text(v, 160) && /^[A-Za-z0-9._-]{1,63}:[A-Za-z0-9._-]{1,32}:(?:prime|[0-9]{3,32})$/.test(v);
const board = (v) => v === "bounty" || (typeof v === "string" && /^host:[A-Za-z0-9._-]{1,128}$/.test(v));
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const hash = (v) => createHash("sha256").update(v).digest("hex");
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (obj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
};
const uniq = (values, valid) => Array.isArray(values) && values.length <= 256 && values.every(valid) && new Set(values).size === values.length;
const setList = (v, predicate, label) => {
  if (!uniq(v, predicate)) input(`${label} contains invalid or duplicate entries`);
  return Object.freeze([...v].sort());
};
const tag = (v) => typeof v === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(v);
const opaque = (v) => text(v, 128) && !/[\\/]/.test(v);
const cursorToken = (v, kind = "page", decodedLimit = 1024) => {
  if (typeof v !== "string" || v.length > Math.ceil(decodedLimit * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(v)) return false;
  try {
    const decoded = Buffer.from(v, "base64url");
    if (decoded.length > decodedLimit || decoded.toString("base64url") !== v) return false;
    const json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    const value = parseJsonStrict(json, decodedLimit);
    if (canonical(value) !== json || !obj(value) || value.v !== 1 || !text(value.authority, 128) || !digest(value.scope)) return false;
    if (kind === "snapshot") return required(value, ["v", "authority", "scope", "filter", "boundary", "time", "last"]) && digest(value.filter) && Number.isSafeInteger(value.boundary) && value.boundary >= 0 && Number.isSafeInteger(value.time) && value.time >= 0 && required(value.last, ["agent", "link"]) && (value.last.agent === null || text(value.last.agent, 160)) && (value.last.link === null || text(value.last.link, 256));
    if (kind === "feed") return decodedLimit === 512 && required(value, ["v", "authority", "stream", "seq", "scope"]) && text(value.stream, 128) && Number.isSafeInteger(value.seq) && value.seq >= 0;
    return required(value, ["v", "authority", "scope", "filter", "boundary", "last"]) && digest(value.filter) && Number.isSafeInteger(value.boundary) && value.boundary >= 0 && Number.isSafeInteger(value.last) && value.last >= 0;
  } catch { return false; }
};
const keyValid = (v) => typeof v === "string" && Buffer.byteLength(v, "utf8") > 0 && Buffer.byteLength(v, "utf8") <= 128 && !/[\u0000-\u001f\u007f]/.test(v);
function validJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  let valid;
  if (Array.isArray(value)) valid = Object.keys(value).length === value.length && value.every((item, index) => Object.hasOwn(value, index) && validJson(item, seen));
  else valid = obj(value) && Object.keys(value).every((key) => validJson(value[key], seen));
  seen.delete(value); return valid;
}
function validateEnvelope(value, boardPost = false) {
  if (!obj(value) || Object.keys(value).length !== 1) input("Envelope must contain exactly one kind");
  const keys = Object.keys(value);
  if (keys[0] === "msg") {
    if (typeof value.msg !== "string" || !value.msg.length || Buffer.byteLength(JSON.stringify(value)) > 65536) input("Message envelope is invalid");
  } else if (keys[0] === "work") {
    if (!validJson(value.work) || Buffer.byteLength(JSON.stringify(value)) > 65536) input("Work envelope is invalid");
  } else input("Envelope kind is invalid");
  return keys[0];
}
function validateReport(value) {
  if (!required(value, ["seq", "agents", "board"]) && !(obj(value) && Object.keys(value).sort().join(",") === "agents,board,events,seq")) input("Report shape is invalid");
  if (!Number.isSafeInteger(value.seq) || value.seq < 0 || !Array.isArray(value.agents) || value.agents.length > 512) input("Report shape is invalid");
  for (const agent of value.agents) {
    if (!required(agent, ["worker", "state", "free", "assignmentCount"]) || !address(agent.worker) || !["starting", "ready", "busy", "unknown"].includes(agent.state) || ![0, 1, null].includes(agent.free) || ![0, 1].includes(agent.assignmentCount)) input("Report agent is invalid");
  }
  const boardValue = value.board;
  if (!required(boardValue, ["id", "inbox", "pending", "claimed", "terminal"]) || !board(boardValue.id) || [boardValue.inbox, boardValue.pending, boardValue.claimed, boardValue.terminal].some((n) => !Number.isSafeInteger(n) || n < 0)) input("Report board is invalid");
  if (value.events !== undefined) {
    if (!Array.isArray(value.events) || value.events.length > 2048) input("Report events are invalid");
    for (const event of value.events) {
      if (!required(event, ["seq", "type", "from", "to", "mid", "state", "code"]) || !Number.isSafeInteger(event.seq) || event.seq < 0 || !["post", "claim", "release", "ack", "refusal"].includes(event.type) || !text(event.from, 160) || !text(event.to, 160) || event.mid !== null && !opaque(event.mid) || event.state !== null && !["pending", "claimed", "posted", "done", "failed", "rejected"].includes(event.state) || event.code !== null && !text(event.code, 32)) input("Report event is invalid");
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 32768) input("Report is too large");
}

function normalizeGrant(g) {
  const fields = ["enroll", "register", "workers", "recipients", "boardPost", "boardClaim", "inboxRead", "workRead", "inspect", "reportDevice"];
  if (!required(g, fields)) input("Credential grant shape is invalid");
  if (!Array.isArray(g.enroll) || g.enroll.length > 256) input("enroll grant is invalid");
  const enroll = g.enroll.map((v) => {
    if (!required(v, ["deviceId", "deviceName"]) || !opaque(v.deviceId) || !/^[A-Za-z0-9._-]{1,63}$/.test(v.deviceName)) input("enroll grant is invalid");
    return Object.freeze({ deviceId: v.deviceId, deviceName: v.deviceName });
  });
  if (new Set(enroll.map((x) => x.deviceId)).size !== enroll.length || new Set(enroll.map((x) => x.deviceName.toLowerCase())).size !== enroll.length) input("enroll grant has duplicate entries");
  enroll.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  if (!Array.isArray(g.register) || g.register.length > 1) input("register grant must contain at most one namespace");
  const register = g.register.map((v) => {
    if (!required(v, ["deviceId", "deviceName", "runtimes", "allocate"]) || !opaque(v.deviceId) || !/^[A-Za-z0-9._-]{1,63}$/.test(v.deviceName) || typeof v.allocate !== "boolean") input("register grant is invalid");
    const runtimes = setList(v.runtimes, (x) => tag(x) && x !== "prime", "runtimes");
    return Object.freeze({ deviceId: v.deviceId, deviceName: v.deviceName, runtimes, allocate: v.allocate });
  });
  const workerPredicate = address;
  const boardPredicate = board;
  if (!required(g.inspect, ["messages", "receipts", "audit", "topology"]) || Object.values(g.inspect).some((v) => typeof v !== "boolean")) input("inspect grant is invalid");
  if (g.reportDevice !== null && !opaque(g.reportDevice)) input("reportDevice is invalid");
  return Object.freeze({
    enroll: Object.freeze(enroll), register: Object.freeze(register),
    workers: setList(g.workers, workerPredicate, "workers"),
    recipients: setList(g.recipients, workerPredicate, "recipients"),
    boardPost: setList(g.boardPost, boardPredicate, "boardPost"),
    boardClaim: setList(g.boardClaim, boardPredicate, "boardClaim"),
    inboxRead: setList(g.inboxRead, boardPredicate, "inboxRead"),
    workRead: setList(g.workRead, boardPredicate, "workRead"),
    inspect: Object.freeze({ messages: g.inspect.messages, receipts: g.inspect.receipts, audit: g.inspect.audit, topology: g.inspect.topology }),
    reportDevice: g.reportDevice,
  });
}

function decodeRegistry(stat, data) {
  let bytes;
  try {
    if (!stat.isFile() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("unsafe file");
    bytes = typeof data === "string" ? data : new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch { throw new Fault("unavailable", "Credential registry is unavailable or unsafe"); }
  const doc = parseJsonStrict(bytes, 1_048_576);
  if (!required(doc, ["version", "credentials"]) || doc.version !== 1 || !Array.isArray(doc.credentials) || doc.credentials.length > 256) input("Credential registry shape is invalid");
  const principals = new Set(); const digests = new Set();
  const credentials = doc.credentials.map((entry) => {
    if (!required(entry, ["principal", "tokenDigest", "grant"]) || !/^[A-Za-z0-9._-]{1,64}$/.test(entry.principal) || !digest(entry.tokenDigest)) input("Credential entry is invalid");
    if (principals.has(entry.principal) || digests.has(entry.tokenDigest)) input("Credential registry contains duplicates");
    principals.add(entry.principal); digests.add(entry.tokenDigest);
    const grant = normalizeGrant(entry.grant);
    const scopeKey = hash(canonical(grant));
    return Object.freeze({ principal: entry.principal, tokenDigest: entry.tokenDigest, grant, scopeKey });
  });
  const digestIndex = new Map(credentials.map((entry) => [entry.tokenDigest, entry.principal]));
  return Object.freeze({ version: 1, credentials: Object.freeze(credentials), digestIndex });
}

export async function loadRegistry(filePath) {
  let file;
  try { file = await openFile(filePath, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch { throw new Fault("unavailable", "Credential registry is unavailable or unsafe"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1_048_576 || process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw new Fault("unavailable", "Credential registry is unavailable or unsafe");
    return decodeRegistry(stat, await file.readFile());
  } finally { await file.close(); }
}

export function loadRegistrySync(filePath) {
  let fd;
  try {
    fd = openSync(filePath, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1_048_576 || process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw new Fault("unavailable", "Credential registry is unavailable or unsafe");
    return decodeRegistry(stat, readFileSync(fd));
  }
  catch (error) { if (error instanceof Fault) throw error; throw new Fault("unavailable", "Credential registry is unavailable or unsafe"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function authenticate(snapshot, authorizationHeader) {
  if (!snapshot || snapshot.version !== 1) throw new Fault("auth", "Authentication required");
  if (Array.isArray(authorizationHeader)) {
    if (authorizationHeader.length !== 1) throw new Fault("auth", "Authentication required");
    [authorizationHeader] = authorizationHeader;
  }
  if (typeof authorizationHeader !== "string" || authorizationHeader.length > 64 || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorizationHeader)) throw new Fault("auth", "Authentication required");
  const tokenDigest = createHash("sha256").update(authorizationHeader.slice(7), "ascii").digest();
  let match = null;
  for (const entry of snapshot.credentials) {
    const candidate = Buffer.from(entry.tokenDigest, "hex");
    if (timingSafeEqual(tokenDigest, candidate)) match = entry;
  }
  if (!match) throw new Fault("auth", "Authentication required");
  return Object.freeze({ id: match.principal, grant: match.grant, scopeKey: match.scopeKey });
}

const opKeys = Object.freeze({
  register: ["runtime", "options"], enroll: ["device"], join: ["worker", "options"], resume: ["sid"], renew: ["sid"], leave: ["sid"],
  send: ["sid", "to", "envelope", "options"], post: ["sid", "board", "envelope", "options"], claim: ["sid", "options"], touch: ["sid", "lease"],
  ack: ["sid", "lease", "outcome"], release: ["sid", "lease"], get: ["id", "options"], list: ["options"], stats: [], audit: ["options"],
  pending: ["sid"], report: ["sid", "report"], snapshot: ["options"], attempt: ["sid", "lease"],
});
const opts = (v, keys) => v === undefined || (obj(v) && exact(v, keys));
function checkArguments(operation, args) {
  const keys = opKeys[operation];
  if (!keys || !obj(args) || Object.keys(args).some((k) => !keys.includes(k)) || keys.filter((k) => !["options"].includes(k)).some((k) => !Object.hasOwn(args, k))) input("Operation arguments are invalid");
  if (["resume", "renew", "leave", "touch", "ack", "release", "attempt", "claim", "send", "post", "report", "pending"].includes(operation) && !text(args.sid, 128)) input();
  if (operation === "register" && (!tag(args.runtime) || args.runtime === "prime" || !opts(args.options, ["slot", "caps"]) || args.options?.slot !== undefined && (typeof args.options.slot !== "string" || !/^\d{3,32}$/.test(args.options.slot)) || args.options?.caps !== undefined && !uniq(args.options.caps, tag))) input();
  if (operation === "enroll" && (!required(args.device, ["id", "name", "init"]) || !opaque(args.device.id) || !/^[A-Za-z0-9._-]{1,63}$/.test(args.device.name) || !Number.isSafeInteger(args.device.init))) input();
  if (operation === "join" && (!address(args.worker) || !opts(args.options, ["replace"]) || args.options?.replace !== undefined && typeof args.options.replace !== "boolean")) input();
  if (["resume", "renew", "leave"].includes(operation) && !text(args.sid, 128)) input();
  if (operation === "send") {
    if (!address(args.to) || !opts(args.options, ["key"]) || args.options?.key !== undefined && !keyValid(args.options.key)) input();
    validateEnvelope(args.envelope);
  }
  if (operation === "post" && (!board(args.board) || !opts(args.options, ["key", "needs", "series"]) || args.options?.key !== undefined && !keyValid(args.options.key) || args.options?.needs !== undefined && !uniq(args.options.needs, tag) || args.options?.series !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(args.options.series))) input();
  if (operation === "post") {
    const kind = validateEnvelope(args.envelope, true);
    if (kind === "msg" && (args.options?.needs !== undefined || args.options?.series !== undefined)) input("Inbox messages cannot use work options");
  }
  if (operation === "claim" && (!opts(args.options, ["board", "kind"]) || args.options?.board !== undefined && !board(args.options.board) || args.options?.kind !== undefined && !["msg", "work"].includes(args.options.kind))) input();
  if (["touch", "release", "attempt"].includes(operation) && !text(args.lease, 128)) input();
  if (operation === "ack" && (!text(args.lease, 128) || !["done", "failed", "rejected"].includes(args.outcome))) input();
  if (operation === "get" && (!text(args.id, 128) || !opts(args.options, ["data"]) || args.options?.data !== undefined && typeof args.options.data !== "boolean")) input();
  if (operation === "list") {
    const o = args.options ?? {};
    if (!opts(o, ["to", "board", "kind", "state", "after", "limit", "data"]) || o.to !== undefined && !address(o.to) || o.board !== undefined && !board(o.board) || o.to !== undefined && o.board !== undefined || o.kind !== undefined && !["msg", "work"].includes(o.kind) || o.state !== undefined && !["pending", "claimed", "posted", "done", "failed", "rejected"].includes(o.state) || o.after !== undefined && !cursorToken(o.after, "page") || o.limit !== undefined && (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 200) || o.data !== undefined && typeof o.data !== "boolean") input();
  }
  if (operation === "audit" && (!opts(args.options, ["after", "limit"]) || args.options?.after !== undefined && !cursorToken(args.options.after, "page") || args.options?.limit !== undefined && (!Number.isInteger(args.options.limit) || args.options.limit < 1 || args.options.limit > 200))) input();
  if (operation === "snapshot" && (!opts(args.options, ["device", "limit", "after"]) || args.options?.device !== undefined && !opaque(args.options.device) || args.options?.limit !== undefined && (!Number.isInteger(args.options.limit) || args.options.limit < 1 || args.options.limit > 512) || args.options?.after !== undefined && !cursorToken(args.options.after, "snapshot"))) input();
  if (operation === "report") { if (!text(args.sid, 128)) input(); validateReport(args.report); }
  if (operation === "stats" && Object.keys(args).length !== 0) input();
}

function allowed(list, value) { return list.includes(value); }
export function authorize(snapshot, principal, operation, args) {
  checkArguments(operation, args);
  const current = snapshot?.credentials?.find((item) => item.principal === principal?.id);
  if (!current || current.scopeKey !== principal.scopeKey) throw new Fault("auth", "Authentication required");
  const g = current.grant;
  if (operation === "register") {
    const reg = g.register[0];
    if (!reg || !reg.runtimes.includes(args.runtime) || args.options?.slot === undefined && !reg.allocate) denied();
  } else if (operation === "enroll") {
    if (!g.enroll.some((d) => d.deviceId === args.device.id && d.deviceName === args.device.name)) denied();
  } else if (operation === "join") {
    if (!allowed(g.workers, args.worker)) denied();
  } else if (operation === "send") {
    if (!allowed(g.recipients, args.to)) denied();
  } else if (operation === "post") {
    if (!allowed(g.boardPost, args.board)) denied();
  } else if (operation === "claim" && args.options?.board !== undefined) {
    if (!allowed(g.boardClaim, args.options.board) || args.options.kind === "msg") denied();
  } else if (operation === "audit" && !g.inspect.audit) denied();
  else if (operation === "snapshot" && !g.inspect.topology) denied();
  else if (operation === "stats" && !g.inspect.messages) denied();
  else if (operation === "report") {
    if (!g.reportDevice) denied();
  } else if (["get", "list"].includes(operation)) {
    const o = operation === "get" ? args.options ?? {} : args.options ?? {};
    if (o.board !== undefined) {
      const kind = o.kind ?? "work";
      authorizeBoardRead(snapshot, principal, o.board, kind, o.data === true);
    } else if (operation === "list" && o.to !== undefined && !g.inspect.messages && !allowed(g.workers, o.to) && !allowed(g.recipients, o.to)) denied();
    else if (operation === "get" && o.data === true && !g.inspect.messages) denied();
  }
  return Object.freeze({ principal: Object.freeze({ id: current.principal, grant: current.grant, scopeKey: current.scopeKey }), operation, scopeKey: current.scopeKey });
}

export function authorizeBoardRead(snapshot, principal, boardId, kind, includeData) {
  const current = snapshot?.credentials?.find((item) => item.principal === principal?.id && item.scopeKey === principal?.scopeKey);
  if (!current || !board(boardId) || !["msg", "work"].includes(kind)) denied();
  const g = current.grant;
  const base = kind === "msg" ? g.inboxRead : g.workRead;
  if (!base.includes(boardId)) denied();
  return Object.freeze({ principal: Object.freeze({ id: current.principal, grant: current.grant, scopeKey: current.scopeKey }), operation: "list", scopeKey: current.scopeKey });
}
