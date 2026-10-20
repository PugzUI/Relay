import http from "node:http";
import https from "node:https";
import { open as openFile, lstat, readFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Fault } from "./fault.mjs";
import {
  claimDeliveryOwner,
  openForBroker,
  dispatchRpc,
  reconcileDeliveryAttempt,
  releaseDeliveryOwner,
} from "./relay.mjs";
import { createFeed } from "./feed.mjs";
import { createDeliverySupervisor } from "./delivery.mjs";
import { createPool } from "./pool.mjs";
import { migrateDatabase } from "./sqlite.mjs";
import { connect, createFixedClient, invokeClient } from "./client.mjs";
import { readConfig, parseJsonStrict } from "./config.mjs";
import {
  authenticate,
  authorize,
  authorizeBoardRead,
  loadRegistry,
  loadRegistrySync,
} from "./auth.mjs";
import { readLinuxProcessStart } from "./process-identity.mjs";

const MAX_HEADERS = 8192;
const MAX_BODY = 131072;
const MAX_RESPONSE = 1048576;
const REQUEST_MS = 10000;
const RID = /^[A-Za-z0-9._:-]{1,128}$/;
const OPS = new Set([
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
const PUBLIC_ASSETS = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/main.mjs", "main.mjs"],
  ["/state.mjs", "state.mjs"],
  ["/filter.mjs", "filter.mjs"],
  ["/style.css", "style.css"],
]);
const ASSET_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};
const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");
const fail = (code, message) => {
  throw new Fault(code, message);
};
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const asJSON = (res, status, value, headers = {}) => {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_RESPONSE) throw new Fault("full", "Response exceeds the configured limit");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
};
const responseFault = (error) => {
  const known =
    error instanceof Fault ? error : new Fault("unavailable", "Request could not be completed");
  const context =
    known.context &&
    Object.fromEntries(
      Object.entries(known.context).filter(([k]) =>
        ["id", "mid", "sid", "lease", "retryAfterMs"].includes(k),
      ),
    );
  return {
    code: known.code,
    message: known.message.slice(0, 256),
    ...(context && Object.keys(context).length ? { context } : {}),
  };
};
export const healthyModePeer = (mode, allowed, address, localAddress) => {
  if (mode !== "lan" && mode !== "tailnet") return true;
  const peer = address?.startsWith("::ffff:") ? address.slice(7) : address;
  if (mode === "lan") return allowed.includes(peer);
  if (peer === "127.0.0.1") return localAddress === "127.0.0.1";
  const parts = typeof peer === "string" ? peer.split(".").map(Number) : [];
  const localParts = typeof localAddress === "string" ? localAddress.split(".").map(Number) : [];
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 100 &&
    parts[1] >= 64 &&
    parts[1] <= 127 &&
    localParts.length === 4 &&
    localParts[0] === 100 &&
    localParts[1] >= 64 &&
    localParts[1] <= 127
  );
};
const randomRid = () => randomBytes(18).toString("base64url");

function validLockRecord(record) {
  return (
    object(record) &&
    Object.keys(record).sort().join(",") === "nonce,pid,processStart,v" &&
    record.v === 1 &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.nonce === "string" &&
    typeof record.processStart === "string"
  );
}

async function readLockRecord(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe");
    const bytes = await readFile(path, "utf8");
    const record = parseJsonStrict(bytes, 1024);
    if (!validLockRecord(record)) throw new Error("invalid");
    return { stat, record };
  } catch {
    throw new Fault("active", "Broker lock is invalid or cannot be verified");
  }
}

async function createLockFile(path, record) {
  let file;
  try {
    file = await openFile(path, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw new Fault("storage", "Broker lock cannot be acquired");
    return false;
  }
  try {
    await file.writeFile(JSON.stringify(record));
    await file.sync();
  } finally {
    await file.close();
  }
  return true;
}

async function reclaimStaleLock(path) {
  const { stat, record } = await readLockRecord(path);
  const observed = await readLinuxProcessStart(record.pid);
  if (observed === record.processStart) throw new Fault("active", "Another broker owns this store");
  if (observed !== false) throw new Fault("active", "Broker lock owner is ambiguous");
  let nowStat;
  try {
    nowStat = await lstat(path);
  } catch {
    return false;
  }
  if (nowStat.dev !== stat.dev || nowStat.ino !== stat.ino) return false;
  try {
    await unlink(path);
  } catch {
    throw new Fault("active", "Stale broker lock cannot be removed safely");
  }
  return true;
}

async function acquireLock(root) {
  const path = join(root, "broker.lock");
  const nonce = randomBytes(24).toString("base64url");
  const ownStart = await readLinuxProcessStart(process.pid);
  if (!ownStart)
    throw new Fault("unavailable", "Process identity cannot be verified on this platform");
  const record = { v: 1, pid: process.pid, processStart: ownStart, nonce };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await createLockFile(path, record)) return { path, nonce };
    await reclaimStaleLock(path);
  }
  throw new Fault("active", "Broker lock changed during acquisition");
}

