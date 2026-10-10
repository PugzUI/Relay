import http from "node:http";
import https from "node:https";
import { open as openFile, lstat, readFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Fault } from "./fault.mjs";
import { openForBroker, dispatchRpc } from "./relay.mjs";
import { createFeed } from "./feed.mjs";
import { createPool } from "./pool.mjs";
import { connect, createFixedClient, invokeClient } from "./client.mjs";
import { readConfig, parseJsonStrict } from "./config.mjs";
import { authenticate, authorize, authorizeBoardRead, loadRegistry, loadRegistrySync } from "./auth.mjs";

const MAX_HEADERS = 8192;
const MAX_BODY = 131072;
const MAX_RESPONSE = 1048576;
const REQUEST_MS = 10000;
const RID = /^[A-Za-z0-9._:-]{1,128}$/;
const OPS = new Set(["register", "enroll", "join", "resume", "renew", "leave", "send", "post", "claim", "touch", "ack", "release", "get", "list", "stats", "audit", "report", "snapshot", "attempt"]);
const PUBLIC_ASSETS = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/main.mjs", "main.mjs"], ["/state.mjs", "state.mjs"], ["/style.css", "style.css"]]);
const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");
const fail = (code, message) => { throw new Fault(code, message); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const asJSON = (res, status, value, headers = {}) => {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_RESPONSE) throw new Fault("full", "Response exceeds the configured limit");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
};
const responseFault = (error) => {
  const known = error instanceof Fault ? error : new Fault("unavailable", "Request could not be completed");
  const context = known.context && Object.fromEntries(Object.entries(known.context).filter(([k]) => ["id", "mid", "sid", "lease", "retryAfterMs"].includes(k)));
  return { code: known.code, message: known.message.slice(0, 256), ...(context && Object.keys(context).length ? { context } : {}) };
};
const healthyModePeer = (mode, allowed, address) => {
  if (mode !== "lan") return true;
  let peer = address?.startsWith("::ffff:") ? address.slice(7) : address;
  return allowed.includes(peer);
};
const randomRid = () => randomBytes(18).toString("base64url");

async function processStart(pid) {
  if (process.platform !== "linux") return null;
  try {
    let stat;
    try { stat = await readFile(`/proc/${pid}/stat`, "utf8"); }
    catch (error) { return error.code === "ENOENT" ? false : null; }
    const boot = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    if (close < 0 || fields.length < 20 || !/^\d+$/.test(fields[19])) return null;
    return `${boot.trim()}:${fields[19]}`;
  } catch { return null; }
}

async function acquireLock(root) {
  const path = join(root, "broker.lock");
  const nonce = randomBytes(24).toString("base64url");
  const ownStart = await processStart(process.pid);
  if (!ownStart) throw new Fault("unavailable", "Process identity cannot be verified on this platform");
  const record = { v: 1, pid: process.pid, processStart: ownStart, nonce };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await openFile(path, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
      return { path, nonce };
    } catch (error) {
      if (error.code !== "EEXIST") throw new Fault("storage", "Broker lock cannot be acquired");
    }
    let stat; let bytes; let old;
    try {
      stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe");
      bytes = await readFile(path, "utf8"); old = parseJsonStrict(bytes, 1024);
      if (!object(old) || Object.keys(old).sort().join(",") !== "nonce,pid,processStart,v" || old.v !== 1 || !Number.isSafeInteger(old.pid) || old.pid <= 0 || typeof old.nonce !== "string" || typeof old.processStart !== "string") throw new Error("invalid");
    } catch { throw new Fault("active", "Broker lock is invalid or cannot be verified"); }
    const observed = await processStart(old.pid);
    if (observed === old.processStart) throw new Fault("active", "Another broker owns this store");
    if (observed !== false) throw new Fault("active", "Broker lock owner is ambiguous");
    let nowStat;
    try { nowStat = await lstat(path); } catch { continue; }
    if (nowStat.dev !== stat.dev || nowStat.ino !== stat.ino) continue;
    try { await unlink(path); } catch { throw new Fault("active", "Stale broker lock cannot be removed safely"); }
  }
  throw new Fault("active", "Broker lock changed during acquisition");
}

