import { chmod, lstat, stat, unlink } from "node:fs/promises";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { parseJsonStrict } from "../config.mjs";
import { deliveryTargetDigest } from "../relay.mjs";
import { openCodeSocketPath, readOpenCodeTokenFile } from "./opencode-bridge.mjs";

export const client = "opencode";
export const evidence = "pending";
export const capabilities = Object.freeze({ context: true, idle: true, launch: false });

// A 4 KiB reply can expand sixfold when JSON escapes control characters.
const MAX_BODY = 32 * 1024;
const MAX_RESPONSE = 96 * 1024;
const MAX_BINDINGS = 16;
const COMMAND_MS = 2500;
const POLL_MS = 12000;
const LEASE_MS = 30000;
const RID = /^[A-Za-z0-9_-]{1,64}$/;
const LEASE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const METHODS = new Set(["status", "submit"]);
const OBSERVATIONS = new Set(["held", "refused", "context_observed", "turn_started", "safe_idle"]);
const RECIPIENT_OPS = new Set(["pending", "renew", "claim", "touch", "ack", "release", "reply"]);
const SENT = Symbol("response-sent");

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys) {
  return object(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function validObservation(value) {
  return (
    object(value) &&
    OBSERVATIONS.has(value.state) &&
    Object.keys(value).every((key) => key === "state" || key === "nativeRequestId") &&
    (value.nativeRequestId === undefined ||
      (typeof value.nativeRequestId === "string" &&
        /^[A-Za-z0-9._:-]{1,128}$/.test(value.nativeRequestId)))
  );
}

function validRecipientArgs(op, args) {
  if (!RECIPIENT_OPS.has(op) || !object(args)) return false;
  if (op === "pending" || op === "renew") return exact(args, []);
  if (op === "claim") return exact(args, ["kind"]) && ["msg", "work"].includes(args.kind);
  if (op === "touch" || op === "release")
    return exact(args, ["lease"]) && typeof args.lease === "string" && LEASE_ID.test(args.lease);
  if (op === "ack")
    return (
      exact(args, ["lease", "outcome"]) &&
      typeof args.lease === "string" &&
      LEASE_ID.test(args.lease) &&
      ["done", "failed", "rejected"].includes(args.outcome)
    );
  return (
    exact(args, ["key", "lease", "msg"]) &&
    typeof args.lease === "string" &&
    LEASE_ID.test(args.lease) &&
    typeof args.key === "string" &&
    LEASE_ID.test(args.key) &&
    typeof args.msg === "string" &&
    Buffer.byteLength(args.msg, "utf8") <= 4096
  );
}

function validBindArgs(args) {
  const bindKeys = ["authority", "capabilities", "epoch", "profile", "sid", "target", "worker"];
  if (!object(args) || !(exact(args, bindKeys) || exact(args, [...bindKeys, "consume"])))
    return false;
  if (args.consume !== undefined && args.consume !== true) return false;
  if (typeof args.authority !== "string" || !Number.isSafeInteger(args.epoch) || args.epoch < 0)
    return false;
  if (
    typeof args.sid !== "string" ||
    typeof args.worker !== "string" ||
    typeof args.profile !== "string"
  )
    return false;
  if (
    !object(args.target) ||
    args.target.profile !== args.profile ||
    args.target.client !== undefined
  )
    return false;
  return (
    exact(args.capabilities, ["context", "idle", "launch"]) &&
    args.capabilities.context === true &&
    args.capabilities.idle === true &&
    args.capabilities.launch === false
  );
}

function validStatusResult(result) {
  return (
    exact(result, ["state"]) &&
    ["busy", "idle", "absent", "unknown", "held", "refused"].includes(result.state)
  );
}

function validSubmitResult(result) {
  if (typeof result.accepted !== "boolean") return false;
  if (!result.accepted) {
    return exact(result, ["accepted", "state"]) && ["held", "refused"].includes(result.state);
  }
  return (
    exact(result, ["accepted", "nativeRequestId"]) &&
    typeof result.nativeRequestId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(result.nativeRequestId)
  );
}

function validRoute(req) {
  const url = new URL(req.url, "http://relay.invalid");
  return (
    req.method === "POST" &&
    url.pathname === "/v1/call" &&
    !url.search &&
    req.headers["content-type"] === "application/json"
  );
}

function authorized(req, secret) {
  const authorization = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === "authorization")
      authorization.push(req.rawHeaders[i + 1]);
  }
  if (authorization.length !== 1 || !authorization[0].startsWith("Relay ")) return false;
  const candidate = Buffer.from(authorization[0].slice(6), "hex");
  if (candidate.byteLength !== 32 || !secret || !timingSafeEqual(secret, candidate)) {
    candidate.fill(0);
    return false;
  }
  candidate.fill(0);
  return true;
}