async function releaseLock(lock) {
  const raw = await readFile(lock.path, "utf8");
  const record = parseJsonStrict(raw, 1024);
  if (record?.nonce !== lock.nonce)
    throw new Fault("active", "Broker lock ownership changed during release");
  await unlink(lock.path);
}

function requestContentTypeAllowed(req) {
  const type = req.headers["content-type"];
  return typeof type === "string" && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type);
}

function assertRequestFraming(req, limit) {
  if (!requestContentTypeAllowed(req) || req.headers["content-encoding"] !== undefined)
    fail("protocol", "Request encoding is unsupported");
  if (req.headers["transfer-encoding"] && req.headers["content-length"] !== undefined)
    fail("protocol", "Ambiguous request framing");
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit))
    fail("protocol", "Request body is too large");
}

async function readRequest(req, limit, deadline) {
  assertRequestFraming(req, limit);
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
    bytes += part.length;
    if (bytes > limit) fail("protocol", "Request body is too large");
    parts.push(part);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
  } catch {
    fail("protocol", "Request is not valid UTF-8");
  }
  return parseJsonStrict(text, limit);
}

async function readTlsFile(path, label, privateMode) {
  let file;
  try {
    file = await openFile(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
  } catch {
    throw new Fault("unavailable", `${label} is unavailable or unsafe`);
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 1_048_576 ||
      (process.platform !== "win32" &&
        (stat.uid !== process.getuid() || (privateMode && (stat.mode & 0o077) !== 0)))
    )
      throw new Fault("unavailable", `${label} is unavailable or unsafe`);
    return await file.readFile();
  } finally {
    await file.close();
  }
}

function query(url, allowed) {
  const out = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(out, key))
      fail("input", "Query fields are invalid");
    out[key] = value;
  }
  return out;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function decodeCursorToken(value, maxBytes) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((maxBytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length > maxBytes || decoded.toString("base64url") !== value) return null;
    const json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    const token = parseJsonStrict(json, maxBytes);
    return { token, json };
  } catch {
    return null;
  }
}

function validCursorEnvelope(token, json) {
  return (
    object(token) &&
    canonicalJson(token) === json &&
    token.v === 1 &&
    typeof token.authority === "string" &&
    typeof token.scope === "string" &&
    /^[a-f0-9]{64}$/.test(token.scope)
  );
}

function validFeedCursor(token) {
  return (
    Object.keys(token).sort().join(",") === "authority,scope,seq,stream,v" &&
    typeof token.stream === "string" &&
    Number.isSafeInteger(token.seq) &&
    token.seq >= 0
  );
}

function validSnapshotCursor(token) {
  return (
    Object.keys(token).sort().join(",") === "authority,boundary,filter,last,scope,time,v" &&
    /^[a-f0-9]{64}$/.test(token.filter) &&
    Number.isSafeInteger(token.boundary) &&
    token.boundary >= 0 &&
    Number.isSafeInteger(token.time) &&
    token.time >= 0 &&
    object(token.last) &&
    Object.keys(token.last).sort().join(",") === "agent,link" &&
    (token.last.agent === null || typeof token.last.agent === "string") &&
    (token.last.link === null || typeof token.last.link === "string")
  );
}

function validPageCursor(token) {
  return (
    Object.keys(token).sort().join(",") === "authority,boundary,filter,last,scope,v" &&
    /^[a-f0-9]{64}$/.test(token.filter) &&
    Number.isSafeInteger(token.boundary) &&
    token.boundary >= 0 &&
    Number.isSafeInteger(token.last) &&
    token.last >= 0
  );
}

function validCursor(value, kind, maxBytes) {
  const decoded = decodeCursorToken(value, maxBytes);
  if (!decoded) return false;
  if (!validCursorEnvelope(decoded.token, decoded.json)) return false;
  if (kind === "feed") return validFeedCursor(decoded.token);
  if (kind === "snapshot") return validSnapshotCursor(decoded.token);
  return validPageCursor(decoded.token);
}

function validBoardName(board) {
  return ["bounty"].includes(board) || /^host:[A-Za-z0-9._-]{1,128}$/.test(board);
}

function pageCursorOption(values) {
  if (values.after === undefined) return undefined;
  if (!validCursor(values.after, "page", 1024)) fail("input", "Board cursor is invalid");
  return values.after;
}