async function readRequest(req, limit, deadline) {
  const type = req.headers["content-type"];
  if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type) || req.headers["content-encoding"] !== undefined) fail("protocol", "Request encoding is unsupported");
  if (req.headers["transfer-encoding"] && req.headers["content-length"] !== undefined) fail("protocol", "Ambiguous request framing");
  if (req.headers["content-length"] !== undefined) {
    if (!/^\d+$/.test(req.headers["content-length"]) || Number(req.headers["content-length"]) > limit) fail("protocol", "Request body is too large");
  }
  const parts = []; let bytes = 0;
  for await (const part of req) {
    if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
    bytes += part.length;
    if (bytes > limit) fail("protocol", "Request body is too large");
    parts.push(part);
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)); } catch { fail("protocol", "Request is not valid UTF-8"); }
  return parseJsonStrict(text, limit);
}

async function readTlsFile(path, label, privateMode) {
  let file;
  try { file = await openFile(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch { throw new Fault("unavailable", `${label} is unavailable or unsafe`); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1_048_576 || process.platform !== "win32" && (stat.uid !== process.getuid() || privateMode && (stat.mode & 0o077) !== 0)) throw new Fault("unavailable", `${label} is unavailable or unsafe`);
    return await file.readFile();
  } finally { await file.close(); }
}

function query(url, allowed) {
  const out = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(out, key)) fail("input", "Query fields are invalid");
    out[key] = value;
  }
  return out;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function validCursor(value, kind, maxBytes) {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length > maxBytes || decoded.toString("base64url") !== value) return false;
    const json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    const token = parseJsonStrict(json, maxBytes);
    if (!object(token) || canonicalJson(token) !== json || token.v !== 1 || typeof token.authority !== "string" || typeof token.scope !== "string" || !/^[a-f0-9]{64}$/.test(token.scope)) return false;
    if (kind === "feed") return Object.keys(token).sort().join(",") === "authority,scope,seq,stream,v" && typeof token.stream === "string" && Number.isSafeInteger(token.seq) && token.seq >= 0;
    if (kind === "snapshot") return Object.keys(token).sort().join(",") === "authority,boundary,filter,last,scope,time,v" && /^[a-f0-9]{64}$/.test(token.filter) && Number.isSafeInteger(token.boundary) && token.boundary >= 0 && Number.isSafeInteger(token.time) && token.time >= 0 && object(token.last) && Object.keys(token.last).sort().join(",") === "agent,link" && (token.last.agent === null || typeof token.last.agent === "string") && (token.last.link === null || typeof token.last.link === "string");
    return Object.keys(token).sort().join(",") === "authority,boundary,filter,last,scope,v" && /^[a-f0-9]{64}$/.test(token.filter) && Number.isSafeInteger(token.boundary) && token.boundary >= 0 && Number.isSafeInteger(token.last) && token.last >= 0;
  } catch { return false; }
}
function pageArgs(values) {
  if (!values.board || !["bounty"].includes(values.board) && !/^host:[A-Za-z0-9._-]{1,128}$/.test(values.board) || !["msg", "work"].includes(values.kind)) fail("input", "Board query is invalid");
  const options = { board: values.board, kind: values.kind };
  if (values.after !== undefined) { if (!validCursor(values.after, "page", 1024)) fail("input", "Board cursor is invalid"); options.after = values.after; }
  if (values.limit !== undefined) { if (!/^[1-9]\d*$/.test(values.limit) || Number(values.limit) > 200) fail("input", "Page limit is invalid"); options.limit = Number(values.limit); }
  if (values.data !== undefined) { if (values.data !== "0" && values.data !== "1") fail("input", "Body selector is invalid"); options.data = values.data === "1"; }
  return options;
}

function uniqueAuthorization(req) {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "authorization") values.push(req.rawHeaders[i + 1]);
  return values.length === 1 ? values[0] : values;
}

function validateCall(body) {
  if (!object(body) || Object.keys(body).sort().join(",") !== "args,op,rid,v" || body.v !== 1 || !RID.test(body.rid) || !OPS.has(body.op) || !object(body.args)) fail("protocol", "RPC envelope is invalid");
  return body;
}