function validNextArgs(args) {
  return exact(args, ["bindingId"]) && typeof args.bindingId === "string";
}

function validCompleteArgs(args) {
  return (
    exact(args, ["bindingId", "callId", "result"]) &&
    typeof args.bindingId === "string" &&
    typeof args.callId === "string" &&
    object(args.result)
  );
}

function validObserveArgs(args) {
  return (
    exact(args, ["attemptId", "bindingId", "observation"]) &&
    typeof args.bindingId === "string" &&
    typeof args.attemptId === "string" &&
    validObservation(args.observation)
  );
}

function validRecipientRequestArgs(args) {
  return (
    exact(args, ["args", "bindingId", "op"]) &&
    typeof args.bindingId === "string" &&
    typeof args.op === "string" &&
    validRecipientArgs(args.op, args.args)
  );
}

function validCloseArgs(args) {
  return exact(args, ["bindingId"]) && typeof args.bindingId === "string";
}

function usableBinding(registration, record) {
  return (
    Boolean(registration) &&
    !registration.closed &&
    Boolean(record) &&
    !record.closed &&
    !record.waiter
  );
}

function assertCallResult(method, result) {
  if (method === "status" && !validStatusResult(result)) throw new Error("status result");
  if (method === "submit" && !validSubmitResult(result)) throw new Error("submit result");
}

function sendResult(result, res, rid) {
  if (result === SENT) return;
  return response(res, rid, result);
}

function response(res, rid, result, status = 200) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      rid,
      ok: true,
      result,
      time: Date.now(),
      replayed: false,
      remainingMs: null,
    }),
  );
  if (body.byteLength > MAX_RESPONSE) {
    res
      .writeHead(500, {
        "content-type": "application/json",
        "content-length": "0",
        connection: "close",
      })
      .end();
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body);
}

function failure(res, rid, status = 400) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      rid: RID.test(rid ?? "") ? rid : null,
      ok: false,
      fault: { code: "protocol", message: "Native bridge request was rejected" },
      time: Date.now(),
    }),
  );
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body);
}

async function readBody(req) {
  if (
    req.headers["transfer-encoding"] !== undefined ||
    req.headers["content-encoding"] !== undefined
  )
    throw new Error("invalid framing");
  const length = req.headers["content-length"];
  if (typeof length !== "string" || !/^\d+$/.test(length) || Number(length) > MAX_BODY)
    throw new Error("invalid length");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY) throw new Error("body limit");
    chunks.push(chunk);
  }
  if (size !== Number(length)) throw new Error("body length mismatch");
  return parseJsonStrict(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    MAX_BODY,
  );
}

function validEnvelope(value) {
  return (
    exact(value, ["args", "op", "rid", "v"]) &&
    value.v === 1 &&
    RID.test(value.rid) &&
    typeof value.op === "string" &&
    value.op.startsWith("delivery.") &&
    object(value.args)
  );
}

async function secureRoot(root) {
  const info = await stat(resolve(root));
  if (
    !info.isDirectory() ||
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("Private Unix Relay root is required");
  }
}

async function recoverStaleSocket(socketPath) {
  let info;
  try {
    info = await lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error("Existing bridge path is not an owned private socket");
  const active = await new Promise((resolveProbe) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveProbe(null);
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(true);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolveProbe(error.code === "ECONNREFUSED" ? false : null);
    });
  });
  if (active !== false) throw new Error("A native bridge already owns the socket");
  const current = await lstat(socketPath);
  if (
    current.isSocket() &&
    current.uid === process.getuid() &&
    current.dev === info.dev &&
    current.ino === info.ino
  )
    await unlink(socketPath);
}