function pageLimitOption(values) {
  if (values.limit === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(values.limit) || Number(values.limit) > 200)
    fail("input", "Page limit is invalid");
  return Number(values.limit);
}

function pageDataOption(values) {
  if (values.data === undefined) return undefined;
  if (values.data !== "0" && values.data !== "1") fail("input", "Body selector is invalid");
  return values.data === "1";
}

function pageArgs(values) {
  if (!values.board || !validBoardName(values.board) || !["msg", "work"].includes(values.kind))
    fail("input", "Board query is invalid");
  const options = { board: values.board, kind: values.kind };
  const after = pageCursorOption(values);
  if (after !== undefined) options.after = after;
  const limit = pageLimitOption(values);
  if (limit !== undefined) options.limit = limit;
  const data = pageDataOption(values);
  if (data !== undefined) options.data = data;
  return options;
}

function uniqueAuthorization(req) {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i].toLowerCase() === "authorization") values.push(req.rawHeaders[i + 1]);
  return values.length === 1 ? values[0] : values;
}

function validateCall(body) {
  if (
    !object(body) ||
    Object.keys(body).sort().join(",") !== "args,op,rid,v" ||
    body.v !== 1 ||
    !RID.test(body.rid) ||
    !OPS.has(body.op) ||
    !object(body.args)
  )
    fail("protocol", "RPC envelope is invalid");
  return body;
}

export class Broker {
  constructor() {
    throw new TypeError("Use serve()");
  }
  get address() {
    return brokers.get(this)?.address ?? null;
  }
  async close() {
    await closeBroker(this);
  }
}
const brokers = new WeakMap();