export class Broker {
  constructor() { throw new TypeError("Use serve()"); }
  get address() { return brokers.get(this)?.address ?? null; }
  async close() { return closeBroker(this); }
}
const brokers = new WeakMap();

async function closeBroker(broker) {
  const state = brokers.get(broker); if (!state || state.closed) return;
  state.closed = true;
  for (const controller of state.streams) controller.abort();
  state.server.close();
  const stopAt = performance.now() + 10000;
  while (state.inflight && performance.now() < stopAt) await new Promise((resolve) => setTimeout(resolve, 10));
  if (state.inflight) state.server.closeAllConnections();
  await Promise.allSettled([state.pool?.close(), state.feed?.close()]);
  if (state.hub) await state.hub.close().catch(() => {});
  await new Promise((resolve) => state.server.close(resolve));
  state.relay.close();
  try {
    const raw = await readFile(state.lock.path, "utf8"); const record = parseJsonStrict(raw, 1024);
    if (record?.nonce === state.lock.nonce) await unlink(state.lock.path);
  } catch { /* Preserve the primary shutdown result; an unmatched lock is operator-owned. */ }
}

export async function serve(options) {
  if (!object(options) || Object.keys(options).sort().join(",") !== "configFile,root" || typeof options.root !== "string" || typeof options.configFile !== "string") fail("input", "Broker options are invalid");
  const config = await readConfig(options.configFile);
  const root = resolve(options.root);
  let registry = await loadRegistry(config.credentialsFile);
  let relay; let lock;
  let hub = null; let pool = null; let feed = null; let server;
  try {
    lock = await acquireLock(root);
    relay = openForBroker({ root, role: config.role });
    if (config.hub) hub = await connect({ url: config.hub.url, tokenFile: config.hub.tokenFile, ...(config.hub.caFile ? { caFile: config.hub.caFile } : {}), mode: "tailscale" });
    if (hub && hub.authority === relay.authority) throw new Fault("input", "Hub and host authorities must be distinct");
    feed = createFeed(relay);
    if (config.pool) pool = createPool({ local: relay, hub, ...config.pool });
    server = config.tls ? https.createServer({ cert: await readTlsFile(config.tls.certFile, "TLS certificate", false), key: await readTlsFile(config.tls.keyFile, "TLS private key", true), maxHeaderSize: MAX_HEADERS, minVersion: "TLSv1.2" }) : http.createServer({ maxHeaderSize: MAX_HEADERS, joinDuplicateHeaders: false });
  } catch (error) {
    await Promise.allSettled([pool?.close(), feed?.close(), hub?.close()]); relay?.close();
    if (lock) { try { const r = parseJsonStrict(await readFile(lock.path, "utf8"), 1024); if (r?.nonce === lock.nonce) await unlink(lock.path); } catch {} }
    throw error;
  }
  const state = { config, root, relay, lock, hub, pool, feed, server, address: null, closed: false, inflight: 0, activeRequests: 0, bodyReads: 0, active: new Map(), rates: new Map(), streams: new Set(), registry };
  const broker = Object.create(Broker.prototype); brokers.set(broker, state);
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 40;
  server.headersTimeout = 5000;
  server.requestTimeout = REQUEST_MS;
  server.keepAliveTimeout = 5000;
  server.on("request", (req, res) => {
    state.inflight++;
    const deadline = performance.now() + REQUEST_MS;
    const timeout = setTimeout(() => { if (!res.writableEnded) { res.destroy(); } }, REQUEST_MS);
    void handle(state, req, res, deadline, () => clearTimeout(timeout)).catch((error) => {
      if (res.headersSent || res.destroyed) return;
      const known = error instanceof Fault ? error : new Fault("unavailable", "Request could not be completed");
      const status = known.code === "auth" ? 401 : known.code === "denied" ? 403 : known.code === "input" || known.code === "protocol" ? 400 : known.code === "rate" || known.code === "full" ? 429 : known.code === "timeout" ? 504 : 503;
      try { asJSON(res, status, { v: 1, rid: req.relayRid ?? null, ok: false, fault: responseFault(known), time: Date.now() }); } catch { res.destroy(); }
    }).finally(() => { clearTimeout(timeout); state.inflight--; });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => { server.removeListener("error", reject); resolve(); });
  }).catch(async (error) => { await closeBroker(broker); throw new Fault("active", "Broker listener could not be started", { cause: error?.code }); });
  const addr = server.address();
  if (!addr || typeof addr === "string") { await closeBroker(broker); throw new Fault("unavailable", "Broker address is unavailable"); }
  state.address = Object.freeze({ address: addr.address, family: addr.family, port: addr.port });
  return broker;
}

