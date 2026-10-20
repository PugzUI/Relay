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
const ops = new Set([
  "register",
  "enroll",
  "join",
  "resume",
  "renew",
  "leave",
  "send",
  "post",
  "claim",
  "touch",
  "ack",
  "release",
  "get",
  "list",
  "pending",
  "stats",
  "audit",
  "report",
  "snapshot",
  "attempt",
]);
const mutating = new Set([
  "register",
  "enroll",
  "join",
  "resume",
  "renew",
  "leave",
  "send",
  "post",
  "claim",
  "touch",
  "ack",
  "release",
  "report",
]);
const MAX_RESPONSE_BYTES = 1_048_576;
const fail = (code, message, context) => {
  throw new Fault(code, message, context);
};
const ambiguousFault = (message) => {
  const error = new Fault("protocol", message);
  ambiguousResponses.add(error);
  return error;
};
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
  try {
    file = await openFile(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    );
  } catch {
    fail("unavailable", `${label} is unavailable or unsafe`);
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
    )
      fail("input", `${label} must be an owned private regular file`);
    if (stat.size > maxBytes) fail("input", `${label} is too large`);
    return await readBounded(file, maxBytes, label);
  } finally {
    await file.close();
  }
}
export async function readToken(path) {
  const value = await readPrivate(path, "Token file", 45);
  try {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      fail("input", "Token file has invalid contents");
    }
    const token = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail("input", "Token file has invalid contents");
    return token;
  } finally {
    value.fill(0);
  }
}
function endpoint(value, mode) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("input", "Broker URL is invalid");
  }
  if (
    value.includes("@") ||
    value.includes("?") ||
    value.includes("#") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.hostname.includes("%")
  )
    fail("input", "Broker URL must be an origin without credentials or selectors");
  if (url.protocol === "http:") {
    const literal =
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      (isIP(url.hostname) === 6 && url.hostname === "::1");
    if (mode !== "local" || !literal) fail("tls", "HTTP requires explicit local loopback mode");
  } else if (url.protocol !== "https:") fail("tls", "Broker URL scheme is unsupported");
  if (mode !== undefined && !["local", "lan", "tailscale"].includes(mode))
    fail("input", "Broker mode is invalid");
  return url;
}
function parseFault(body) {
  const f = body?.fault;
  const codes = new Set([
    "input",
    "data",
    "missing",
    "schema",
    "active",
    "session",
    "expired",
    "target",
    "device_conflict",
    "board",
    "key_conflict",
    "ack_conflict",
    "owner",
    "lease",
    "full",
    "busy",
    "clock",
    "storage",
    "auth",
    "denied",
    "protocol",
    "tls",
    "rpc_conflict",
    "uncertain",
    "cursor",
    "reset",
    "rate",
    "timeout",
    "unavailable",
  ]);
  if (!object(f) || !codes.has(f.code) || typeof f.message !== "string" || f.message.length > 256)
    fail("protocol", "Broker refusal is malformed");
  const context = object(f.context)
    ? Object.fromEntries(
        Object.entries(f.context).filter(
          ([k, v]) =>
            ["id", "mid", "sid", "lease", "retryAfterMs"].includes(k) &&
            (typeof v === "string" || Number.isSafeInteger(v)),
        ),
      )
    : undefined;
  return new Fault(f.code, f.message, context);
}
const ownShape = (value, required, optional = []) =>
  object(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const hasControlCharacter = (value) => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};
const id = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 256 &&
  !hasControlCharacter(value);
const address = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9._-]{1,63}:[A-Za-z0-9._-]{1,32}:(?:prime|[0-9]{3,32})$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const stringList = (value) =>
  Array.isArray(value) && value.length <= 512 && value.every((item) => typeof item === "string");