async function closeBroker(broker) {
  const state = brokers.get(broker);
  if (!state || state.closed) return;
  const failures = [];
  state.closed = true;
  for (const controller of state.streams) controller.abort();
  state.server.close();
  const stopAt = performance.now() + 10000;
  while (state.inflight && performance.now() < stopAt)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (state.inflight) state.server.closeAllConnections();
  try {
    await state.delivery?.close();
  } catch (error) {
    failures.push(error);
  }
  await closeOwnedResources(state, failures);
  await new Promise((resolve) => state.server.close(resolve));
  state.relay.close();
  try {
    await releaseLock(state.lock);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new Fault("unavailable", "Broker cleanup was incomplete");
}

async function closeOwnedResources(state, failures) {
  for (const owned of [state.pool, state.feed, state.hub]) {
    try {
      await owned?.close();
    } catch (error) {
      failures.push(error);
    }
  }
}

export async function migrateLocalStore(options) {
  if (
    !object(options) ||
    !["backup,configFile,root,to", "backup,root,to"].includes(
      Object.keys(options).sort().join(","),
    ) ||
    typeof options.root !== "string" ||
    !options.root ||
    options.root.includes("\0") ||
    typeof options.backup !== "string" ||
    !options.backup ||
    options.backup.includes("\0") ||
    ![2, 3].includes(options.to) ||
    (options.to === 2 &&
      (typeof options.configFile !== "string" ||
        !options.configFile ||
        options.configFile.includes("\0"))) ||
    (options.to === 3 && options.configFile !== undefined)
  )
    fail("input", "Migration options are invalid");
  if (options.to === 2 && (await readConfig(options.configFile)).delivery.enabled)
    fail("input", "Rollback requires a disabled delivery configuration");
  const root = resolve(options.root);
  const lock = await acquireLock(root);
  let result;
  let failure;
  try {
    result = await migrateDatabase({
      root,
      to: options.to,
      backup: options.backup,
      ...(options.to === 2 ? { deliveryEnabled: false } : {}),
    });
  } catch (error) {
    failure = error;
  }
  try {
    await releaseLock(lock);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return result;
}

export async function reconcileLocalDelivery(options) {
  if (
    !object(options) ||
    Object.keys(options).sort().join(",") !== "confirm,id,outcome,reasonCode,root" ||
    options.confirm !== true ||
    options.reasonCode !== "operator-confirmed" ||
    typeof options.root !== "string" ||
    typeof options.id !== "string" ||
    !["observed", "not-accepted"].includes(options.outcome)
  )
    fail("input", "Delivery reconciliation options are invalid");
  const root = resolve(options.root);
  const lock = await acquireLock(root);
  let relay;
  let ownerGeneration;
  let result;
  let failure;
  try {
    relay = openForBroker({ root, role: "host", ownerToken: lock.nonce, reconciliation: true });
    ownerGeneration = claimDeliveryOwner(relay).generation;
    result = reconcileDeliveryAttempt(relay, {
      confirm: true,
      id: options.id,
      outcome: options.outcome,
      ownerGeneration,
      reasonCode: "operator-confirmed",
    });
  } catch (error) {
    failure = error;
  }
  if (relay && ownerGeneration !== undefined) {
    try {
      releaseDeliveryOwner(relay, ownerGeneration);
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    relay?.close();
  } catch (error) {
    failure ??= error;
  }
  try {
    await releaseLock(lock);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return result;
}

async function createBrokerServer(config) {
  if (config.tls) {
    const cert = await readTlsFile(config.tls.certFile, "TLS certificate", false);
    const key = await readTlsFile(config.tls.keyFile, "TLS private key", true);
    return https.createServer({
      cert,
      key,
      maxHeaderSize: MAX_HEADERS,
      minVersion: "TLSv1.2",
    });
  }
  return http.createServer({ maxHeaderSize: MAX_HEADERS, joinDuplicateHeaders: false });
}

async function cleanupBrokerRuntime(parts) {
  await Promise.allSettled([parts.delivery?.close()]);
  if (!parts.delivery && parts.relay && parts.deliveryOwnerGeneration !== null) {
    try {
      releaseDeliveryOwner(parts.relay, parts.deliveryOwnerGeneration);
    } catch {}
  }
  await Promise.allSettled([parts.pool?.close(), parts.feed?.close(), parts.hub?.close()]);
  parts.relay?.close();
  if (parts.lock) {
    try {
      await releaseLock(parts.lock);
    } catch {}
  }
}

async function startBrokerRuntime(config, root) {
  let relay;
  let lock;
  let hub = null;
  let pool = null;
  let feed = null;
  let delivery = null;
  let deliveryOwnerGeneration = null;
  let server;
  try {
    lock = await acquireLock(root);
    relay = openForBroker({ root, role: config.role, ownerToken: lock.nonce });
    if (config.hub) {
      hub = await connect({
        url: config.hub.url,
        tokenFile: config.hub.tokenFile,
        ...(config.hub.caFile ? { caFile: config.hub.caFile } : {}),
        mode: "tailscale",
      });
    }
    if (hub && hub.authority === relay.authority)
      throw new Fault("input", "Hub and host authorities must be distinct");
    feed = createFeed(relay);
    if (config.pool) pool = createPool({ local: relay, hub, ...config.pool });
    server = await createBrokerServer(config);
    if (config.delivery.enabled) {
      deliveryOwnerGeneration = claimDeliveryOwner(relay).generation;
      delivery = createDeliverySupervisor({
        local: relay,
        hub,
        pool,
        launchConfigured: Boolean(config.pool?.launch),
        ownerGeneration: deliveryOwnerGeneration,
        clients: config.delivery.clients,
        pollMs: config.delivery.pollMs,
      });
      await delivery.start();
    }
  } catch (error) {
    await cleanupBrokerRuntime({ relay, lock, hub, pool, feed, delivery, deliveryOwnerGeneration });
    throw error;
  }
  return { relay, lock, hub, pool, feed, delivery, server };
}

function configureBrokerServer(server) {
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 40;
  server.headersTimeout = 5000;
  server.requestTimeout = REQUEST_MS;
  server.keepAliveTimeout = 5000;
}

function faultStatus(known) {
  if (known.code === "auth") return 401;
  if (known.code === "denied") return 403;
  if (known.code === "input" || known.code === "protocol") return 400;
  if (known.code === "rate" || known.code === "full") return 429;
  if (known.code === "timeout") return 504;
  return 503;
}

function sendRequestFault(res, req, error) {
  if (res.headersSent || res.destroyed) return;
  const known =
    error instanceof Fault ? error : new Fault("unavailable", "Request could not be completed");
  try {
    asJSON(res, faultStatus(known), {
      v: 1,
      rid: req.relayRid ?? null,
      ok: false,
      fault: responseFault(known),
      time: Date.now(),
    });
  } catch {
    res.destroy();
  }
}

function onBrokerRequest(state, req, res) {
  state.inflight++;
  const deadline = performance.now() + REQUEST_MS;
  const timeout = setTimeout(() => {
    if (!res.writableEnded) {
      res.destroy();
    }
  }, REQUEST_MS);
  void handle(state, req, res, deadline, () => clearTimeout(timeout))
    .catch((error) => {
      sendRequestFault(res, req, error);
    })
    .finally(() => {
      clearTimeout(timeout);
      state.inflight--;
    });
}

async function listenBrokerServer(state, broker) {
  const server = state.server;
  const config = state.config;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.listen.port, config.listen.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await closeBroker(broker);
    throw new Fault("active", "Broker listener could not be started", { cause: error?.code });
  }
}

export async function serve(options) {
  if (
    !object(options) ||
    Object.keys(options).sort().join(",") !== "configFile,root" ||
    typeof options.root !== "string" ||
    typeof options.configFile !== "string"
  )
    fail("input", "Broker options are invalid");
  const config = await readConfig(options.configFile);
  const root = resolve(options.root);
  const registry = await loadRegistry(config.credentialsFile);
  const runtime = await startBrokerRuntime(config, root);
  const state = {
    config,
    root,
    relay: runtime.relay,
    lock: runtime.lock,
    hub: runtime.hub,
    pool: runtime.pool,
    feed: runtime.feed,
    delivery: runtime.delivery,
    server: runtime.server,
    address: null,
    closed: false,
    inflight: 0,
    activeRequests: 0,
    bodyReads: 0,
    active: new Map(),
    rates: new Map(),
    streams: new Set(),
    registry,
  };
  const broker = Object.create(Broker.prototype);
  brokers.set(broker, state);
  configureBrokerServer(state.server);
  state.server.on("request", (req, res) => {
    onBrokerRequest(state, req, res);
  });
  await listenBrokerServer(state, broker);
  const addr = state.server.address();
  if (!addr || typeof addr === "string") {
    await closeBroker(broker);
    throw new Fault("unavailable", "Broker address is unavailable");
  }
  state.address = Object.freeze({ address: addr.address, family: addr.family, port: addr.port });
  return broker;
}

async function freshAuth(state, req) {
  state.registry = await loadRegistry(state.config.credentialsFile);
  const principal = authenticate(state.registry, uniqueAuthorization(req));
  return principal;
}

function pruneRateTable(state, now) {
  for (const [id, entry] of state.rates) if (now - entry.last > 120000) state.rates.delete(id);
}

function rateExceeded(row, now) {
  return (
    row.times.length >= 60 ||
    (row.times.length >= 10 && now - row.times[row.times.length - 10] < 1000)
  );
}

function rateLimit(state, principal) {
  const now = performance.now();
  let row = state.rates.get(principal.id);
  if (!row) {
    if (state.rates.size >= 256) {
      pruneRateTable(state, now);
      if (state.rates.size >= 256) throw new Fault("rate", "Request rate limit exceeded");
    }
    row = { times: [], last: now };
    state.rates.set(principal.id, row);
  }
  row.last = now;
  row.times = row.times.filter((time) => now - time < 60000);
  if (rateExceeded(row, now)) throw new Fault("rate", "Request rate limit exceeded");
  row.times.push(now);
}

function admission(state, principal) {
  const active = state.active.get(principal.id) ?? 0;
  if (state.activeRequests + state.bodyReads >= 32 || active >= 8)
    throw new Fault("full", "Broker request capacity is full");
  state.activeRequests++;
  state.active.set(principal.id, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.activeRequests--;
    const count = (state.active.get(principal.id) ?? 1) - 1;
    if (count) state.active.set(principal.id, count);
    else state.active.delete(principal.id);
  };
}

function validPage(page, board, kind) {
  return (
    object(page) &&
    Array.isArray(page.items) &&
    Number.isSafeInteger(page.total) &&
    Number.isSafeInteger(page.visible) &&
    typeof page.complete === "boolean" &&
    typeof page.cursor === "string" &&
    (page.next === null || typeof page.next === "string") &&
    page.items.every((item) => object(item) && item.board === board && item.kind === kind)
  );
}

async function remoteBoardRequest(
  state,
  req,
  res,
  options,
  includeData,
  principal,
  binding,
  deadline,
) {
  if (!binding) fail("unavailable", "Board view is unavailable");
  const cancelled = new AbortController();
  const cancel = () => cancelled.abort();
  res.once("close", cancel);
  if (req.socket.destroyed) cancelled.abort();
  const remote = await createFixedClient(
    {
      url: binding.url,
      tokenFile: binding.tokenFile,
      ...(binding.caFile ? { caFile: binding.caFile } : {}),
      mode: "tailscale",
    },
    cancelled.signal,
  );
  try {
    if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
    const result = await invokeClient(remote, {
      rid: randomRid(),
      op: "list",
      args: { options },
      deadline,
    });
    const page = result.result;
    if (
      !validPage(page, options.board, options.kind) ||
      Buffer.byteLength(JSON.stringify(page)) > MAX_RESPONSE
    )
      fail("protocol", "Remote board response is invalid");
    const current = await loadRegistry(state.config.credentialsFile);
    state.registry = current;
    authorizeBoardRead(current, principal, options.board, options.kind, includeData);
    if (cancelled.signal.aborted) fail("unavailable", "Board request was cancelled");
    asJSON(res, 200, page);
  } finally {
    res.removeListener("close", cancel);
    cancelled.abort();
    await remote.close();
  }
}

async function localBoardRequest(state, req, res, options, principal, deadline) {
  const args = { options };
  const auth = authorize(state.registry, principal, "list", args);
  const outcome = await dispatchRpc(state.relay, {
    authorization: auth,
    rid: randomRid(),
    op: "list",
    args,
    beforeCommit: () => {
      if (performance.now() >= deadline) throw new Fault("timeout", "Request deadline elapsed");
      const currentRegistry = loadRegistrySync(state.config.credentialsFile);
      const current = authenticate(currentRegistry, uniqueAuthorization(req));
      if (current.id !== principal.id || current.scopeKey !== auth.scopeKey)
        throw new Fault("auth", "Credential was revoked");
      authorize(currentRegistry, current, "list", args);
    },
  });
  asJSON(res, 200, outcome.result);
}

async function boardRequest(state, req, res, url, principal, deadline) {
  const values = query(url, ["board", "kind", "after", "limit", "data"]);
  const options = pageArgs(values);
  const includeData = options.data === true;
  const snapshot = await loadRegistry(state.config.credentialsFile);
  state.registry = snapshot;
  authorizeBoardRead(snapshot, principal, options.board, options.kind, includeData);
  const binding = state.config.views.find((view) => view.boards.includes(options.board));
  if (options.board.startsWith("host:") && binding && binding.deviceId !== options.board.slice(5))
    fail("denied", "Board is outside the fixed view binding");
  if (options.board.startsWith("host:") && options.board !== `host:${state.relay.device.id}`) {
    await remoteBoardRequest(state, req, res, options, includeData, principal, binding, deadline);
    return;
  }
  await localBoardRequest(state, req, res, options, principal, deadline);
}

function waitForDrain(res, controller) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      res.removeListener("drain", drained);
      controller.signal.removeEventListener("abort", aborted);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(new Fault("unavailable", "Event stream closed"));
    };
    const timer = setTimeout(() => {
      cleanup();
      controller.abort();
      reject(new Fault("timeout", "Event reader is too slow"));
    }, 1000);
    res.once("drain", drained);
    controller.signal.addEventListener("abort", aborted, { once: true });
  });
}

