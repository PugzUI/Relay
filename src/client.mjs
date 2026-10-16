import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { open as openFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isIP } from "node:net";
import { Fault } from "./fault.mjs";
import { parseJsonStrict } from "./config.mjs";
import { LIMITS, canonicalJson as encodeJson, validateEnvelope } from "./validate.mjs";

const clients = new WeakMap();
const ambiguousResponses = new WeakSet();
const clientToken = Symbol("Client construction");
const ops = new Set(["register", "enroll", "join", "resume", "renew", "leave", "send", "post", "claim", "touch", "ack", "release", "get", "list", "pending", "stats", "audit", "report", "snapshot", "attempt"]);
const mutating = new Set(["register", "enroll", "join", "resume", "renew", "leave", "send", "post", "claim", "touch", "ack", "release", "report"]);
const fail = (code, message, context) => { throw new Fault(code, message, context); };
const ambiguousFault = (message) => { const error = new Fault("protocol", message); ambiguousResponses.add(error); return error; };
const rid = () => randomBytes(18).toString("base64url");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
async function readBounded(file, maxBytes, label) {
  const buffer = Buffer.alloc(maxBytes + 1);
  let length = 0;
  try {
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
  } catch (error) {
    buffer.fill(0);
    throw error;
  }
  if (length > maxBytes) {
    buffer.fill(0);
    fail("input", `${label} is too large`);
  }
  return buffer.subarray(0, length);
}
async function readPrivate(path, label, maxBytes) {
  let file;
  try { file = await openFile(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)); }
  catch { fail("unavailable", `${label} is unavailable or unsafe`); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail("input", `${label} must be an owned private regular file`);
    if (stat.size > maxBytes) fail("input", `${label} is too large`);
    return await readBounded(file, maxBytes, label);
  } finally { await file.close(); }
}
export async function readToken(path) {
  const value = await readPrivate(path, "Token file", 45);
  try {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(value); }
    catch { fail("input", "Token file has invalid contents"); }
    const token = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail("input", "Token file has invalid contents");
    return token;
  } finally { value.fill(0); }
}
function endpoint(value, mode) {
  let url;
  try { url = new URL(value); } catch { fail("input", "Broker URL is invalid"); }
  if (value.includes("@") || value.includes("?") || value.includes("#") || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.hostname.includes("%")) fail("input", "Broker URL must be an origin without credentials or selectors");
  if (url.protocol === "http:") {
    const literal = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || isIP(url.hostname) === 6 && url.hostname === "::1";
    if (mode !== "local" || !literal) fail("tls", "HTTP requires explicit local loopback mode");
  } else if (url.protocol !== "https:") fail("tls", "Broker URL scheme is unsupported");
  if (mode !== undefined && !["local", "lan", "tailscale"].includes(mode)) fail("input", "Broker mode is invalid");
  return url;
}
function parseFault(body) {
  const f = body?.fault;
  const codes = new Set(["input", "data", "missing", "schema", "active", "session", "expired", "target", "device_conflict", "board", "key_conflict", "ack_conflict", "owner", "lease", "full", "busy", "clock", "storage", "auth", "denied", "protocol", "tls", "rpc_conflict", "uncertain", "cursor", "reset", "rate", "timeout", "unavailable"]);
  if (!object(f) || !codes.has(f.code) || typeof f.message !== "string" || f.message.length > 256) fail("protocol", "Broker refusal is malformed");
  const context = object(f.context) ? Object.fromEntries(Object.entries(f.context).filter(([k, v]) => ["id", "mid", "sid", "lease", "retryAfterMs"].includes(k) && (typeof v === "string" || Number.isSafeInteger(v)))) : undefined;
  return new Fault(f.code, f.message, context);
}
const ownShape = (value, required, optional = []) => object(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const id = (value) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const address = (value) => typeof value === "string" && /^[A-Za-z0-9._-]{1,63}:[A-Za-z0-9._-]{1,32}:(?:prime|[0-9]{3,32})$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const stringList = (value) => Array.isArray(value) && value.length <= 512 && value.every((item) => typeof item === "string");
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const cursorToken = (value, kind = "page", decodedLimit = 1024) => {
  if (typeof value !== "string" || value.length > Math.ceil(decodedLimit * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length > decodedLimit || decoded.toString("base64url") !== value) return false;
    const json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    const token = parseJsonStrict(json, decodedLimit);
    if (!object(token) || canonicalJson(token) !== json || token.v !== 1 || !id(token.authority) || typeof token.scope !== "string" || !/^[a-f0-9]{64}$/.test(token.scope)) return false;
    if (kind === "feed") return Object.keys(token).sort().join(",") === "authority,scope,seq,stream,v" && id(token.stream) && integer(token.seq);
    if (kind === "snapshot") return Object.keys(token).sort().join(",") === "authority,boundary,filter,last,scope,time,v" && /^[a-f0-9]{64}$/.test(token.filter) && integer(token.boundary) && integer(token.time) && ownShape(token.last, ["agent", "link"]) && (token.last.agent === null || id(token.last.agent)) && (token.last.link === null || id(token.last.link));
    return Object.keys(token).sort().join(",") === "authority,boundary,filter,last,scope,v" && /^[a-f0-9]{64}$/.test(token.filter) && integer(token.boundary) && integer(token.last);
  } catch { return false; }
};
function validDevice(value) { return ownShape(value, ["id", "name", "init"]) && id(value.id) && typeof value.name === "string" && integer(value.init); }
function validAgent(value) { return ownShape(value, ["id", "device", "runtime", "slot", "caps", "epoch", "init"]) && address(value.id) && id(value.device) && id(value.runtime) && id(value.slot) && stringList(value.caps) && integer(value.epoch) && integer(value.init); }
function validSession(value) { return ownShape(value, ["id", "worker", "epoch", "until", "ended"]) && id(value.id) && address(value.worker) && integer(value.epoch) && integer(value.until) && (value.ended === null || integer(value.ended)); }
function validLease(value) {
  if (!ownShape(value, ["id", "mid", "sid", "epoch", "until", "attempt", "kind"], ["msg", "work"]) || !id(value.id) || !id(value.mid) || !id(value.sid) || !integer(value.epoch) || !integer(value.until) || !integer(value.attempt) || !["msg", "work"].includes(value.kind)) return false;
  return value.kind === "msg" ? typeof value.msg === "string" && !Object.hasOwn(value, "work") : Object.hasOwn(value, "work") && !Object.hasOwn(value, "msg");
}
function validAdmission(value) { return ownShape(value, ["id", "repeat", "init"]) && id(value.id) && typeof value.repeat === "boolean" && integer(value.init); }
function validReceipt(value) { return ownShape(value, ["mid", "lease", "sid", "epoch", "outcome", "time"]) && id(value.mid) && id(value.lease) && id(value.sid) && integer(value.epoch) && ["done", "failed", "rejected"].includes(value.outcome) && integer(value.time); }
function validRelease(value) { return ownShape(value, ["mid", "lease", "sid", "epoch", "outcome", "time"]) && id(value.mid) && id(value.lease) && id(value.sid) && integer(value.epoch) && value.outcome === "released" && integer(value.time); }
function validStats(value) {
  return ownShape(value, ["authority", "time", "messages", "sessions", "leases", "receipts", "devices", "agents", "boards", "audit"]) &&
    id(value.authority) && integer(value.time) &&
    ownShape(value.messages, ["pending", "claimed", "posted", "done", "failed", "rejected", "rows", "bytes"]) && Object.values(value.messages).every(integer) &&
    ownShape(value.sessions, ["live", "ended"]) && Object.values(value.sessions).every(integer) &&
    ownShape(value.leases, ["live", "total"]) && Object.values(value.leases).every(integer) &&
    integer(value.receipts) && integer(value.devices) && integer(value.agents) && integer(value.boards) &&
    ownShape(value.audit, ["rows", "pruned"]) && Object.values(value.audit).every(integer);
}
function validMessage(value) {
  const required = ["id", "seq", "from", "to", "board", "kind", "needs", "series", "state", "init", "acked"];
  if (!ownShape(value, required, ["data"]) || !id(value.id) || !integer(value.seq) || value.from !== null && !address(value.from) || value.to !== null && !address(value.to) || value.board !== null && typeof value.board !== "string" || !["msg", "work"].includes(value.kind) || !stringList(value.needs) || value.series !== null && typeof value.series !== "string" || !["pending", "claimed", "posted", "done", "failed", "rejected"].includes(value.state) || !integer(value.init) || value.acked !== null && !integer(value.acked)) return false;
  return value.data === undefined || object(value.data) && Object.keys(value.data).length === 1 && (value.kind === "msg" ? typeof value.data.msg === "string" && !Object.hasOwn(value.data, "work") : Object.hasOwn(value.data, "work") && !Object.hasOwn(value.data, "msg"));
}
function validPage(value, validator) { return ownShape(value, ["items", "total", "visible", "complete", "cursor", "next", "firstSeq", "pruned"]) && Array.isArray(value.items) && value.items.length <= 200 && value.items.every(validator) && integer(value.total) && integer(value.visible) && value.visible === value.items.length && typeof value.complete === "boolean" && typeof value.cursor === "string" && (value.next === null || cursorToken(value.next, "page")) && value.complete === (value.next === null) && (value.firstSeq === null || integer(value.firstSeq)) && integer(value.pruned); }
function validSnapshot(value) {
  const countSet = (v, keys) => ownShape(v, keys) && keys.every((key) => integer(v[key]));
  const device = (v) => ownShape(v, ["id", "name", "init", "authority", "receivedAt", "stale", "free"]) && id(v.id) && typeof v.name === "string" && integer(v.init) && id(v.authority) && (v.receivedAt === null || integer(v.receivedAt)) && typeof v.stale === "boolean" && [null, 0, 1].includes(v.free);
  const agent = (v) => ownShape(v, ["id", "device", "runtime", "slot", "caps", "epoch", "init", "state", "assignmentCount", "receivedAt"]) && address(v.id) && id(v.device) && id(v.runtime) && id(v.slot) && stringList(v.caps) && integer(v.epoch) && integer(v.init) && ["registered", "starting", "ready", "busy", "unknown", "stale"].includes(v.state) && [0, 1].includes(v.assignmentCount) && (v.receivedAt === null || integer(v.receivedAt));
  const board = (v) => ownShape(v, ["id", "kind", "device", "authority", "inbox", "pending", "claimed", "terminal", "reported", "receivedAt"]) && id(v.id) && ["bounty", "host"].includes(v.kind) && (v.device === null || id(v.device)) && id(v.authority) && [v.inbox, v.pending, v.claimed, v.terminal].every(integer) && typeof v.reported === "boolean" && (v.receivedAt === null || integer(v.receivedAt));
  const link = (v) => ownShape(v, ["id", "from", "to", "kind", "state", "mid", "time"]) && id(v.id) && id(v.from) && id(v.to) && ["addressed", "board", "report"].includes(v.kind) && ["active", "stale", "unknown"].includes(v.state) && (v.mid === null || id(v.mid)) && (v.time === null || integer(v.time));
  if (!ownShape(value, ["v", "authority", "time", "cursor", "devices", "agents", "boards", "links", "totals", "visible", "complete", "next"]) || value.v !== 1 || !id(value.authority) || !integer(value.time) || !cursorToken(value.cursor, "feed", 512) || typeof value.complete !== "boolean" || (value.next !== null && !cursorToken(value.next, "snapshot")) || value.complete !== (value.next === null)) return false;
  if (!Array.isArray(value.devices) || value.devices.length > 64 || !value.devices.every(device) || !Array.isArray(value.agents) || value.agents.length > 512 || !value.agents.every(agent) || !Array.isArray(value.boards) || value.boards.length > 64 || !value.boards.every(board) || !Array.isArray(value.links) || value.links.length > 512 || !value.links.every(link)) return false;
  const keys = ["devices", "agents", "boards", "links"];
  return countSet(value.totals, keys) && countSet(value.visible, keys) && keys.every((key) => value.visible[key] === value[key].length && value.totals[key] >= value.visible[key]);
}
function validResult(op, value) {
  if (op === "register") return validAgent(value);
  if (op === "enroll") return ownShape(value, ["id", "name", "init", "repeat"]) && validDevice({ id: value.id, name: value.name, init: value.init }) && typeof value.repeat === "boolean";
  if (op === "join" || op === "resume" || op === "renew") return validSession(value);
  if (op === "leave") return ownShape(value, ["sid", "epoch", "ended"]) && id(value.sid) && integer(value.epoch) && integer(value.ended);
  if (op === "send" || op === "post") return validAdmission(value);
  if (op === "claim") return value === null || validLease(value);
  if (op === "touch") return validLease(value);
  if (op === "ack") return validReceipt(value);
  if (op === "release") return validRelease(value);
  if (op === "get") return value === null || validMessage(value);
  if (op === "list") return validPage(value, validMessage);
  if (op === "pending") return ownShape(value, ["v", "authority", "worker", "epoch", "revision", "pending", "recoverable"]) && value.v === 1 && id(value.authority) && address(value.worker) && integer(value.epoch) && typeof value.revision === "string" && /^[0-9a-f]{64}$/.test(value.revision) && [value.pending, value.recoverable].every((counts) => ownShape(counts, ["msg", "work"]) && integer(counts.msg) && integer(counts.work));
  if (op === "audit") return validPage(value, (v) => ownShape(v, ["seq", "time", "type", "worker", "sid", "mid", "lease", "code"]) && integer(v.seq) && integer(v.time) && typeof v.type === "string" && (v.worker === null || id(v.worker)) && (v.sid === null || id(v.sid)) && (v.mid === null || id(v.mid)) && (v.lease === null || id(v.lease)) && (v.code === null || typeof v.code === "string"));
  if (op === "stats") return validStats(value);
  if (op === "report") return ownShape(value, ["accepted", "receivedAt", "staleAfter", "seq"]) && value.accepted === true && integer(value.receivedAt) && integer(value.staleAfter) && integer(value.seq);
  if (op === "snapshot") return validSnapshot(value);
  if (op === "attempt") return value === null || ownShape(value, ["mid", "worker", "sid", "epoch", "lease", "attempt", "until", "state"]) && id(value.mid) && address(value.worker) && id(value.sid) && integer(value.epoch) && id(value.lease) && integer(value.attempt) && integer(value.until) && ["live", "done", "failed", "rejected", "released", "expired", "superseded", "unknown"].includes(value.state);
  return false;
}

function request(state, method, path, body, deadline, auth = true, signal = state.signal) {
  if (state.closed) return Promise.reject(new Fault("unavailable", "Client is closed"));
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(new Fault("timeout", "Request deadline elapsed"));
  if (signal?.aborted) return Promise.reject(new Fault("unavailable", "Request was cancelled"));
  const transport = state.url.protocol === "https:" ? https : http;
  const options = { protocol: state.url.protocol, hostname: state.url.hostname, port: state.url.port || undefined, method, path, maxHeaderSize: 8192, headers: { Accept: "application/json", ...(auth ? { Authorization: `Bearer ${state.token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }) }, agent: false };
  if (state.ca) options.ca = state.ca;
  return new Promise((resolve, reject) => {
    let settled = false; let responseBytes = 0; let abort; const chunks = [];
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); state.requests.delete(req);
      if (abort) signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const req = transport.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); req.destroy(); finish(ambiguousFault("Broker redirects are not followed")); return; }
      if (res.headers["content-encoding"] !== undefined || typeof res.headers["content-type"] !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(res.headers["content-type"])) {
        res.destroy(); finish(res.statusCode >= 200 && res.statusCode < 300 ? ambiguousFault("Broker response headers are invalid") : new Fault("protocol", "Broker response headers are invalid")); return;
      }
      res.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > 1_048_576) { req.destroy(); finish(ambiguousFault("Broker response is too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        let parsed; try { parsed = parseJsonStrict(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), 1_048_576); } catch { finish(res.statusCode >= 200 && res.statusCode < 300 ? ambiguousFault("Broker response is malformed") : new Fault("protocol", "Broker response is malformed")); return; }
        finish(null, { status: res.statusCode, headers: res.headers, value: parsed });
      });
      res.on("error", (error) => finish(error));
    });
    state.requests.add(req);
    const timer = setTimeout(() => { req.destroy(new Error("deadline")); finish(new Fault("timeout", "Request deadline elapsed")); }, Math.max(1, Math.min(remaining, 3000)));
    if (signal?.aborted) { req.destroy(); finish(new Fault("unavailable", "Request was cancelled")); return; }
    abort = () => { req.destroy(); finish(new Fault("unavailable", "Request was cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
    req.on("error", (error) => finish(error));
    if (body !== undefined) req.end(body); else req.end();
  });
}

export class Client {
  constructor(token) { if (token !== clientToken) throw new TypeError("Use connect()"); }
  get authority() { return clients.get(this)?.authority ?? ""; }
  register(runtime, options) { return this.#call("register", { runtime, ...(options === undefined ? {} : { options }) }); }
  enroll(device) { return this.#call("enroll", { device }); }
  join(worker, options) { return this.#call("join", { worker, ...(options === undefined ? {} : { options }) }); }
  resume(sid) { return this.#call("resume", { sid }); }
  renew(sid) { return this.#call("renew", { sid }); }
  leave(sid) { return this.#call("leave", { sid }); }
  send(sid, to, envelope, options) { return this.#call("send", { sid, to, envelope, ...(options === undefined ? {} : { options }) }); }
  post(sid, board, envelope, options) { return this.#call("post", { sid, board, envelope, ...(options === undefined ? {} : { options }) }); }
  claim(sid, options) { return this.#call("claim", { sid, ...(options === undefined ? {} : { options }) }); }
  touch(sid, lease) { return this.#call("touch", { sid, lease }); }
  ack(sid, lease, outcome) { return this.#call("ack", { sid, lease, outcome }); }
  release(sid, lease) { return this.#call("release", { sid, lease }); }
  get(id, options) { return this.#call("get", { id, ...(options === undefined ? {} : { options }) }); }
  list(options) { return this.#call("list", { ...(options === undefined ? {} : { options }) }); }
  pending(sid) { return this.#call("pending", { sid }); }
  stats() { return this.#call("stats", {}); }
  audit(options) { return this.#call("audit", { ...(options === undefined ? {} : { options }) }); }
  report(sid, report) { return this.#call("report", { sid, report }); }
  snapshot(options) { return this.#call("snapshot", { ...(options === undefined ? {} : { options }) }); }
  async #call(op, args) { const state = clients.get(this); if (!state) fail("unavailable", "Client is closed"); const outcome = await invokeClient(this, { rid: rid(), op, args, deadline: performance.now() + 10000 }); return outcome.result; }
  async close() {
    const state = clients.get(this); if (!state || state.closed) return;
    state.closed = true; state.token = null; state.ca = null;
    for (const req of state.requests) req.destroy(new Error("client closed")); state.requests.clear();
  }
}

export async function connect(options) {
  return openClient(options, { checkHealth: true });
}

export async function createFixedClient(options, signal, { checkHealth = false, deadline } = {}) {
  return openClient(options, { checkHealth, signal, deadline });
}

async function openClient(options, { checkHealth, signal, deadline: operationDeadline } = {}) {
  if (!object(options) || Object.keys(options).some((k) => !["url", "tokenFile", "caFile", "mode"].includes(k)) || typeof options.url !== "string" || typeof options.tokenFile !== "string" || options.caFile !== undefined && typeof options.caFile !== "string") fail("input", "Client options are invalid");
  const url = endpoint(options.url, options.mode);
  const token = await readToken(options.tokenFile);
  let ca;
  if (options.caFile !== undefined) {
    ca = await readPrivate(options.caFile, "CA file", 1_048_576);
    if (!ca.length) fail("input", "CA file is invalid");
  }
  const client = new Client(clientToken);
  const state = { url, token, ca, requests: new Set(), closed: false, authority: null, signal };
  clients.set(client, state);
  try {
    if (checkHealth) {
      const deadline = operationDeadline ?? performance.now() + 10000;
      const health = await request(state, "GET", "/v1/health", undefined, deadline);
      if (health.status < 200 || health.status >= 300) throw parseFault(health.value);
      if (health.value?.v !== 1 || !id(health.value.authority) || !integer(health.value.time) || Object.keys(health.value).sort().join(",") !== "authority,time,v") fail("protocol", "Broker health response is invalid");
      state.authority = health.value.authority;
    }
    return client;
  } catch (error) {
    await client.close();
    if (!(error instanceof Fault) && ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"].includes(error?.code)) {
      throw new Fault("unavailable", "Broker connection is unavailable", { cause: error });
    }
    throw error;
  }
}

export async function invokeClient(client, input) {
  const state = clients.get(client);
  if (!state || state.closed) fail("unavailable", "Client is closed");
  const fields = object(input) ? Object.keys(input).sort().join(",") : "";
  if (!object(input) || !["args,deadline,op,rid", "args,deadline,op,rid,signal"].includes(fields) || input.signal !== undefined && !(input.signal instanceof AbortSignal) || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.rid) || !ops.has(input.op) || !object(input.args) || !Number.isFinite(input.deadline)) fail("input", "RPC call is invalid");
  const signal = input.signal === undefined || !state.signal ? input.signal ?? state.signal : AbortSignal.any([state.signal, input.signal]);
  if (signal?.aborted) fail("unavailable", "Request was cancelled");
  if (input.op === "send" || input.op === "post") {
    try { validateEnvelope(input.args.envelope, { board: input.op === "post" }); }
    catch (error) { if (error instanceof Fault) throw error; fail("data", "Envelope is not representable JSON"); }
  }
  let encoded;
  try { encoded = encodeJson({ v: 1, rid: input.rid, op: input.op, args: input.args }, LIMITS.requestBytes + 1); }
  catch (error) { if (error instanceof Fault) throw error; fail("data", "RPC arguments are not representable JSON"); }
  if (encoded.bytes > LIMITS.requestBytes) fail("protocol", "Request is too large", { id: input.rid });
  const payload = encoded.json;
  const started = performance.now(); let lastError; let mayHaveCommitted = false;
  const attempts = mutating.has(input.op) ? 3 : 1;
  for (let i = 0; i < attempts; i++) {
    let response;
    try {
      response = await request(state, "POST", "/v1/call", payload, input.deadline, true, signal);
      const body = response.value;
      const keys = body?.ok === true ? ["v", "rid", "ok", "result", "time", "replayed", "remainingMs"] : ["v", "rid", "ok", "fault", "time"];
      if (!object(body) || body.v !== 1 || body.rid !== input.rid || typeof body.ok !== "boolean" || !Number.isSafeInteger(body.time) || Object.keys(body).sort().join(",") !== [...keys].sort().join(",")) fail("protocol", "Broker response does not match request", { id: input.rid });
      if (!body.ok) throw parseFault(body);
      if (response.status < 200 || response.status >= 300) fail("protocol", "Broker returned an invalid success status", { id: input.rid });
      if (!Object.hasOwn(body, "result") || typeof body.replayed !== "boolean" || (body.remainingMs !== null && (!Number.isSafeInteger(body.remainingMs) || body.remainingMs < 0))) fail("protocol", "Broker success response is malformed", { id: input.rid });
      if (!validResult(input.op, body.result)) fail("protocol", "Broker result does not match the operation", { id: input.rid });
      if (input.op === "claim" && body.result !== null) {
        if (!Number.isSafeInteger(body.remainingMs) || body.remainingMs <= performance.now() - started) fail("expired", "Claim response arrived too late", { id: input.rid });
      } else if (body.remainingMs !== null) fail("protocol", "Broker returned an unexpected lease duration", { id: input.rid });
      return { v: 1, rid: input.rid, committedAt: mutating.has(input.op) ? body.time : null, replayed: body.replayed, result: body.result, remainingMs: body.remainingMs };
    } catch (error) {
      lastError = error;
      if (error instanceof Fault) {
        const ambiguous = ambiguousResponses.has(error) || response && response.status >= 200 && response.status < 300 && error.code === "protocol";
        const transient = ["timeout", "unavailable"].includes(error.code);
        if (mutating.has(input.op) && (ambiguous || transient)) mayHaveCommitted = true;
        if (state.closed) {
          if (mutating.has(input.op) && mayHaveCommitted) fail("uncertain", "Mutation outcome is uncertain", { id: input.rid });
          throw error;
        }
        if (ambiguous && mutating.has(input.op) && i + 1 < attempts && performance.now() < input.deadline) continue;
        if (ambiguous && mutating.has(input.op)) fail("uncertain", "Mutation response is uncertain", { id: input.rid });
        if (transient && mutating.has(input.op) && i + 1 < attempts && performance.now() < input.deadline) continue;
        if (transient) fail(mutating.has(input.op) ? "uncertain" : error.code, mutating.has(input.op) ? "Mutation outcome is uncertain" : error.message, { id: input.rid });
        if (mutating.has(input.op) && mayHaveCommitted && !["expired", "session"].includes(error.code)) fail("uncertain", "Mutation outcome is uncertain", { id: input.rid });
        throw error;
      }
      if (mutating.has(input.op)) mayHaveCommitted = true;
      if (i + 1 >= attempts || performance.now() >= input.deadline) break;
    }
  }
  if (mutating.has(input.op)) fail("uncertain", "Mutation outcome is uncertain", { id: input.rid });
  if (lastError?.message === "deadline") fail("timeout", "Request deadline elapsed", { id: input.rid });
  fail("unavailable", "Broker request failed");
}