async function freshAuth(state, req) {
  state.registry = await loadRegistry(state.config.credentialsFile);
  const principal = authenticate(state.registry, uniqueAuthorization(req));
  return principal;
}
function rateLimit(state, principal) {
  const now = performance.now(); let row = state.rates.get(principal.id);
  if (!row) {
    if (state.rates.size >= 256) {
      for (const [id, entry] of state.rates) if (now - entry.last > 120000) state.rates.delete(id);
      if (state.rates.size >= 256) throw new Fault("rate", "Request rate limit exceeded");
    }
    row = { times: [], last: now }; state.rates.set(principal.id, row);
  }
  row.last = now; row.times = row.times.filter((time) => now - time < 60000);
  if (row.times.length >= 60 || row.times.length >= 10 && now - row.times[row.times.length - 10] < 1000) throw new Fault("rate", "Request rate limit exceeded");
  row.times.push(now);
}
function admission(state, principal) {
  const active = state.active.get(principal.id) ?? 0;
  if (state.activeRequests + state.bodyReads >= 32 || active >= 8) throw new Fault("full", "Broker request capacity is full");
  state.activeRequests++;
  state.active.set(principal.id, active + 1);
  let released = false;
  return () => { if (released) return; released = true; state.activeRequests--; const count = (state.active.get(principal.id) ?? 1) - 1; if (count) state.active.set(principal.id, count); else state.active.delete(principal.id); };
}