async function streamEvents(state, res, principal, authorization, controller, cursor) {
  const iterable = state.feed.subscribe({ cursor, authorization, signal: controller.signal });
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  for await (const frame of iterable) {
    if (controller.signal.aborted || state.closed) break;
    const updated = await loadRegistry(state.config.credentialsFile);
    state.registry = updated;
    const checked = authorize(updated, principal, "snapshot", { options: {} });
    if (checked.scopeKey !== authorization.scopeKey) {
      res.write(`event: reset\ndata: ${JSON.stringify({ event: "reset", reason: "scope" })}\n\n`);
      break;
    }
    const chunk = Buffer.from(`event: ${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`);
    if (chunk.length > 16384 || !res.write(chunk)) {
      await waitForDrain(res, controller);
    }
  }
}

async function events(state, res, url, principal, deadline) {
  const values = query(url, ["cursor"]);
  if (!validCursor(values.cursor, "feed", 512)) fail("input", "Event cursor is invalid");
  if (state.streams.size >= 8) fail("full", "Event stream capacity is full");
  if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
  const current = await loadRegistry(state.config.credentialsFile);
  state.registry = current;
  const authorization = authorize(current, principal, "snapshot", { options: {} });
  if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
  const controller = new AbortController();
  state.streams.add(controller);
  res.once("close", () => controller.abort());
  try {
    await streamEvents(state, res, principal, authorization, controller, values.cursor);
  } finally {
    state.streams.delete(controller);
    if (res.headersSent && !res.writableEnded) res.end();
  }
}