const digest64 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sortedKeys = (value) => Object.keys(value).sort().join(",");
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function decodeCursor(value, decodedLimit) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((decodedLimit * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length > decodedLimit || decoded.toString("base64url") !== value) return null;
  const json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  const token = parseJsonStrict(json, decodedLimit);
  if (
    !object(token) ||
    canonicalJson(token) !== json ||
    token.v !== 1 ||
    !id(token.authority) ||
    typeof token.scope !== "string" ||
    !digest64(token.scope)
  )
    return null;
  return token;
}
const validFeedCursor = (token) =>
  sortedKeys(token) === "authority,scope,seq,stream,v" && id(token.stream) && integer(token.seq);
const validSnapshotCursor = (token) =>
  sortedKeys(token) === "authority,boundary,filter,last,scope,time,v" &&
  digest64(token.filter) &&
  integer(token.boundary) &&
  integer(token.time) &&
  ownShape(token.last, ["agent", "link"]) &&
  (token.last.agent === null || id(token.last.agent)) &&
  (token.last.link === null || id(token.last.link));
const validPageCursor = (token) =>
  sortedKeys(token) === "authority,boundary,filter,last,scope,v" &&
  digest64(token.filter) &&
  integer(token.boundary) &&
  integer(token.last);
const cursorValidators = {
  feed: validFeedCursor,
  snapshot: validSnapshotCursor,
  page: validPageCursor,
};
const cursorToken = (value, kind = "page", decodedLimit = 1024) => {
  try {
    const token = decodeCursor(value, decodedLimit);
    if (!token) return false;
    const validator = Object.hasOwn(cursorValidators, kind)
      ? cursorValidators[kind]
      : validPageCursor;
    return validator(token);
  } catch {
    return false;
  }
};
function validDevice(value) {
  return (
    ownShape(value, ["id", "name", "init"]) &&
    id(value.id) &&
    typeof value.name === "string" &&
    integer(value.init)
  );
}
function validAgent(value) {
  return (
    ownShape(value, ["id", "device", "runtime", "slot", "caps", "epoch", "init"]) &&
    address(value.id) &&
    id(value.device) &&
    id(value.runtime) &&
    id(value.slot) &&
    stringList(value.caps) &&
    integer(value.epoch) &&
    integer(value.init)
  );
}
function validSession(value) {
  return (
    ownShape(value, ["id", "worker", "epoch", "until", "ended"]) &&
    id(value.id) &&
    address(value.worker) &&
    integer(value.epoch) &&
    integer(value.until) &&
    (value.ended === null || integer(value.ended))
  );
}
function validLease(value) {
  if (
    !ownShape(value, ["id", "mid", "sid", "epoch", "until", "attempt", "kind"], ["msg", "work"]) ||
    !id(value.id) ||
    !id(value.mid) ||
    !id(value.sid) ||
    !integer(value.epoch) ||
    !integer(value.until) ||
    !integer(value.attempt) ||
    !["msg", "work"].includes(value.kind)
  )
    return false;
  return value.kind === "msg"
    ? typeof value.msg === "string" && !Object.hasOwn(value, "work")
    : Object.hasOwn(value, "work") && !Object.hasOwn(value, "msg");
}
function validAdmission(value) {
  return (
    ownShape(value, ["id", "repeat", "init"]) &&
    id(value.id) &&
    typeof value.repeat === "boolean" &&
    integer(value.init)
  );
}
function validReceipt(value) {
  return (
    ownShape(value, ["mid", "lease", "sid", "epoch", "outcome", "time"]) &&
    id(value.mid) &&
    id(value.lease) &&
    id(value.sid) &&
    integer(value.epoch) &&
    ["done", "failed", "rejected"].includes(value.outcome) &&
    integer(value.time)
  );
}
function validRelease(value) {
  return (
    ownShape(value, ["mid", "lease", "sid", "epoch", "outcome", "time"]) &&
    id(value.mid) &&
    id(value.lease) &&
    id(value.sid) &&
    integer(value.epoch) &&
    value.outcome === "released" &&
    integer(value.time)
  );
}
function validStats(value) {
  return (
    ownShape(value, [
      "authority",
      "time",
      "messages",
      "sessions",
      "leases",
      "receipts",
      "devices",
      "agents",
      "boards",
      "audit",
    ]) &&
    id(value.authority) &&
    integer(value.time) &&
    ownShape(value.messages, [
      "pending",
      "claimed",
      "posted",
      "done",
      "failed",
      "rejected",
      "rows",
      "bytes",
    ]) &&
    Object.values(value.messages).every(integer) &&
    ownShape(value.sessions, ["live", "ended"]) &&
    Object.values(value.sessions).every(integer) &&
    ownShape(value.leases, ["live", "total"]) &&
    Object.values(value.leases).every(integer) &&
    integer(value.receipts) &&
    integer(value.devices) &&
    integer(value.agents) &&
    integer(value.boards) &&
    ownShape(value.audit, ["rows", "pruned"]) &&
    Object.values(value.audit).every(integer)
  );
}
function validMessage(value) {
  const required = [
    "id",
    "seq",
    "from",
    "to",
    "board",
    "kind",
    "needs",
    "series",
    "state",
    "init",
    "acked",
  ];
  if (
    !ownShape(value, required, ["data"]) ||
    !id(value.id) ||
    !integer(value.seq) ||
    (value.from !== null && !address(value.from)) ||
    (value.to !== null && !address(value.to)) ||
    (value.board !== null && typeof value.board !== "string") ||
    !["msg", "work"].includes(value.kind) ||
    !stringList(value.needs) ||
    (value.series !== null && typeof value.series !== "string") ||
    !["pending", "claimed", "posted", "done", "failed", "rejected"].includes(value.state) ||
    !integer(value.init) ||
    (value.acked !== null && !integer(value.acked))
  )
    return false;
  return (
    value.data === undefined ||
    (object(value.data) &&
      Object.keys(value.data).length === 1 &&
      (value.kind === "msg"
        ? typeof value.data.msg === "string" && !Object.hasOwn(value.data, "work")
        : Object.hasOwn(value.data, "work") && !Object.hasOwn(value.data, "msg")))
  );
}
function validPage(value, validator) {
  return (
    ownShape(value, [
      "items",
      "total",
      "visible",
      "complete",
      "cursor",
      "next",
      "firstSeq",
      "pruned",
    ]) &&
    Array.isArray(value.items) &&
    value.items.length <= 200 &&
    value.items.every(validator) &&
    integer(value.total) &&
    integer(value.visible) &&
    value.visible === value.items.length &&
    typeof value.complete === "boolean" &&
    typeof value.cursor === "string" &&
    (value.next === null || cursorToken(value.next, "page")) &&
    value.complete === (value.next === null) &&
    (value.firstSeq === null || integer(value.firstSeq)) &&
    integer(value.pruned)
  );
}
function validSnapshot(value) {
  const countSet = (v, keys) => ownShape(v, keys) && keys.every((key) => integer(v[key]));
  const device = (v) =>
    ownShape(v, ["id", "name", "init", "authority", "receivedAt", "stale", "free"]) &&
    id(v.id) &&
    typeof v.name === "string" &&
    integer(v.init) &&
    id(v.authority) &&
    (v.receivedAt === null || integer(v.receivedAt)) &&
    typeof v.stale === "boolean" &&
    [null, 0, 1].includes(v.free);
  const agent = (v) =>
    ownShape(v, [
      "id",
      "device",
      "runtime",
      "slot",
      "caps",
      "epoch",
      "init",
      "state",
      "assignmentCount",
      "receivedAt",
    ]) &&
    address(v.id) &&
    id(v.device) &&
    id(v.runtime) &&
    id(v.slot) &&
    stringList(v.caps) &&
    integer(v.epoch) &&
    integer(v.init) &&
    ["registered", "starting", "ready", "busy", "unknown", "stale"].includes(v.state) &&
    [0, 1].includes(v.assignmentCount) &&
    (v.receivedAt === null || integer(v.receivedAt));
  const board = (v) =>
    ownShape(v, [
      "id",
      "kind",
      "device",
      "authority",
      "inbox",
      "pending",
      "claimed",
      "terminal",
      "reported",
      "receivedAt",
    ]) &&
    id(v.id) &&
    ["bounty", "host"].includes(v.kind) &&
    (v.device === null || id(v.device)) &&
    id(v.authority) &&
    [v.inbox, v.pending, v.claimed, v.terminal].every(integer) &&
    typeof v.reported === "boolean" &&
    (v.receivedAt === null || integer(v.receivedAt));
  const link = (v) =>
    ownShape(v, ["id", "from", "to", "kind", "state", "mid", "time"]) &&
    id(v.id) &&
    id(v.from) &&
    id(v.to) &&
    ["addressed", "board", "report"].includes(v.kind) &&
    ["active", "stale", "unknown"].includes(v.state) &&
    (v.mid === null || id(v.mid)) &&
    (v.time === null || integer(v.time));
  if (
    !ownShape(value, [
      "v",
      "authority",
      "time",
      "cursor",
      "devices",
      "agents",
      "boards",
      "links",
      "totals",
      "visible",
      "complete",
      "next",
    ]) ||
    value.v !== 1 ||
    !id(value.authority) ||
    !integer(value.time) ||
    !cursorToken(value.cursor, "feed", 512) ||
    typeof value.complete !== "boolean" ||
    (value.next !== null && !cursorToken(value.next, "snapshot")) ||
    value.complete !== (value.next === null)
  )
    return false;
  if (
    !Array.isArray(value.devices) ||
    value.devices.length > 64 ||
    !value.devices.every(device) ||
    !Array.isArray(value.agents) ||
    value.agents.length > 512 ||
    !value.agents.every(agent) ||
    !Array.isArray(value.boards) ||
    value.boards.length > 64 ||
    !value.boards.every(board) ||
    !Array.isArray(value.links) ||
    value.links.length > 512 ||
    !value.links.every(link)
  )
    return false;
  const keys = ["devices", "agents", "boards", "links"];
  return (
    countSet(value.totals, keys) &&
    countSet(value.visible, keys) &&
    keys.every(
      (key) => value.visible[key] === value[key].length && value.totals[key] >= value.visible[key],
    )
  );
}
const validEnroll = (value) =>
  ownShape(value, ["id", "name", "init", "repeat"]) &&
  validDevice({ id: value.id, name: value.name, init: value.init }) &&
  typeof value.repeat === "boolean";
