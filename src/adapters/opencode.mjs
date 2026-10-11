import { chmod, lstat, stat, unlink } from "node:fs/promises";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { parseJsonStrict } from "../config.mjs";
import { deliveryTargetDigest } from "../relay.mjs";
import { openCodeSocketPath } from "./opencode-bridge.mjs";

export const client = "opencode";
export const evidence = "pending";
export const capabilities = Object.freeze({ context: true, idle: true, launch: false });

const MAX_BODY = 16 * 1024;
const MAX_RESPONSE = 24 * 1024;
const MAX_BINDINGS = 16;
const COMMAND_MS = 2500;
const POLL_MS = 12000;
const LEASE_MS = 30000;
const RID = /^[A-Za-z0-9_-]{1,64}$/;
const METHODS = new Set(["status", "submit"]);
const OBSERVATIONS = new Set(["held", "refused", "context_observed", "turn_started", "safe_idle"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys) {
  return object(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function validObservation(value) {
  return object(value)
    && OBSERVATIONS.has(value.state)
    && Object.keys(value).every((key) => key === "state" || key === "nativeRequestId")
    && (value.nativeRequestId === undefined || typeof value.nativeRequestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.nativeRequestId));
}

function response(res, rid, result, status = 200) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify({ v: 1, rid, ok: true, result, time: Date.now(), replayed: false, remainingMs: null }));
  if (body.byteLength > MAX_RESPONSE) {
    res.writeHead(500, { "content-type": "application/json", "content-length": "0", connection: "close" }).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", "content-length": String(body.byteLength), "cache-control": "no-store", connection: "close" });
  res.end(body);
}

function failure(res, rid, status = 400) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify({ v: 1, rid: RID.test(rid ?? "") ? rid : null, ok: false, fault: { code: "protocol", message: "Native bridge request was rejected" }, time: Date.now() }));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(body.byteLength), "cache-control": "no-store", connection: "close" });
  res.end(body);
}

async function readBody(req) {
  if (req.headers["transfer-encoding"] !== undefined || req.headers["content-encoding"] !== undefined) throw new Error("invalid framing");
  const length = req.headers["content-length"];
  if (typeof length !== "string" || !/^\d+$/.test(length) || Number(length) > MAX_BODY) throw new Error("invalid length");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY) throw new Error("body limit");
    chunks.push(chunk);
  }
  if (size !== Number(length)) throw new Error("body length mismatch");
  return parseJsonStrict(Buffer.concat(chunks).toString("utf8"), MAX_BODY);
}

function validEnvelope(value) {
  return exact(value, ["args", "op", "rid", "v"])
    && value.v === 1
    && RID.test(value.rid)
    && typeof value.op === "string"
    && value.op.startsWith("delivery.")
    && object(value.args);
}

async function secureRoot(root) {
  const info = await stat(resolve(root));
  if (!info.isDirectory() || process.platform === "win32" || typeof process.getuid !== "function" || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error("Private Unix Relay root is required");
  }
}

async function recoverStaleSocket(socketPath) {
  let info;
  try { info = await lstat(socketPath); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("Existing bridge path is not an owned private socket");
  const active = await new Promise((resolveProbe) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); resolveProbe(null); }, 500);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolveProbe(true); });
    socket.once("error", (error) => { clearTimeout(timer); resolveProbe(error.code === "ECONNREFUSED" ? false : null); });
  });
  if (active !== false) throw new Error("A native bridge already owns the socket");
  const current = await lstat(socketPath);
  if (current.isSocket() && current.uid === process.getuid() && current.dev === info.dev && current.ino === info.ino) await unlink(socketPath);
}

async function removeStaleToken(tokenPath) {
  let handle;
  try { handle = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  try {
    const info = await handle.stat();
    const content = await handle.readFile();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || content.byteLength !== 64 || !/^[a-f0-9]{64}$/.test(content.toString("ascii"))) throw new Error("Existing bridge token is not a private Relay token");
    content.fill(0);
  } finally {
    await handle.close();
  }
  await unlink(tokenPath);
}