async function removeStaleToken(tokenPath) {
  let token;
  try {
    token = await readOpenCodeTokenFile(tokenPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const current = await lstat(tokenPath);
  if (
    !current.isFile() ||
    current.uid !== process.getuid() ||
    (current.mode & 0o077) !== 0 ||
    current.dev !== token.dev ||
    current.ino !== token.ino
  )
    throw new Error("Native bridge token ownership changed");
  await unlink(tokenPath);
}

async function createToken(tokenPath) {
  const secret = randomBytes(32);
  const handle = await open(
    tokenPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(secret.toString("hex"), "ascii");
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
      throw new Error("Bridge token permissions are not private");
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
    if (
      info.isFile() &&
      info.uid === process.getuid() &&
      info.dev === inode.dev &&
      info.ino === inode.ino
    )
      await unlink(tokenPath);
  } catch {}
}

export async function startDeliveryAdapter({ client: selected, bind, signal, root, onEvidence }) {
  if (
    selected !== client ||
    typeof bind !== "function" ||
    typeof onEvidence !== "function" ||
    !signal ||
    typeof signal.addEventListener !== "function"
  )
    throw new TypeError("OpenCode adapter startup options are invalid");
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
  try {
    await secureRoot(root);
  } catch {
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
    record.leaseTimer = setTimeout(() => {
      void closeTarget(record);
    }, LEASE_MS);
    record.leaseTimer.unref?.();
  }

  function deliver(record) {
    const waiter = record.waiter;
    const current = record.currentCall;
    if (
      !waiter ||
      !current ||
      current.delivered ||
      waiter.res.destroyed ||
      waiter.res.writableEnded
    )
      return;
    clearTimeout(waiter.timer);
    record.waiter = null;
    current.delivered = true;
    response(waiter.res, waiter.rid, {
      command: { callId: current.id, method: current.method, args: current.args },
    });
  }

  function invoke(record, method, args) {
    if (record.closed || closed || !METHODS.has(method) || record.currentCall)
      return Promise.reject(new Error("Native consumer is unavailable"));
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
    if (!validBindArgs(args)) throw new Error("Invalid binding");
    const digest = deliveryTargetDigest(args.target);
    const existing = await resolveExisting(digest, args.target);
    if (registrations.size >= MAX_BINDINGS) throw new Error("Binding capacity is full");
    const record = existing ?? createRecord(digest, args.target);
    const registration = {
      id: randomUUID(),
      target: record,
      handle: null,
      closed: false,
      consume: args.consume === true,
    };
    try {
      registration.handle = await bindHandle(args, record);
    } catch (error) {
      if (!existing) await closeTarget(record);
      throw error;
    }
    record.bindings.set(registration.id, registration);
    registrations.set(registration.id, registration);
    touch(record);
    publishEvidence();
    return registration;
  }

  async function resolveExisting(digest, target) {
    const record = targets.get(digest);
    if (!record) return null;
    const stale =
      record.closed ||
      record.target.runtimeInstance !== target.runtimeInstance ||
      record.target.lifecycleGeneration !== target.lifecycleGeneration;
    if (!stale) return record;
    if (!record.closed) await closeTarget(record);
    return null;
  }

  function createRecord(digest, target) {
    const record = {
      digest,
      target,
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
        return observation &&
          (nativeRequestId === undefined || observation.nativeRequestId === nativeRequestId)
          ? observation
          : { state: "unknown" };
      },
    });
    targets.set(digest, record);
    return record;
  }

  async function bindHandle(args, record) {
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
    if (
      !handle ||
      typeof handle.close !== "function" ||
      typeof handle.observe !== "function" ||
      (args.consume === true && typeof handle.recipient !== "function")
    ) {
      await Promise.resolve(handle?.close?.()).catch(() => {});
      throw new Error("Relay returned an invalid native binding handle");
    }
    if (closed || signal.aborted || record.closed) {
      await Promise.resolve(handle.close()).catch(() => {});
      throw new Error("Native bridge stopped during binding");
    }
    return handle;
  }

  async function route(req, res) {
    const state = { rid: null };
    try {
      return await handleRoute(req, res, state);
    } catch {
      failure(res, state.rid, 400);
    }
  }

  async function handleRoute(req, res, state) {
    if (!validRoute(req)) throw new Error("route");
    if (!authorized(req, secret)) return failure(res, null, 401);
    const body = await readBody(req);
    if (!validEnvelope(body)) throw new Error("envelope");
    state.rid = body.rid;
    if (halted()) return failure(res, state.rid, 503);
    const result = await dispatch(body.op, body.args, res, state.rid);
    return sendResult(result, res, state.rid);
  }

  function halted() {
    return closed || signal.aborted;
  }

  const operations = new Map([
    [
      "delivery.bind",
      async (args) => {
        const registration = await bindNative(args);
        return { bindingId: registration.id };
      },
    ],
    ["delivery.next", (args, res, rid) => nextCommand(args, res, rid)],
    ["delivery.complete", (args) => completeCall(args)],
    ["delivery.observe", (args) => observeAttempt(args)],
    ["delivery.recipient", (args) => recipientCall(args)],
    ["delivery.close", (args) => closeBinding(args)],
  ]);

  function dispatch(op, args, res, rid) {
    const handler = operations.get(op);
    if (!handler) throw new Error("operation");
    return handler(args, res, rid);
  }

  async function nextCommand(args, res, rid) {
    if (!validNextArgs(args)) throw new Error("next");
    const registration = registrations.get(args.bindingId);
    const record = registration?.target;
    if (!usableBinding(registration, record)) throw new Error("binding");
    touch(record);
    const current = record.currentCall;
    if (current && !current.delivered) {
      current.delivered = true;
      return {
        command: {
          callId: current.id,
          method: current.method,
          args: current.args,
        },
      };
    }
    await waitForCommand(record, res, rid);
    return SENT;
  }

  function waitForCommand(record, res, rid) {
    return new Promise((resolveWait) => {
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
  }

  function completeCall(args) {
    if (!validCompleteArgs(args)) throw new Error("complete");
    const registration = registrations.get(args.bindingId);
    const record = registration?.target;
    const call = record?.currentCall;
    if (!registration || registration.closed || !record || !call || call.id !== args.callId)
      throw new Error("stale call");
    assertCallResult(call.method, args.result);
    clearTimeout(call.timer);
    record.currentCall = null;
    touch(record);
    call.resolve(args.result);
    return { completed: true };
  }

  async function observeAttempt(args) {
    if (!validObserveArgs(args)) throw new Error("observation");
    const registration = registrations.get(args.bindingId);
    const record = registration?.target;
    if (!registration || registration.closed || !record || record.closed)
      throw new Error("binding");
    touch(record);
    record.observations.set(args.attemptId, args.observation);
    while (record.observations.size > 128)
      record.observations.delete(record.observations.keys().next().value);
    const applied = await registration.handle.observe(args.attemptId, args.observation);
    return { applied: applied === true };
  }

  function recipientCall(args) {
    if (!validRecipientRequestArgs(args)) throw new Error("recipient");
    const registration = registrations.get(args.bindingId);
    if (
      !registration ||
      registration.closed ||
      !registration.consume ||
      typeof registration.handle.recipient !== "function"
    )
      throw new Error("recipient binding");
    return registration.handle.recipient(args.op, args.args);
  }

  async function closeBinding(args) {
    if (!validCloseArgs(args)) throw new Error("close");
    const registration = registrations.get(args.bindingId);
    if (registration) await detach(registration);
    return { closed: Boolean(registration) };
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
    if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
      throw new Error("Socket permissions are not private");
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
      if (
        ownSocket &&
        current.isSocket() &&
        current.dev === ownSocket.dev &&
        current.ino === ownSocket.ino &&
        current.uid === process.getuid()
      )
        await unlink(socketPath);
    } catch {}
    await removeOwnedToken(tokenPath, ownToken);
    secret?.fill(0);
    onEvidence("pending");
  };
  const onAbort = () => {
    void close();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return Object.freeze({ close });
}