const validLeave = (value) =>
  ownShape(value, ["sid", "epoch", "ended"]) &&
  id(value.sid) &&
  integer(value.epoch) &&
  integer(value.ended);
const validClaim = (value) => value === null || validLease(value);
const validGet = (value) => value === null || validMessage(value);
const validList = (value) => validPage(value, validMessage);
const validPending = (value) =>
  ownShape(value, ["v", "authority", "worker", "epoch", "revision", "pending", "recoverable"]) &&
  value.v === 1 &&
  id(value.authority) &&
  address(value.worker) &&
  integer(value.epoch) &&
  typeof value.revision === "string" &&
  /^[0-9a-f]{64}$/.test(value.revision) &&
  [value.pending, value.recoverable].every(
    (counts) => ownShape(counts, ["msg", "work"]) && integer(counts.msg) && integer(counts.work),
  );
const validAudit = (value) =>
  validPage(
    value,
    (v) =>
      ownShape(v, ["seq", "time", "type", "worker", "sid", "mid", "lease", "code"]) &&
      integer(v.seq) &&
      integer(v.time) &&
      typeof v.type === "string" &&
      (v.worker === null || id(v.worker)) &&
      (v.sid === null || id(v.sid)) &&
      (v.mid === null || id(v.mid)) &&
      (v.lease === null || id(v.lease)) &&
      (v.code === null || typeof v.code === "string"),
  );