async function createToken(tokenPath) {
  const secret = randomBytes(32);
  const handle = await open(tokenPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(secret.toString("hex"), "ascii");
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("Bridge token permissions are not private");
    return { secret, inode: { dev: info.dev, ino: info.ino } };
  } catch (error) {
    secret.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
}

async function removeOwnedToken(tokenPath, inode) {
  if (!inode) return;
  try {
    const info = await lstat(tokenPath);
    if (info.isFile() && info.uid === process.getuid() && info.dev === inode.dev && info.ino === inode.ino) await unlink(tokenPath);
  } catch {}
}

export async function startDeliveryAdapter({ client: selected, bind, signal, root, onEvidence }) {
  if (selected !== client || typeof bind !== "function" || typeof onEvidence !== "function" || !signal || typeof signal.addEventListener !== "function") throw new TypeError("OpenCode adapter startup options are invalid");
  if (process.platform === "win32") {
    onEvidence("unsupported");
    return Object.freeze({ close: async () => {} });
  }

  const resolvedRoot = resolve(root);
  const socketPath = openCodeSocketPath(resolvedRoot);
  const tokenPath = join(resolvedRoot, "opencode-delivery.token");
  if (Buffer.byteLength(socketPath) > 100) {
    onEvidence("unsupported");
    return Object.freeze({ close: async () => {} });
  }
  try { await secureRoot(root); }
  catch {
    onEvidence("unsupported");
    return Object.freeze({ close: async () => {} });
  }

  const registrations = new Map();
  const targets = new Map();
  const sockets = new Set();
  let closed = false;
  let ownSocket = null;
  let ownToken = null;
  let secret = null;

  const publishEvidence = () => onEvidence(registrations.size ? "wired" : "pending");

  async function closeTarget(record) {
    if (record.closed) return;
    record.closed = true;
    clearTimeout(record.leaseTimer);
    clearTimeout(record.waiter?.timer);
    if (record.waiter) {
      const waiter = record.waiter;
      record.waiter = null;
      failure(waiter.res, waiter.rid, 503);
    }
    if (record.currentCall) {
      clearTimeout(record.currentCall.timer);
      record.currentCall.reject(new Error("Native consumer disconnected"));
      record.currentCall = null;
    }
    if (targets.get(record.digest) === record) targets.delete(record.digest);
    for (const registration of record.bindings.values()) {
      registration.closed = true;
      registrations.delete(registration.id);
      await Promise.resolve(registration.handle.close()).catch(() => {});
    }
    record.bindings.clear();
    publishEvidence();
  }

  async function detach(registration) {
    if (registration.closed) return;
    registration.closed = true;
    registrations.delete(registration.id);
    const record = registration.target;
    record.bindings.delete(registration.id);
    await Promise.resolve(registration.handle.close()).catch(() => {});
    if (record.bindings.size === 0) await closeTarget(record);
    else touch(record);
    publishEvidence();
  }

  function touch(record) {
    clearTimeout(record.leaseTimer);
    record.leaseTimer = setTimeout(() => { void closeTarget(record); }, LEASE_MS);
    record.leaseTimer.unref?.();
  }

  function deliver(record) {
    const waiter = record.waiter;
    const current = record.currentCall;
    if (!waiter || !current || current.delivered || waiter.res.destroyed || waiter.res.writableEnded) return;
    clearTimeout(waiter.timer);
    record.waiter = null;
    current.delivered = true;
    response(waiter.res, waiter.rid, { command: { callId: current.id, method: current.method, args: current.args } });
  }

  function invoke(record, method, args) {
    if (record.closed || closed || !METHODS.has(method) || record.currentCall) return Promise.reject(new Error("Native consumer is unavailable"));
    const id = randomUUID();
    touch(record);
    return new Promise((resolveCall, rejectCall) => {
      const currentCall = {
        id,
        method,
        args,
        delivered: false,
        resolve: resolveCall,
        reject: rejectCall,
        timer: setTimeout(() => {
          if (record.currentCall !== currentCall) return;
          record.currentCall = null;
          rejectCall(new Error("Native consumer call timed out"));
        }, COMMAND_MS),
      };
      currentCall.timer.unref?.();
      record.currentCall = currentCall;
      deliver(record);
    });
  }

  async function bindNative(args) {
    if (!exact(args, ["authority", "capabilities", "epoch", "profile", "sid", "target", "worker"])
      || typeof args.authority !== "string" || !Number.isSafeInteger(args.epoch) || args.epoch < 0
      || typeof args.sid !== "string" || typeof args.worker !== "string" || typeof args.profile !== "string"
      || !object(args.target) || args.target.profile !== args.profile || args.target.client !== undefined
      || !exact(args.capabilities, ["context", "idle", "launch"])
      || args.capabilities.context !== true || args.capabilities.idle !== true || args.capabilities.launch !== false) throw new Error("Invalid binding");
    if (registrations.size >= MAX_BINDINGS) throw new Error("Binding capacity is full");

    const digest = deliveryTargetDigest(args.target);
    let record = targets.get(digest);
    let created = false;
    if (record && (record.closed || record.target.runtimeInstance !== args.target.runtimeInstance || record.target.lifecycleGeneration !== args.target.lifecycleGeneration)) {
      throw new Error("A different native lifecycle already owns this target");
    }
    if (!record) {
      record = {
        digest,
        target: args.target,
        bindings: new Map(),
        waiter: null,
        currentCall: null,
        observations: new Map(),
        closed: false,
        leaseTimer: null,
      };
      record.consumer = Object.freeze({
        status: () => invoke(record, "status", {}),
        submit: (input) => invoke(record, "submit", input),
        observe: ({ attemptId, nativeRequestId }) => {
          const observation = record.observations.get(attemptId);
          return observation && (nativeRequestId === undefined || observation.nativeRequestId === nativeRequestId)
            ? observation
            : { state: "unknown" };
        },
      });
      targets.set(digest, record);
      created = true;
    }
    const registration = { id: randomUUID(), target: record, handle: null, closed: false };
    try {
      const handle = await bind({
        authority: args.authority,
        worker: args.worker,
        sid: args.sid,
        epoch: args.epoch,
        client,
        target: args.target,
        capabilities: args.capabilities,
        consumer: record.consumer,
      });
      if (!handle || typeof handle.close !== "function" || typeof handle.observe !== "function") {
        await Promise.resolve(handle?.close?.()).catch(() => {});
        throw new Error("Relay returned an invalid native binding handle");
      }
      if (closed || signal.aborted || record.closed) {
        await Promise.resolve(handle.close()).catch(() => {});
        throw new Error("Native bridge stopped during binding");
      }
      registration.handle = handle;
    } catch (error) {
      if (created) await closeTarget(record);
      throw error;
    }
    record.bindings.set(registration.id, registration);
    registrations.set(registration.id, registration);
    touch(record);
    publishEvidence();
    return registration;
  }

  async function route(req, res) {
    let rid = null;
    try {
      const url = new URL(req.url, "http://relay.invalid");
      if (req.method !== "POST" || url.pathname !== "/v1/call" || url.search || req.headers["content-type"] !== "application/json") throw new Error("route");
      const authorization = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "authorization") authorization.push(req.rawHeaders[i + 1]);
      if (authorization.length !== 1 || !authorization[0].startsWith("Relay ")) return failure(res, null, 401);
      const candidate = Buffer.from(authorization[0].slice(6), "hex");
      if (candidate.byteLength !== 32 || !secret || !timingSafeEqual(secret, candidate)) { candidate.fill(0); return failure(res, null, 401); }
      candidate.fill(0);
      const body = await readBody(req);
      if (!validEnvelope(body)) throw new Error("envelope");
      rid = body.rid;
      const args = body.args;
      if (closed || signal.aborted) return failure(res, rid, 503);

      if (body.op === "delivery.bind") {
        const record = await bindNative(args);
        return response(res, rid, { bindingId: record.id });
      }
      if (body.op === "delivery.next") {
        if (!exact(args, ["bindingId"]) || typeof args.bindingId !== "string") throw new Error("next");
        const registration = registrations.get(args.bindingId);
        const record = registration?.target;
        if (!registration || registration.closed || !record || record.closed || record.waiter) throw new Error("binding");
        touch(record);
        if (record.currentCall && !record.currentCall.delivered) {
          record.currentCall.delivered = true;
          return response(res, rid, { command: { callId: record.currentCall.id, method: record.currentCall.method, args: record.currentCall.args } });
        }
        await new Promise((resolveWait) => {
          const waiter = { res, rid, timer: null, resolve: resolveWait };
          record.waiter = waiter;
          waiter.timer = setTimeout(() => {
            if (record.waiter !== waiter) return;
            record.waiter = null;
            response(res, rid, { command: null });
            resolveWait();
          }, POLL_MS);
          waiter.timer.unref?.();
          res.once("close", () => {
            if (record.waiter !== waiter) return;
            clearTimeout(waiter.timer);
            record.waiter = null;
            resolveWait();
          });
          deliver(record);
        });
        return;
      }
      if (body.op === "delivery.complete") {
        if (!exact(args, ["bindingId", "callId", "result"]) || typeof args.bindingId !== "string" || typeof args.callId !== "string" || !object(args.result)) throw new Error("complete");
        const registration = registrations.get(args.bindingId);
        const record = registration?.target;
        const call = record?.currentCall;
        if (!registration || registration.closed || !record || !call || call.id !== args.callId) throw new Error("stale call");
        if (call.method === "status" && (!exact(args.result, ["state"]) || !["busy", "idle", "absent", "unknown", "held", "refused"].includes(args.result.state))) throw new Error("status result");
        if (call.method === "submit" && (typeof args.result.accepted !== "boolean" || args.result.accepted && (!exact(args.result, ["accepted", "nativeRequestId"]) || typeof args.result.nativeRequestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.result.nativeRequestId)) || !args.result.accepted && (!exact(args.result, ["accepted", "state"]) || !["held", "refused"].includes(args.result.state)))) throw new Error("submit result");
        clearTimeout(call.timer);
        record.currentCall = null;
        touch(record);
        call.resolve(args.result);
        return response(res, rid, { completed: true });
      }
      if (body.op === "delivery.observe") {
        if (!exact(args, ["attemptId", "bindingId", "observation"]) || typeof args.bindingId !== "string" || typeof args.attemptId !== "string" || !validObservation(args.observation)) throw new Error("observation");
        const registration = registrations.get(args.bindingId);
        const record = registration?.target;
        if (!registration || registration.closed || !record || record.closed) throw new Error("binding");
        touch(record);
        record.observations.set(args.attemptId, args.observation);
        while (record.observations.size > 128) record.observations.delete(record.observations.keys().next().value);
        const applied = await registration.handle.observe(args.attemptId, args.observation);
        return response(res, rid, { applied: applied === true });
      }
      if (body.op === "delivery.close") {
        if (!exact(args, ["bindingId"]) || typeof args.bindingId !== "string") throw new Error("close");
        const registration = registrations.get(args.bindingId);
        if (registration) await detach(registration);
        return response(res, rid, { closed: Boolean(registration) });
      }
      throw new Error("operation");
    } catch {
      failure(res, rid, 400);
    }
  }

  const server = createServer((req, res) => {
    sockets.add(req.socket);
    req.socket.once("close", () => sockets.delete(req.socket));
    void route(req, res);
  });
  server.headersTimeout = 5000;
  server.requestTimeout = POLL_MS + 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = MAX_BINDINGS * 2 + 4;
  server.maxRequestsPerSocket = 1;
  server.on("clientError", (_error, socket) => socket.destroy());

  try {
    await recoverStaleSocket(socketPath);
    await removeStaleToken(tokenPath);
    const created = await createToken(tokenPath);
    secret = created.secret;
    ownToken = created.inode;
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, () => {
        server.removeListener("error", rejectListen);
        resolveListen();
      });
    });
    await chmod(socketPath, 0o600);
    const info = await lstat(socketPath);
    if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("Socket permissions are not private");
    ownSocket = { dev: info.dev, ino: info.ino };
  } catch {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    secret?.fill(0);
    await removeOwnedToken(tokenPath, ownToken);
    onEvidence("unsupported");
    return Object.freeze({ close: async () => {} });
  }

  publishEvidence();
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", onAbort);
    for (const record of [...targets.values()]) await closeTarget(record);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    try {
      const current = await lstat(socketPath);
      if (ownSocket && current.isSocket() && current.dev === ownSocket.dev && current.ino === ownSocket.ino && current.uid === process.getuid()) await unlink(socketPath);
    } catch {}
    await removeOwnedToken(tokenPath, ownToken);
    secret?.fill(0);
    onEvidence("pending");
  };
  const onAbort = () => { void close(); };
  signal.addEventListener("abort", onAbort, { once: true });
  return Object.freeze({ close });
}