async function boardRequest(state, req, res, url, principal, deadline) {
  const values = query(url, ["board", "kind", "after", "limit", "data"]);
  const options = pageArgs(values); const includeData = options.data === true;
  const snapshot = await loadRegistry(state.config.credentialsFile); state.registry = snapshot;
  authorizeBoardRead(snapshot, principal, options.board, options.kind, includeData);
  const binding = state.config.views.find((view) => view.boards.includes(options.board));
  if (options.board.startsWith("host:") && binding && binding.deviceId !== options.board.slice(5)) fail("denied", "Board is outside the fixed view binding");
  if (options.board.startsWith("host:") && options.board !== `host:${state.relay.device.id}`) {
    if (!binding) fail("unavailable", "Board view is unavailable");
    const cancelled = new AbortController();
    const cancel = () => cancelled.abort();
    res.once("close", cancel);
    if (req.socket.destroyed) cancelled.abort();
    const remote = await createFixedClient({ url: binding.url, tokenFile: binding.tokenFile, ...(binding.caFile ? { caFile: binding.caFile } : {}), mode: "tailscale" }, cancelled.signal);
    try {
      if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
      const result = await invokeClient(remote, { rid: randomRid(), op: "list", args: { options }, deadline });
      const page = result.result;
      if (!validPage(page, options.board, options.kind) || Buffer.byteLength(JSON.stringify(page)) > MAX_RESPONSE) fail("protocol", "Remote board response is invalid");
      const current = await loadRegistry(state.config.credentialsFile); state.registry = current;
      authorizeBoardRead(current, principal, options.board, options.kind, includeData);
      if (cancelled.signal.aborted) fail("unavailable", "Board request was cancelled");
      asJSON(res, 200, page);
    } finally { res.removeListener("close", cancel); cancelled.abort(); await remote.close(); }
    return;
  }
  const args = { options };
  const auth = authorize(state.registry, principal, "list", args);
  const outcome = await dispatchRpc(state.relay, { authorization: auth, rid: randomRid(), op: "list", args, beforeCommit: () => {
    if (performance.now() >= deadline) throw new Fault("timeout", "Request deadline elapsed");
    const currentRegistry = loadRegistrySync(state.config.credentialsFile);
    const current = authenticate(currentRegistry, uniqueAuthorization(req));
    if (current.id !== principal.id || current.scopeKey !== auth.scopeKey) throw new Fault("auth", "Credential was revoked");
    authorize(currentRegistry, current, "list", args);
  } });
  asJSON(res, 200, outcome.result);
}
function validPage(page, board, kind) {
  return object(page) && Array.isArray(page.items) && Number.isSafeInteger(page.total) && Number.isSafeInteger(page.visible) && typeof page.complete === "boolean" && typeof page.cursor === "string" && (page.next === null || typeof page.next === "string") && page.items.every((item) => object(item) && item.board === board && item.kind === kind);
}
async function events(state, req, res, url, principal, deadline) {
  const values = query(url, ["cursor"]);
  if (!validCursor(values.cursor, "feed", 512)) fail("input", "Event cursor is invalid");
  if (state.streams.size >= 8) fail("full", "Event stream capacity is full");
  if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
  const current = await loadRegistry(state.config.credentialsFile); state.registry = current;
  const authorization = authorize(current, principal, "snapshot", { options: {} });
  if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
  const controller = new AbortController(); state.streams.add(controller);
  res.once("close", () => controller.abort());
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  try {
    const iterable = state.feed.subscribe({ cursor: values.cursor, authorization, signal: controller.signal });
    for await (const frame of iterable) {
      if (controller.signal.aborted || state.closed) break;
      const updated = await loadRegistry(state.config.credentialsFile); state.registry = updated;
      const checked = authorize(updated, principal, "snapshot", { options: {} });
      if (checked.scopeKey !== authorization.scopeKey) {
        res.write(`event: reset\ndata: ${JSON.stringify({ event: "reset", reason: "scope" })}\n\n`); break;
      }
      const chunk = Buffer.from(`event: ${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`);
      if (chunk.length > 16384 || !res.write(chunk)) {
        await new Promise((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); res.removeListener("drain", drained); controller.signal.removeEventListener("abort", aborted); };
          const drained = () => { cleanup(); resolve(); };
          const aborted = () => { cleanup(); reject(new Fault("unavailable", "Event stream closed")); };
          const timer = setTimeout(() => { cleanup(); controller.abort(); reject(new Fault("timeout", "Event reader is too slow")); }, 1000);
          res.once("drain", drained);
          controller.signal.addEventListener("abort", aborted, { once: true });
        });
      }
    }
  } finally { state.streams.delete(controller); if (!res.writableEnded) res.end(); }
}

async function staticAsset(req, res, url) {
  if (req.method !== "GET" || url.search) fail("protocol", "Static route is invalid");
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { fail("input", "Static asset path is invalid"); }
  let relative = PUBLIC_ASSETS.get(pathname);
  if (relative === undefined && pathname.startsWith("/assets/")) {
    const name = pathname.slice("/assets/".length);
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,200}$/.test(name) || name.split("/").some((part) => !part || part === "." || part === "..")) fail("input", "Static asset path is invalid");
    relative = join("assets", name);
  }
  if (relative === undefined) return false;
  const path = resolve(UI_ROOT, relative);
  if (!path.startsWith(`${UI_ROOT}/`) && path !== UI_ROOT) fail("input", "Static asset path is invalid");
  let file;
  try { file = await openFile(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); } catch { return false; }
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > MAX_RESPONSE) { await file.close(); return false; }
  const types = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };
  const type = types[extname(path).toLowerCase()];
  if (!type) { await file.close(); return false; }
  res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache", "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  await new Promise((resolvePromise, reject) => file.createReadStream({ autoClose: true }).on("error", reject).on("end", resolvePromise).pipe(res));
  return true;
}

async function callRoute(state, req, res, deadline, body, principal) {
  const snapshot = await loadRegistry(state.config.credentialsFile); state.registry = snapshot;
  const authorization = authorize(snapshot, principal, body.op, body.args);
  if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
  const outcome = await dispatchRpc(state.relay, { authorization, rid: body.rid, op: body.op, args: body.args, beforeCommit: () => {
    if (performance.now() >= deadline) throw new Fault("timeout", "Request deadline elapsed");
    const fresh = loadRegistrySync(state.config.credentialsFile);
    const current = authenticate(fresh, uniqueAuthorization(req));
    if (current.id !== principal.id || current.scopeKey !== authorization.scopeKey) throw new Fault("auth", "Credential was revoked");
    authorize(fresh, current, body.op, body.args);
  } });
  asJSON(res, 200, { v: 1, rid: body.rid, ok: true, result: outcome.result, time: outcome.committedAt ?? Date.now(), replayed: outcome.replayed, remainingMs: outcome.remainingMs });
}