function assetRelative(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    fail("input", "Static asset path is invalid");
  }
  const known = PUBLIC_ASSETS.get(decoded);
  if (known !== undefined) return known;
  if (!decoded.startsWith("/assets/")) return undefined;
  const name = decoded.slice("/assets/".length);
  if (
    !/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,200}$/.test(name) ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("input", "Static asset path is invalid");
  return join("assets", name);
}

async function serveAsset(res, path) {
  let file;
  try {
    file = await openFile(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
  } catch {
    return false;
  }
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > MAX_RESPONSE) {
    await file.close();
    return false;
  }
  const type = ASSET_TYPES[extname(path).toLowerCase()];
  if (!type) {
    await file.close();
    return false;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  await new Promise((resolvePromise, reject) =>
    file
      .createReadStream({ autoClose: true })
      .on("error", reject)
      .on("end", resolvePromise)
      .pipe(res),
  );
  return true;
}

async function staticAsset(req, res, url) {
  if (req.method !== "GET" || url.search) fail("protocol", "Static route is invalid");
  const relative = assetRelative(url.pathname);
  if (relative === undefined) return false;
  const path = resolve(UI_ROOT, relative);
  if (!path.startsWith(`${UI_ROOT}/`) && path !== UI_ROOT)
    fail("input", "Static asset path is invalid");
  const served = await serveAsset(res, path);
  return served;
}

async function callRoute(state, req, res, deadline, body, principal) {
  const snapshot = await loadRegistry(state.config.credentialsFile);
  state.registry = snapshot;
  const authorization = authorize(snapshot, principal, body.op, body.args);
  if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
  const outcome = await dispatchRpc(state.relay, {
    authorization,
    rid: body.rid,
    op: body.op,
    args: body.args,
    beforeCommit: () => {
      if (performance.now() >= deadline) throw new Fault("timeout", "Request deadline elapsed");
      const fresh = loadRegistrySync(state.config.credentialsFile);
      const current = authenticate(fresh, uniqueAuthorization(req));
      if (current.id !== principal.id || current.scopeKey !== authorization.scopeKey)
        throw new Fault("auth", "Credential was revoked");
      authorize(fresh, current, body.op, body.args);
    },
  });
  asJSON(res, 200, {
    v: 1,
    rid: body.rid,
    ok: true,
    result: outcome.result,
    time: outcome.committedAt ?? Date.now(),
    replayed: outcome.replayed,
    remainingMs: outcome.remainingMs,
  });
}

function assertRequestHeaders(req) {
  const seen = new Set();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (
      ["host", "content-type", "content-length", "transfer-encoding", "content-encoding"].includes(
        name,
      ) &&
      seen.has(name)
    )
      fail("protocol", "Duplicate request header");
    seen.add(name);
  }
}