const validReport = (value) =>
  ownShape(value, ["accepted", "receivedAt", "staleAfter", "seq"]) &&
  value.accepted === true &&
  integer(value.receivedAt) &&
  integer(value.staleAfter) &&
  integer(value.seq);
const validAttempt = (value) =>
  value === null ||
  (ownShape(value, ["mid", "worker", "sid", "epoch", "lease", "attempt", "until", "state"]) &&
    id(value.mid) &&
    address(value.worker) &&
    id(value.sid) &&
    integer(value.epoch) &&
    id(value.lease) &&
    integer(value.attempt) &&
    integer(value.until) &&
    ["live", "done", "failed", "rejected", "released", "expired", "superseded", "unknown"].includes(
      value.state,
    ));
const resultValidators = {
  register: validAgent,
  enroll: validEnroll,
  join: validSession,
  resume: validSession,
  renew: validSession,
  leave: validLeave,
  send: validAdmission,
  post: validAdmission,
  claim: validClaim,
  touch: validLease,
  ack: validReceipt,
  release: validRelease,
  get: validGet,
  list: validList,
  pending: validPending,
  stats: validStats,
  audit: validAudit,
  report: validReport,
  snapshot: validSnapshot,
  attempt: validAttempt,
};
function validResult(op, value) {
  if (!Object.hasOwn(resultValidators, op)) return false;
  return resultValidators[op](value);
}