async function handle(state, req, res, deadline, onStreamStart) {
  if (state.closed) fail("unavailable", "Broker is closing");
  if (!healthyModePeer(state.config.mode, state.config.allowedPeers, req.socket.remoteAddress)) fail("denied");
  const seen = new Set();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (["host", "content-type", "content-length", "transfer-encoding", "content-encoding"].includes(name) && seen.has(name)) fail("protocol", "Duplicate request header");
    seen.add(name);
  }
  if (typeof req.url !== "string" || !req.url.startsWith("/") || req.url.startsWith("//")) fail("protocol", "Request target is invalid");
  const url = new URL(req.url, "http://relay.invalid");
  if (url.hash || req.url.includes("#")) fail("protocol", "Request fragments are not accepted");
  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.endsWith(".mjs") || url.pathname.endsWith(".css") || url.pathname.startsWith("/assets/")) {
    if (await staticAsset(req, res, url)) return;
    res.writeHead(404, { "Content-Length": 0, "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" }); res.end(); return;
  }
  if (req.method === "GET" && url.pathname === "/v1/health") {
    if (url.search || req.headers["transfer-encoding"] !== undefined || req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") fail("protocol", "Health route does not accept a body or query");
    const principal = await freshAuth(state, req); rateLimit(state, principal); const release = admission(state, principal);
    try { asJSON(res, 200, { v: 1, authority: state.relay.authority, time: Date.now() }); } finally { release(); }
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/call") {
    if (url.search) fail("protocol", "RPC route does not accept query fields");
    if (state.activeRequests + state.bodyReads >= 32) fail("full", "Broker request capacity is full");
    state.bodyReads++;
    let raw;
    try { raw = await readRequest(req, MAX_BODY, deadline); } finally { state.bodyReads--; }
    if (object(raw) && RID.test(raw.rid ?? "")) req.relayRid = raw.rid;
    const body = validateCall(raw); req.relayRid = body.rid;
    const principal = await freshAuth(state, req); rateLimit(state, principal); const release = admission(state, principal);
    try { await callRoute(state, req, res, deadline, body, principal); } finally { release(); }
    return;
  }
  const principal = await freshAuth(state, req); rateLimit(state, principal);
  const release = admission(state, principal);
  try {
    if (req.method === "POST" && url.pathname === "/v1/call") fail("protocol", "Route is not available");
    if (req.method === "GET" && url.pathname === "/v1/topology") {
      const values = query(url, ["device", "limit", "after"]); const options = {};
      if (values.device !== undefined) options.device = values.device;
      if (values.limit !== undefined) { if (!/^[1-9]\d*$/.test(values.limit) || Number(values.limit) > 512) fail("input", "Snapshot limit is invalid"); options.limit = Number(values.limit); }
      if (values.after !== undefined) options.after = values.after;
      const snapshot = await loadRegistry(state.config.credentialsFile); state.registry = snapshot;
      const authorization = authorize(snapshot, principal, "snapshot", { options });
      const result = await state.feed.snapshot(options, authorization);
      const latest = loadRegistrySync(state.config.credentialsFile); state.registry = latest;
      const current = authenticate(latest, uniqueAuthorization(req));
      if (current.id !== principal.id) fail("auth", "Credential was revoked");
      authorize(latest, current, "snapshot", { options });
      asJSON(res, 200, result); return;
    }
    if (req.method === "GET" && url.pathname === "/v1/board") { await boardRequest(state, req, res, url, principal, deadline); return; }
    if (req.method === "GET" && url.pathname === "/v1/events") { release(); onStreamStart?.(); await events(state, req, res, url, principal, deadline); return; }
    fail("protocol", "Route is not available");
  } finally { release(); }
}