function requestUrl(req) {
  if (typeof req.url !== "string" || !req.url.startsWith("/") || req.url.startsWith("//"))
    fail("protocol", "Request target is invalid");
  const url = new URL(req.url, "http://relay.invalid");
  if (url.hash || req.url.includes("#")) fail("protocol", "Request fragments are not accepted");
  return url;
}

function isStaticRoute(pathname) {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname.endsWith(".mjs") ||
    pathname.endsWith(".css") ||
    pathname.startsWith("/assets/")
  );
}

async function serveStaticRoute(req, res, url) {
  if (await staticAsset(req, res, url)) return;
  res.writeHead(404, {
    "Content-Length": 0,
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end();
}

async function healthRoute(state, req, res, url) {
  if (
    url.search ||
    req.headers["transfer-encoding"] !== undefined ||
    (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")
  )
    fail("protocol", "Health route does not accept a body or query");
  const principal = await freshAuth(state, req);
  rateLimit(state, principal);
  const release = admission(state, principal);
  try {
    asJSON(res, 200, { v: 1, authority: state.relay.authority, time: Date.now() });
  } finally {
    release();
  }
}

async function callRequest(state, req, res, url, deadline) {
  if (url.search) fail("protocol", "RPC route does not accept query fields");
  if (state.activeRequests + state.bodyReads >= 32) fail("full", "Broker request capacity is full");
  state.bodyReads++;
  let raw;
  try {
    raw = await readRequest(req, MAX_BODY, deadline);
  } finally {
    state.bodyReads--;
  }
  if (object(raw) && RID.test(raw.rid ?? "")) req.relayRid = raw.rid;
  const body = validateCall(raw);
  req.relayRid = body.rid;
  const principal = await freshAuth(state, req);
  rateLimit(state, principal);
  const release = admission(state, principal);
  try {
    await callRoute(state, req, res, deadline, body, principal);
  } finally {
    release();
  }
}

function topologyOptions(url) {
  const values = query(url, ["device", "limit", "after"]);
  const options = {};
  if (values.device !== undefined) options.device = values.device;
  if (values.limit !== undefined) {
    if (!/^[1-9]\d*$/.test(values.limit) || Number(values.limit) > 512)
      fail("input", "Snapshot limit is invalid");
    options.limit = Number(values.limit);
  }
  if (values.after !== undefined) options.after = values.after;
  return options;
}

function assertViewAuthority(state, client) {
  if (!client.authority || client.authority === state.relay.authority)
    fail("unavailable", "Fixed board view is unavailable");
}

function handleViewFailure(error, deadline, cancelled) {
  if (cancelled.signal.aborted) throw new Fault("unavailable", "Snapshot request was cancelled");
  if (performance.now() >= deadline) throw new Fault("timeout", "Request deadline elapsed");
  if (
    !(error instanceof Fault) ||
    !["auth", "denied", "tls", "protocol", "unavailable", "timeout", "rate", "full"].includes(
      error.code,
    )
  )
    throw error;
  // Accepted reports remain visible; unavailable body reads fail separately.
}

async function resolveViewBoards(state, view, boards, deadline, cancelled) {
  let client;
  try {
    if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
    client = await createFixedClient(
      {
        url: view.url,
        tokenFile: view.tokenFile,
        ...(view.caFile ? { caFile: view.caFile } : {}),
        mode: "tailscale",
      },
      cancelled.signal,
      { checkHealth: true, deadline },
    );
    if (performance.now() >= deadline) fail("timeout", "Request deadline elapsed");
    assertViewAuthority(state, client);
    for (const board of boards) board.authority = client.authority;
  } catch (error) {
    handleViewFailure(error, deadline, cancelled);
  } finally {
    await client?.close();
  }
}

function groupBoardsByView(state, remoteBoards) {
  const boardsByView = new Map();
  for (const board of remoteBoards) {
    const view = state.config.views.find(
      (candidate) => candidate.deviceId === board.device && candidate.boards.includes(board.id),
    );
    if (!view) continue;
    boardsByView.set(view, [...(boardsByView.get(view) ?? []), board]);
  }
  return boardsByView;
}

async function annotateRemoteBoards(state, res, result, deadline) {
  const remoteBoards = result.boards.filter(
    (board) => board.kind === "host" && board.device !== state.relay.device.id,
  );
  if (!remoteBoards.length) return;
  const boardsByView = groupBoardsByView(state, remoteBoards);
  const cancelled = new AbortController();
  const cancel = () => cancelled.abort();
  res.once("close", cancel);
  try {
    await Promise.all(
      [...boardsByView].map(([view, boards]) =>
        resolveViewBoards(state, view, boards, deadline, cancelled),
      ),
    );
  } finally {
    res.removeListener("close", cancel);
    cancelled.abort();
  }
}

async function topologyRoute(state, req, res, url, principal, deadline) {
  const options = topologyOptions(url);
  const snapshot = await loadRegistry(state.config.credentialsFile);
  state.registry = snapshot;
  const authorization = authorize(snapshot, principal, "snapshot", { options });
  const result = await state.feed.snapshot(options, authorization);
  await annotateRemoteBoards(state, res, result, deadline);
  const latest = loadRegistrySync(state.config.credentialsFile);
  state.registry = latest;
  const current = authenticate(latest, uniqueAuthorization(req));
  if (current.id !== principal.id || current.scopeKey !== authorization.scopeKey)
    fail("auth", "Credential was revoked");
  authorize(latest, current, "snapshot", { options });
  asJSON(res, 200, result);
}

async function dispatchRoute(state, req, res, url, principal, deadline, onStreamStart, release) {
  if (req.method === "POST" && url.pathname === "/v1/call")
    fail("protocol", "Route is not available");
  if (req.method === "GET" && url.pathname === "/v1/topology") {
    await topologyRoute(state, req, res, url, principal, deadline);
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/board") {
    await boardRequest(state, req, res, url, principal, deadline);
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/events") {
    release();
    onStreamStart?.();
    await events(state, res, url, principal, deadline);
    return;
  }
  fail("protocol", "Route is not available");
}

async function authenticatedRoute(state, req, res, url, deadline, onStreamStart) {
  const principal = await freshAuth(state, req);
  rateLimit(state, principal);
  const release = admission(state, principal);
  try {
    await dispatchRoute(state, req, res, url, principal, deadline, onStreamStart, release);
  } finally {
    release();
  }
}

async function handle(state, req, res, deadline, onStreamStart) {
  if (state.closed) fail("unavailable", "Broker is closing");
  if (
    !healthyModePeer(
      state.config.mode,
      state.config.allowedPeers,
      req.socket.remoteAddress,
      req.socket.localAddress,
    )
  )
    fail("denied");
  assertRequestHeaders(req);
  const url = requestUrl(req);
  if (isStaticRoute(url.pathname)) {
    await serveStaticRoute(req, res, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/health") {
    await healthRoute(state, req, res, url);
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/call") {
    await callRequest(state, req, res, url, deadline);
    return;
  }
  await authenticatedRoute(state, req, res, url, deadline, onStreamStart);
}