function responseHeadersValid(res) {
  if (res.headers["content-encoding"] !== undefined) return false;
  const type = res.headers["content-type"];
  if (typeof type !== "string") return false;
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type);
}
function readResponse(res, req, finish) {
  const status = res.statusCode;
  const success = status >= 200 && status < 300;
  if (status >= 300 && status < 400) {
    res.destroy();
    req.destroy();
    finish(ambiguousFault("Broker redirects are not followed"));
    return;
  }
  if (!responseHeadersValid(res)) {
    res.destroy();
    finish(
      success
        ? ambiguousFault("Broker response headers are invalid")
        : new Fault("protocol", "Broker response headers are invalid"),
    );
    return;
  }
  let responseBytes = 0;
  const chunks = [];
  res.on("data", (chunk) => {
    responseBytes += chunk.length;
    if (responseBytes > MAX_RESPONSE_BYTES) {
      req.destroy();
      finish(ambiguousFault("Broker response is too large"));
      return;
    }
    chunks.push(chunk);
  });
  res.on("end", () => {
    let parsed;
    try {
      parsed = parseJsonStrict(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        MAX_RESPONSE_BYTES,
      );
    } catch {
      finish(
        success
          ? ambiguousFault("Broker response is malformed")
          : new Fault("protocol", "Broker response is malformed"),
      );
      return;
    }
    finish(null, { status, headers: res.headers, value: parsed });
  });
  res.on("error", (error) => finish(error));
}

