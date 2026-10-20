import { createHash, timingSafeEqual } from "node:crypto";
import { open as openFile } from "node:fs/promises";
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { Fault } from "./fault.mjs";
import { parseJsonStrict } from "./config.mjs";

const denied = (message = "Operation denied") => {
  throw new Fault("denied", message);
};
const input = (message = "Operation arguments are invalid") => {
  throw new Fault("input", message);
};
const obj = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => obj(v) && Object.keys(v).every((k) => keys.includes(k));
const required = (v, keys) => exact(v, keys) && keys.every((k) => Object.hasOwn(v, k));
const hasControl = (v) => {
  for (const ch of v) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};
const text = (v, max = 256) =>
  typeof v === "string" &&
  Buffer.byteLength(v, "utf8") > 0 &&
  Buffer.byteLength(v, "utf8") <= max &&
  !hasControl(v);
const address = (v) =>
  text(v, 160) && /^[A-Za-z0-9._-]{1,63}:[A-Za-z0-9._-]{1,32}:(?:prime|[0-9]{3,32})$/.test(v);
const board = (v) =>
  v === "bounty" || (typeof v === "string" && /^host:[A-Za-z0-9._-]{1,128}$/.test(v));
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const hash = (v) => createHash("sha256").update(v).digest("hex");
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (obj(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
};
const uniq = (values, valid) =>
  Array.isArray(values) &&
  values.length <= 256 &&
  values.every(valid) &&
  new Set(values).size === values.length;
const setList = (v, predicate, label) => {
  if (!uniq(v, predicate)) input(`${label} contains invalid or duplicate entries`);
  return Object.freeze([...v].sort());
};
const tag = (v) => typeof v === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(v);
const opaque = (v) => text(v, 128) && !/[\\/]/.test(v);
const cursorCommon = (value) =>
  obj(value) && value.v === 1 && text(value.authority, 128) && digest(value.scope);
const cursorSnapshot = (value) =>
  required(value, ["v", "authority", "scope", "filter", "boundary", "time", "last"]) &&
  digest(value.filter) &&
  Number.isSafeInteger(value.boundary) &&
  value.boundary >= 0 &&
  Number.isSafeInteger(value.time) &&
  value.time >= 0 &&
  required(value.last, ["agent", "link"]) &&
  (value.last.agent === null || text(value.last.agent, 160)) &&
  (value.last.link === null || text(value.last.link, 256));
const cursorFeed = (value, decodedLimit) =>
  decodedLimit === 512 &&
  required(value, ["v", "authority", "stream", "seq", "scope"]) &&
  text(value.stream, 128) &&
  Number.isSafeInteger(value.seq) &&
  value.seq >= 0;
const cursorPage = (value) =>
  required(value, ["v", "authority", "scope", "filter", "boundary", "last"]) &&
  digest(value.filter) &&
  Number.isSafeInteger(value.boundary) &&
  value.boundary >= 0 &&
  Number.isSafeInteger(value.last) &&
  value.last >= 0;
const decodeCursor = (v, decodedLimit) => {
  const decoded = Buffer.from(v, "base64url");
  if (decoded.length > decodedLimit || decoded.toString("base64url") !== v) return undefined;
  const json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  const value = parseJsonStrict(json, decodedLimit);
  return canonical(value) === json ? value : undefined;
};
const cursorToken = (v, kind = "page", decodedLimit = 1024) => {
  if (
    typeof v !== "string" ||
    v.length > Math.ceil((decodedLimit * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(v)
  )
    return false;
  let value;
  try {
    value = decodeCursor(v, decodedLimit);
  } catch {
    return false;
  }
  if (value === undefined || !cursorCommon(value)) return false;
  if (kind === "snapshot") return cursorSnapshot(value);
  if (kind === "feed") return cursorFeed(value, decodedLimit);
  return cursorPage(value);
};
const keyValid = (v) =>
  typeof v === "string" &&
  Buffer.byteLength(v, "utf8") > 0 &&
  Buffer.byteLength(v, "utf8") <= 128 &&
  !hasControl(v);
function validJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  let valid;
  if (Array.isArray(value))
    valid =
      Object.keys(value).length === value.length &&
      value.every((item, index) => Object.hasOwn(value, index) && validJson(item, seen));
  else valid = obj(value) && Object.keys(value).every((key) => validJson(value[key], seen));
  seen.delete(value);
  return valid;
}
const envelopeBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const msgEnvelope = (value) =>
  typeof value.msg === "string" && value.msg.length > 0 && envelopeBytes(value) <= 65536;
const workEnvelope = (value) => validJson(value.work) && envelopeBytes(value) <= 65536;
function validateEnvelope(value) {
  if (!obj(value)) input("Envelope must contain exactly one kind");
  const keys = Object.keys(value);
  if (keys.length !== 1) input("Envelope must contain exactly one kind");
  const kind = keys[0];
  if (kind === "msg") {
    if (!msgEnvelope(value)) input("Message envelope is invalid");
  } else if (kind === "work") {
    if (!workEnvelope(value)) input("Work envelope is invalid");
  } else input("Envelope kind is invalid");
  return kind;
}
const reportShapeValid = (value) =>
  required(value, ["seq", "agents", "board"]) ||
  (obj(value) && Object.keys(value).sort().join(",") === "agents,board,events,seq");
const reportAgentValid = (agent) =>
  required(agent, ["worker", "state", "free", "assignmentCount"]) &&
  address(agent.worker) &&
  ["starting", "ready", "busy", "unknown"].includes(agent.state) &&
  [0, 1, null].includes(agent.free) &&
  [0, 1].includes(agent.assignmentCount);
const reportSeqValid = (value) =>
  Number.isSafeInteger(value.seq) &&
  value.seq >= 0 &&
  Array.isArray(value.agents) &&
  value.agents.length <= 512;
const reportBoardValid = (boardValue) =>
  required(boardValue, ["id", "inbox", "pending", "claimed", "terminal"]) &&
  board(boardValue.id) &&
  [boardValue.inbox, boardValue.pending, boardValue.claimed, boardValue.terminal].every(
    (n) => Number.isSafeInteger(n) && n >= 0,
  );
const reportEventBaseValid = (event) =>
  required(event, ["seq", "type", "from", "to", "mid", "state", "code"]) &&
  Number.isSafeInteger(event.seq) &&
  event.seq >= 0 &&
  ["post", "claim", "release", "ack", "refusal"].includes(event.type) &&
  text(event.from, 160) &&
  text(event.to, 160);
const reportEventValid = (event) =>
  reportEventBaseValid(event) &&
  (event.mid === null || opaque(event.mid)) &&
  (event.state === null ||
    ["pending", "claimed", "posted", "done", "failed", "rejected"].includes(event.state)) &&
  (event.code === null || text(event.code, 32));
const reportAgentsValid = (agents) => {
  for (const agent of agents) {
    if (!reportAgentValid(agent)) input("Report agent is invalid");
  }
};
const reportEventsValid = (events) => {
  if (!Array.isArray(events) || events.length > 2048) input("Report events are invalid");
  for (const event of events) {
    if (!reportEventValid(event)) input("Report event is invalid");
  }
};
function validateReport(value) {
  if (!reportShapeValid(value)) input("Report shape is invalid");
  if (!reportSeqValid(value)) input("Report shape is invalid");
  reportAgentsValid(value.agents);
  if (!reportBoardValid(value.board)) input("Report board is invalid");
  if (value.events !== undefined) reportEventsValid(value.events);
  if (Buffer.byteLength(JSON.stringify(value)) > 32768) input("Report is too large");
}
function normalizeGrant(g) {
  const fields = [
    "enroll",
    "register",
    "workers",
    "recipients",
    "boardPost",
    "boardClaim",
    "inboxRead",
    "workRead",
    "inspect",
    "reportDevice",
  ];
  if (!required(g, fields)) input("Credential grant shape is invalid");
  if (!Array.isArray(g.enroll) || g.enroll.length > 256) input("enroll grant is invalid");
  const enroll = g.enroll.map((v) => {
    if (
      !required(v, ["deviceId", "deviceName"]) ||
      !opaque(v.deviceId) ||
      !/^[A-Za-z0-9._-]{1,63}$/.test(v.deviceName)
    )
      input("enroll grant is invalid");
    return Object.freeze({ deviceId: v.deviceId, deviceName: v.deviceName });
  });
  if (
    new Set(enroll.map((x) => x.deviceId)).size !== enroll.length ||
    new Set(enroll.map((x) => x.deviceName.toLowerCase())).size !== enroll.length
  )
    input("enroll grant has duplicate entries");
  enroll.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  if (!Array.isArray(g.register) || g.register.length > 1)
    input("register grant must contain at most one namespace");
  const register = g.register.map((v) => {
    if (
      !required(v, ["deviceId", "deviceName", "runtimes", "allocate"]) ||
      !opaque(v.deviceId) ||
      !/^[A-Za-z0-9._-]{1,63}$/.test(v.deviceName) ||
      typeof v.allocate !== "boolean"
    )
      input("register grant is invalid");
    const runtimes = setList(v.runtimes, (x) => tag(x) && x !== "prime", "runtimes");
    return Object.freeze({
      deviceId: v.deviceId,
      deviceName: v.deviceName,
      runtimes,
      allocate: v.allocate,
    });
  });
  const workerPredicate = address;
  const boardPredicate = board;
  if (
    !required(g.inspect, ["messages", "receipts", "audit", "topology"]) ||
    Object.values(g.inspect).some((v) => typeof v !== "boolean")
  )
    input("inspect grant is invalid");
  if (g.reportDevice !== null && !opaque(g.reportDevice)) input("reportDevice is invalid");
  return Object.freeze({
    enroll: Object.freeze(enroll),
    register: Object.freeze(register),
    workers: setList(g.workers, workerPredicate, "workers"),
    recipients: setList(g.recipients, workerPredicate, "recipients"),
    boardPost: setList(g.boardPost, boardPredicate, "boardPost"),
    boardClaim: setList(g.boardClaim, boardPredicate, "boardClaim"),
    inboxRead: setList(g.inboxRead, boardPredicate, "inboxRead"),
    workRead: setList(g.workRead, boardPredicate, "workRead"),
    inspect: Object.freeze({
      messages: g.inspect.messages,
      receipts: g.inspect.receipts,
      audit: g.inspect.audit,
      topology: g.inspect.topology,
    }),
    reportDevice: g.reportDevice,
  });
}

const devGrant = normalizeGrant({
  enroll: [],
  register: [],
  workers: [],
  recipients: [],
  boardPost: [],
  boardClaim: [],
  inboxRead: [],
  workRead: [],
  inspect: { messages: false, receipts: false, audit: false, topology: true },
  reportDevice: null,
});
const devScopeKey = hash(canonical(devGrant));

function decodeRegistry(stat, data) {
  let bytes;
  try {
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
      throw new Error("unsafe file");
    bytes =
      typeof data === "string" ? data : new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Fault("unavailable", "Credential registry is unavailable or unsafe");
  }
  const doc = parseJsonStrict(bytes, 1_048_576);
  if (
    !required(doc, ["version", "credentials"]) ||
    doc.version !== 1 ||
    !Array.isArray(doc.credentials) ||
    doc.credentials.length > 256
  )
    input("Credential registry shape is invalid");
  const principals = new Set();
  const digests = new Set();
  const credentials = doc.credentials.map((entry) => {
    if (
      !required(entry, ["principal", "tokenDigest", "grant"]) ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(entry.principal) ||
      !digest(entry.tokenDigest)
    )
      input("Credential entry is invalid");
    if (principals.has(entry.principal) || digests.has(entry.tokenDigest))
      input("Credential registry contains duplicates");
    principals.add(entry.principal);
    digests.add(entry.tokenDigest);
    const grant = normalizeGrant(entry.grant);
    const scopeKey = hash(canonical(grant));
    return Object.freeze({
      principal: entry.principal,
      tokenDigest: entry.tokenDigest,
      grant,
      scopeKey,
    });
  });
  const digestIndex = new Map(credentials.map((entry) => [entry.tokenDigest, entry.principal]));
  return Object.freeze({ version: 1, credentials: Object.freeze(credentials), digestIndex });
}

function registryBuffer(stat) {
  if (
    !stat.isFile() ||
    stat.size > 1_048_576 ||
    (process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
  ) {
    throw new Fault("unavailable", "Credential registry is unavailable or unsafe");
  }
  // One extra byte detects growth without allowing unbounded reads after stat.
  return Buffer.alloc(stat.size + 1);
}

export async function loadRegistry(filePath) {
  let file;
  let buffer;
  try {
    file = await openFile(
      filePath,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    );
  } catch {
    throw new Fault("unavailable", "Credential registry is unavailable or unsafe");
  }
  try {
    const stat = await file.stat();
    buffer = registryBuffer(stat);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > stat.size)
      throw new Fault("unavailable", "Credential registry changed while reading");
    return decodeRegistry(stat, buffer.subarray(0, size));
  } finally {
    buffer?.fill(0);
    await file.close();
  }
}

export function loadRegistrySync(filePath) {
  let fd;
  let buffer;
  try {
    fd = openSync(
      filePath,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    );
    const stat = fstatSync(fd);
    buffer = registryBuffer(stat);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > stat.size)
      throw new Fault("unavailable", "Credential registry changed while reading");
    return decodeRegistry(stat, buffer.subarray(0, size));
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault("unavailable", "Credential registry is unavailable or unsafe");
  } finally {
    buffer?.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

const authRequired = () => {
  throw new Fault("auth", "Authentication required");
};
const bearerToken = (header) => {
  let value = header;
  if (Array.isArray(value)) {
    if (value.length !== 1) authRequired();
    [value] = value;
  }
  if (typeof value !== "string" || value.length > 64 || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value))
    authRequired();
  return value.slice(7);
};
const devTokenPrincipal = (tokenDigest) => {
  const devToken = process.env.DEV_RELAY;
  if (typeof devToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(devToken)) return null;
  const devDigest = createHash("sha256").update(devToken, "ascii").digest();
  if (!timingSafeEqual(tokenDigest, devDigest)) return null;
  return Object.freeze({ id: "dev-relay", grant: devGrant, scopeKey: devScopeKey });
};
export function authenticate(snapshot, authorizationHeader) {
  if (snapshot?.version !== 1) authRequired();
  const tokenDigest = createHash("sha256")
    .update(bearerToken(authorizationHeader), "ascii")
    .digest();
  const dev = devTokenPrincipal(tokenDigest);
  if (dev) return dev;
  let match = null;
  for (const entry of snapshot.credentials) {
    const candidate = Buffer.from(entry.tokenDigest, "hex");
    if (timingSafeEqual(tokenDigest, candidate)) match = entry;
  }
  if (!match) authRequired();
  return Object.freeze({ id: match.principal, grant: match.grant, scopeKey: match.scopeKey });
}

const opKeys = Object.freeze({
  register: ["runtime", "options"],
  enroll: ["device"],
  join: ["worker", "options"],
  resume: ["sid"],
  renew: ["sid"],
  leave: ["sid"],
  send: ["sid", "to", "envelope", "options"],
  post: ["sid", "board", "envelope", "options"],
  claim: ["sid", "options"],
  touch: ["sid", "lease"],
  ack: ["sid", "lease", "outcome"],
  release: ["sid", "lease"],
  get: ["id", "options"],
  list: ["options"],
  stats: [],
  audit: ["options"],
  pending: ["sid"],
  report: ["sid", "report"],
  snapshot: ["options"],
  attempt: ["sid", "lease"],
});
const opts = (v, keys) => v === undefined || (obj(v) && exact(v, keys));
const sidRequired = (args) => {
  if (!text(args.sid, 128)) input();
};
const leaseRequired = (args) => {
  if (!text(args.lease, 128)) input();
};
const registerArgs = (args) => {
  if (
    !tag(args.runtime) ||
    args.runtime === "prime" ||
    !opts(args.options, ["slot", "caps"]) ||
    (args.options?.slot !== undefined &&
      (typeof args.options.slot !== "string" || !/^\d{3,32}$/.test(args.options.slot))) ||
    (args.options?.caps !== undefined && !uniq(args.options.caps, tag))
  )
    input();
};
const enrollArgs = (args) => {
  if (
    !required(args.device, ["id", "name", "init"]) ||
    !opaque(args.device.id) ||
    !/^[A-Za-z0-9._-]{1,63}$/.test(args.device.name) ||
    !Number.isSafeInteger(args.device.init)
  )
    input();
};
const joinArgs = (args) => {
  if (
    !address(args.worker) ||
    !opts(args.options, ["replace"]) ||
    (args.options?.replace !== undefined && typeof args.options.replace !== "boolean")
  )
    input();
};
const sendArgs = (args) => {
  sidRequired(args);
  if (
    !address(args.to) ||
    !opts(args.options, ["key"]) ||
    (args.options?.key !== undefined && !keyValid(args.options.key))
  )
    input();
  validateEnvelope(args.envelope);
};
const postArgs = (args) => {
  sidRequired(args);
  if (
    !board(args.board) ||
    !opts(args.options, ["key", "needs", "series"]) ||
    (args.options?.key !== undefined && !keyValid(args.options.key)) ||
    (args.options?.needs !== undefined && !uniq(args.options.needs, tag)) ||
    (args.options?.series !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(args.options.series))
  )
    input();
  const kind = validateEnvelope(args.envelope);
  if (kind === "msg" && (args.options?.needs !== undefined || args.options?.series !== undefined))
    input("Inbox messages cannot use work options");
};
const claimArgs = (args) => {
  sidRequired(args);
  if (
    !opts(args.options, ["board", "kind"]) ||
    (args.options?.board !== undefined && !board(args.options.board)) ||
    (args.options?.kind !== undefined && !["msg", "work"].includes(args.options.kind))
  )
    input();
};
const leaseArgs = (args) => {
  sidRequired(args);
  leaseRequired(args);
};
const ackArgs = (args) => {
  sidRequired(args);
  if (!text(args.lease, 128) || !["done", "failed", "rejected"].includes(args.outcome)) input();
};
const getArgs = (args) => {
  if (
    !text(args.id, 128) ||
    !opts(args.options, ["data"]) ||
    (args.options?.data !== undefined && typeof args.options.data !== "boolean")
  )
    input();
};
const listOptionsValid = (o) =>
  opts(o, ["to", "board", "kind", "state", "after", "limit", "data"]) &&
  (o.to === undefined || address(o.to)) &&
  (o.board === undefined || board(o.board)) &&
  (o.to === undefined || o.board === undefined) &&
  (o.kind === undefined || ["msg", "work"].includes(o.kind)) &&
  (o.state === undefined ||
    ["pending", "claimed", "posted", "done", "failed", "rejected"].includes(o.state)) &&
  (o.after === undefined || cursorToken(o.after, "page")) &&
  (o.limit === undefined || (Number.isInteger(o.limit) && o.limit >= 1 && o.limit <= 200)) &&
  (o.data === undefined || typeof o.data === "boolean");
const listArgs = (args) => {
  if (!listOptionsValid(args.options ?? {})) input();
};
const auditArgs = (args) => {
  if (
    !opts(args.options, ["after", "limit"]) ||
    (args.options?.after !== undefined && !cursorToken(args.options.after, "page")) ||
    (args.options?.limit !== undefined &&
      (!Number.isInteger(args.options.limit) || args.options.limit < 1 || args.options.limit > 200))
  )
    input();
};
const snapshotArgs = (args) => {
  if (
    !opts(args.options, ["device", "limit", "after"]) ||
    (args.options?.device !== undefined && !opaque(args.options.device)) ||
    (args.options?.limit !== undefined &&
      (!Number.isInteger(args.options.limit) ||
        args.options.limit < 1 ||
        args.options.limit > 512)) ||
    (args.options?.after !== undefined && !cursorToken(args.options.after, "snapshot"))
  )
    input();
};
const reportArgs = (args) => {
  sidRequired(args);
  validateReport(args.report);
};
const statsArgs = (args) => {
  if (Object.keys(args).length !== 0) input();
};
const argumentChecks = Object.freeze({
  register: registerArgs,
  enroll: enrollArgs,
  join: joinArgs,
  resume: sidRequired,
  renew: sidRequired,
  leave: sidRequired,
  send: sendArgs,
  post: postArgs,
  claim: claimArgs,
  touch: leaseArgs,
  ack: ackArgs,
  release: leaseArgs,
  get: getArgs,
  list: listArgs,
  stats: statsArgs,
  audit: auditArgs,
  pending: sidRequired,
  report: reportArgs,
  snapshot: snapshotArgs,
  attempt: leaseArgs,
});
function checkArguments(operation, args) {
  const keys = opKeys[operation];
  if (
    !keys ||
    !obj(args) ||
    Object.keys(args).some((k) => !keys.includes(k)) ||
    keys.filter((k) => !["options"].includes(k)).some((k) => !Object.hasOwn(args, k))
  )
    input("Operation arguments are invalid");
  const check = Object.hasOwn(argumentChecks, operation) ? argumentChecks[operation] : undefined;
  if (check) check(args);
}
function allowed(list, value) {
  return list.includes(value);
}
const devPrincipal = (principal) =>
  principal?.id === "dev-relay" && principal.scopeKey === devScopeKey;
const authorizeRegister = (g, args) => {
  const reg = g.register[0];
  if (!reg?.runtimes.includes(args.runtime) || (args.options?.slot === undefined && !reg.allocate))
    denied();
};
const authorizeEnroll = (g, args) => {
  if (!g.enroll.some((d) => d.deviceId === args.device.id && d.deviceName === args.device.name))
    denied();
};
const authorizeJoin = (g, args) => {
  if (!allowed(g.workers, args.worker)) denied();
};
const authorizeSend = (g, args) => {
  if (!allowed(g.recipients, args.to)) denied();
};
const authorizePost = (g, args) => {
  if (!allowed(g.boardPost, args.board)) denied();
};
const authorizeClaim = (g, args) => {
  if (!allowed(g.boardClaim, args.options.board) || args.options.kind === "msg") denied();
};
const authorizeRead = (g, context, args) => {
  const o = args.options ?? {};
  if (o.board !== undefined) {
    authorizeBoardRead(
      context.snapshot,
      context.principal,
      o.board,
      o.kind ?? "work",
      o.data === true,
    );
    return;
  }
  if (
    context.operation === "list" &&
    o.to !== undefined &&
    !g.inspect.messages &&
    !allowed(g.workers, o.to) &&
    !allowed(g.recipients, o.to)
  )
    denied();
  if (context.operation === "get" && o.data === true && !g.inspect.messages) denied();
};
const operationAuthorizations = Object.freeze({
  register: (g, args) => authorizeRegister(g, args),
  enroll: (g, args) => authorizeEnroll(g, args),
  join: (g, args) => authorizeJoin(g, args),
  send: (g, args) => authorizeSend(g, args),
  post: (g, args) => authorizePost(g, args),
  claim: (g, args) => {
    if (args.options?.board !== undefined) authorizeClaim(g, args);
  },
  audit: (g) => {
    if (!g.inspect.audit) denied();
  },
  snapshot: (g) => {
    if (!g.inspect.topology) denied();
  },
  stats: (g) => {
    if (!g.inspect.messages) denied();
  },
  report: (g) => {
    if (!g.reportDevice) denied();
  },
  get: (g, args, context) => authorizeRead(g, context, args),
  list: (g, args, context) => authorizeRead(g, context, args),
});
export function authorize(snapshot, principal, operation, args) {
  checkArguments(operation, args);
  const current = devPrincipal(principal)
    ? { principal: "dev-relay", grant: devGrant, scopeKey: devScopeKey }
    : snapshot?.credentials?.find((item) => item.principal === principal?.id);
  if (!current || current.scopeKey !== principal.scopeKey)
    throw new Fault("auth", "Authentication required");
  const check = Object.hasOwn(operationAuthorizations, operation)
    ? operationAuthorizations[operation]
    : undefined;
  if (check) check(current.grant, args, { snapshot, principal, operation });
  return Object.freeze({
    principal: Object.freeze({
      id: current.principal,
      grant: current.grant,
      scopeKey: current.scopeKey,
    }),
    operation,
    scopeKey: current.scopeKey,
  });
}

export function authorizeBoardRead(snapshot, principal, boardId, kind, _includeData) {
  const dev = principal?.id === "dev-relay" && principal.scopeKey === devScopeKey;
  const current = dev
    ? { principal: "dev-relay", grant: devGrant, scopeKey: devScopeKey }
    : snapshot?.credentials?.find(
        (item) => item.principal === principal?.id && item.scopeKey === principal?.scopeKey,
      );
  if (!current || !board(boardId) || !["msg", "work"].includes(kind)) denied();
  const g = current.grant;
  const base = kind === "msg" ? g.inboxRead : g.workRead;
  if (!dev && !base.includes(boardId)) denied();
  return Object.freeze({
    principal: Object.freeze({
      id: current.principal,
      grant: current.grant,
      scopeKey: current.scopeKey,
    }),
    operation: "list",
    scopeKey: current.scopeKey,
  });
}