function request(state, method, path, body, deadline, auth = true, signal = state.signal) {
  if (state.closed) return Promise.reject(new Fault("unavailable", "Client is closed"));
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(new Fault("timeout", "Request deadline elapsed"));
  if (signal?.aborted) return Promise.reject(new Fault("unavailable", "Request was cancelled"));
  const transport = state.url.protocol === "https:" ? https : http;
  const options = {
    protocol: state.url.protocol,
    hostname: state.url.hostname,
    port: state.url.port || undefined,
    method,
    path,
    maxHeaderSize: 8192,
    headers: {
      Accept: "application/json",
      ...(auth ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
    },
    agent: false,
  };
  if (state.ca) options.ca = state.ca;
  return new Promise((resolve, reject) => {
    let settled = false;
    let abort;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.requests.delete(req);
      if (abort) signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const req = transport.request(options, (res) => {
      readResponse(res, req, finish);
    });
    state.requests.add(req);
    const timer = setTimeout(
      () => {
        req.destroy(new Error("deadline"));
        finish(new Fault("timeout", "Request deadline elapsed"));
      },
      Math.max(1, Math.min(remaining, 3000)),
    );
    if (signal?.aborted) {
      req.destroy();
      finish(new Fault("unavailable", "Request was cancelled"));
      return;
    }
    abort = () => {
      req.destroy();
      finish(new Fault("unavailable", "Request was cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    req.on("error", (error) => finish(error));
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

function closeState(state) {
  if (!state || state.closed) return;
  state.closed = true;
  state.token = null;
  state.ca = null;
  for (const req of state.requests) req.destroy(new Error("client closed"));
  state.requests.clear();
}

export class Client {
  constructor(token) {
    if (token !== clientToken) throw new TypeError("Use connect()");
  }
  get authority() {
    return clients.get(this)?.authority ?? "";
  }
  register(runtime, options) {
    return this.#call("register", { runtime, ...(options === undefined ? {} : { options }) });
  }
  enroll(device) {
    return this.#call("enroll", { device });
  }
  join(worker, options) {
    return this.#call("join", { worker, ...(options === undefined ? {} : { options }) });
  }
  resume(sid) {
    return this.#call("resume", { sid });
  }
  renew(sid) {
    return this.#call("renew", { sid });
  }
  leave(sid) {
    return this.#call("leave", { sid });
  }
  send(sid, to, envelope, options) {
    return this.#call("send", { sid, to, envelope, ...(options === undefined ? {} : { options }) });
  }
  post(sid, board, envelope, options) {
    return this.#call("post", {
      sid,
      board,
      envelope,
      ...(options === undefined ? {} : { options }),
    });
  }
  claim(sid, options) {
    return this.#call("claim", { sid, ...(options === undefined ? {} : { options }) });
  }
  touch(sid, lease) {
    return this.#call("touch", { sid, lease });
  }
  ack(sid, lease, outcome) {
    return this.#call("ack", { sid, lease, outcome });
  }
  release(sid, lease) {
    return this.#call("release", { sid, lease });
  }
  get(id, options) {
    return this.#call("get", { id, ...(options === undefined ? {} : { options }) });
  }
  list(options) {
    return this.#call("list", { ...(options === undefined ? {} : { options }) });
  }
  pending(sid) {
    return this.#call("pending", { sid });
  }
  stats() {
    return this.#call("stats", {});
  }
  audit(options) {
    return this.#call("audit", { ...(options === undefined ? {} : { options }) });
  }
  report(sid, report) {
    return this.#call("report", { sid, report });
  }
  snapshot(options) {
    return this.#call("snapshot", { ...(options === undefined ? {} : { options }) });
  }
  async #call(op, args) {
    const state = clients.get(this);
    if (!state) fail("unavailable", "Client is closed");
    const outcome = await invokeClient(this, {
      rid: rid(),
      op,
      args,
      deadline: performance.now() + 10000,
    });
    return outcome.result;
  }
  close() {
    try {
      closeState(clients.get(this));
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve();
  }
}

export function connect(options) {
  return openClient(options, { checkHealth: true });
}

export function createFixedClient(options, signal, { checkHealth = false, deadline } = {}) {
  return openClient(options, { checkHealth, signal, deadline });
}

function validClientOptions(options) {
  if (!object(options)) fail("input", "Client options are invalid");
  if (Object.keys(options).some((key) => !["url", "tokenFile", "caFile", "mode"].includes(key)))
    fail("input", "Client options are invalid");
  if (typeof options.url !== "string") fail("input", "Client options are invalid");
  if (typeof options.tokenFile !== "string") fail("input", "Client options are invalid");
  if (options.caFile !== undefined && typeof options.caFile !== "string")
    fail("input", "Client options are invalid");
}
async function loadCaFile(caFile) {
  if (caFile === undefined) return undefined;
  const ca = await readPrivate(caFile, "CA file", MAX_RESPONSE_BYTES);
  if (!ca.length) fail("input", "CA file is invalid");
  return ca;
}
async function checkBrokerHealth(state, deadline) {
  const health = await request(state, "GET", "/v1/health", undefined, deadline);
  if (health.status < 200 || health.status >= 300) throw parseFault(health.value);
  if (
    health.value?.v !== 1 ||
    !id(health.value.authority) ||
    !integer(health.value.time) ||
    Object.keys(health.value).sort().join(",") !== "authority,time,v"
  )
    fail("protocol", "Broker health response is invalid");
  state.authority = health.value.authority;
}
async function openClient(options, { checkHealth, signal, deadline: operationDeadline } = {}) {
  validClientOptions(options);
  const url = endpoint(options.url, options.mode);
  const token = await readToken(options.tokenFile);
  const ca = await loadCaFile(options.caFile);
  const client = new Client(clientToken);
  const state = { url, token, ca, requests: new Set(), closed: false, authority: null, signal };
  clients.set(client, state);
  try {
    if (checkHealth) await checkBrokerHealth(state, operationDeadline ?? performance.now() + 10000);
    return client;
  } catch (error) {
    await client.close();
    if (
      !(error instanceof Fault) &&
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "ENOTFOUND",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "ETIMEDOUT",
      ].includes(error?.code)
    ) {
      throw new Fault("unavailable", "Broker connection is unavailable", { cause: error });
    }
    throw error;
  }
}

function validCallShape(input) {
  if (!object(input)) return false;
  const fields = Object.keys(input).sort().join(",");
  if (!["args,deadline,op,rid", "args,deadline,op,rid,signal"].includes(fields)) return false;
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) return false;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.rid)) return false;
  if (!ops.has(input.op)) return false;
  if (!object(input.args)) return false;
  return Number.isFinite(input.deadline);
}
function readCallInput(state, input) {
  if (!validCallShape(input)) fail("input", "RPC call is invalid");
  const signal =
    input.signal === undefined || !state.signal
      ? (input.signal ?? state.signal)
      : AbortSignal.any([state.signal, input.signal]);
  if (signal?.aborted) fail("unavailable", "Request was cancelled");
  return { rid: input.rid, op: input.op, args: input.args, deadline: input.deadline, signal };
}
function validateCallEnvelope(call) {
  if (call.op !== "send" && call.op !== "post") return;
  try {
    validateEnvelope(call.args.envelope, { board: call.op === "post" });
  } catch (error) {
    if (error instanceof Fault) throw error;
    fail("data", "Envelope is not representable JSON");
  }
}
function encodeCallPayload(call) {
  let encoded;
  try {
    encoded = encodeJson(
      { v: 1, rid: call.rid, op: call.op, args: call.args },
      LIMITS.requestBytes + 1,
    );
  } catch (error) {
    if (error instanceof Fault) throw error;
    fail("data", "RPC arguments are not representable JSON");
  }
  if (encoded.bytes > LIMITS.requestBytes)
    fail("protocol", "Request is too large", { id: call.rid });
  return encoded.json;
}
function assertClaimTiming(body, call, started) {
  if (call.op !== "claim" || body.result === null) {
    if (body.remainingMs !== null)
      fail("protocol", "Broker returned an unexpected lease duration", { id: call.rid });
    return;
  }
  if (!Number.isSafeInteger(body.remainingMs) || body.remainingMs <= performance.now() - started)
    fail("expired", "Claim response arrived too late", { id: call.rid });
}
function readCallResult(body, call, started) {
  if (
    !Object.hasOwn(body, "result") ||
    typeof body.replayed !== "boolean" ||
    (body.remainingMs !== null && (!Number.isSafeInteger(body.remainingMs) || body.remainingMs < 0))
  )
    fail("protocol", "Broker success response is malformed", { id: call.rid });
  if (!validResult(call.op, body.result))
    fail("protocol", "Broker result does not match the operation", { id: call.rid });
  assertClaimTiming(body, call, started);
  return {
    v: 1,
    rid: call.rid,
    committedAt: mutating.has(call.op) ? body.time : null,
    replayed: body.replayed,
    result: body.result,
    remainingMs: body.remainingMs,
  };
}
function readCallResponse(response, call, started) {
  const body = response.value;
  const keys =
    body?.ok === true
      ? ["v", "rid", "ok", "result", "time", "replayed", "remainingMs"]
      : ["v", "rid", "ok", "fault", "time"];
  if (
    !object(body) ||
    body.v !== 1 ||
    body.rid !== call.rid ||
    typeof body.ok !== "boolean" ||
    !Number.isSafeInteger(body.time) ||
    Object.keys(body).sort().join(",") !== [...keys].sort().join(",")
  )
    fail("protocol", "Broker response does not match request", { id: call.rid });
  if (!body.ok) throw parseFault(body);
  if (response.status < 200 || response.status >= 300)
    fail("protocol", "Broker returned an invalid success status", { id: call.rid });
  return readCallResult(body, call, started);
}
function faultIsAmbiguous(error, response) {
  if (ambiguousResponses.has(error)) return true;
  if (!response) return false;
  return response.status >= 200 && response.status < 300 && error.code === "protocol";
}
function closedCallDecision(context) {
  if (!context.state.closed) return null;
  if (mutating.has(context.op) && context.tracker.mayHaveCommitted)
    fail("uncertain", "Mutation outcome is uncertain", { id: context.rid });
  return "throw";
}
function ambiguousCallDecision(context) {
  if (context.attempt + 1 < context.attempts && performance.now() < context.deadline)
    return "retry";
  fail("uncertain", "Mutation response is uncertain", { id: context.rid });
}
function transientCallDecision(error, context) {
  if (
    mutating.has(context.op) &&
    context.attempt + 1 < context.attempts &&
    performance.now() < context.deadline
  )
    return "retry";
  if (mutating.has(context.op))
    fail("uncertain", "Mutation outcome is uncertain", { id: context.rid });
  fail(error.code, error.message, { id: context.rid });
}
function faultCallDecision(error, context) {
  const mutatingOp = mutating.has(context.op);
  const ambiguous = faultIsAmbiguous(error, context.response);
  const transient = error.code === "timeout" || error.code === "unavailable";
  if (mutatingOp && (ambiguous || transient)) context.tracker.mayHaveCommitted = true;
  const closed = closedCallDecision(context);
  if (closed) return closed;
  if (ambiguous && mutatingOp) return ambiguousCallDecision(context);
  if (transient) return transientCallDecision(error, context);
  if (
    mutatingOp &&
    context.tracker.mayHaveCommitted &&
    error.code !== "expired" &&
    error.code !== "session"
  )
    fail("uncertain", "Mutation outcome is uncertain", { id: context.rid });
  return "throw";
}
function unknownCallDecision(context) {
  if (mutating.has(context.op)) context.tracker.mayHaveCommitted = true;
  if (context.attempt + 1 >= context.attempts || performance.now() >= context.deadline)
    return "break";
  return "retry";
}
export async function invokeClient(client, input) {
  const state = clients.get(client);
  if (!state || state.closed) fail("unavailable", "Client is closed");
  const call = readCallInput(state, input);
  validateCallEnvelope(call);
  const payload = encodeCallPayload(call);
  const outcome = await runCall(state, call, payload, performance.now());
  return outcome;
}
async function attemptCall(state, call, payload, started, context) {
  let response;
  try {
    response = await request(state, "POST", "/v1/call", payload, call.deadline, true, call.signal);
    return { outcome: readCallResponse(response, call, started), decision: null, error: null };
  } catch (error) {
    context.response = response;
    const decision =
      error instanceof Fault ? faultCallDecision(error, context) : unknownCallDecision(context);
    return { outcome: null, decision, error };
  }
}
function callFailed(call, lastError) {
  if (mutating.has(call.op)) fail("uncertain", "Mutation outcome is uncertain", { id: call.rid });
  if (lastError?.message === "deadline")
    fail("timeout", "Request deadline elapsed", { id: call.rid });
  fail("unavailable", "Broker request failed");
}
async function runCall(state, call, payload, started) {
  let lastError;
  const tracker = { mayHaveCommitted: false };
  const attempts = mutating.has(call.op) ? 3 : 1;
  const context = {
    state,
    op: call.op,
    rid: call.rid,
    deadline: call.deadline,
    attempts,
    tracker,
    attempt: 0,
    response: undefined,
  };
  for (let attempt = 0; attempt < attempts; attempt++) {
    context.attempt = attempt;
    const result = await attemptCall(state, call, payload, started, context);
    if (result.outcome) return result.outcome;
    lastError = result.error;
    if (result.decision === "retry") continue;
    if (result.decision === "break") break;
    throw result.error;
  }
  callFailed(call, lastError);
}
