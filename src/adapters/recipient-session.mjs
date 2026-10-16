import { createHash } from "node:crypto";
import { callOpenCodeBridge } from "./opencode-bridge.mjs";
import { LIMITS, validateEnvelope } from "../validate.mjs";

const TOOL_PREFIX = "relay_";
const SESSION_FIELDS = ["ended", "epoch", "id", "until", "worker"];
const PENDING_FIELDS = ["authority", "epoch", "pending", "recoverable", "revision", "v", "worker"];
const LEASE_FIELDS = ["attempt", "epoch", "id", "kind", "mid", "sid", "until"];
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_REPLY_BYTES = 4096;
const MAX_ACTIVE_LEASES = 1;
const BRIDGE_CALL_MS = LIMITS.deliveryDeadlineMs;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys) {
  return object(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function checkedBindings(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError("Recipient bindings are invalid");
  const ids = new Set();
  for (const binding of value) {
    if (!exact(binding, ["authority", "epoch", "id", "sid", "worker"])
      || !ID.test(binding.id) || typeof binding.authority !== "string"
      || typeof binding.worker !== "string" || typeof binding.sid !== "string"
      || !Number.isSafeInteger(binding.epoch) || binding.epoch < 0 || ids.has(binding.id)) {
      throw new TypeError("Recipient binding is invalid");
    }
    ids.add(binding.id);
  }
  return value.map((binding) => ({ ...binding }));
}

function sessionDeadline(binding, value, now) {
  if (!exact(value, SESSION_FIELDS) || value.id !== binding.sid || value.worker !== binding.worker
    || value.epoch !== binding.epoch || value.ended !== null || !Number.isSafeInteger(value.until) || value.until <= now) {
    throw new Error("Relay session ownership could not be renewed");
  }
  return value.until;
}

function pendingView(binding, value) {
  if (!exact(value, PENDING_FIELDS) || value.v !== 1 || value.authority !== binding.authority
    || value.worker !== binding.worker || value.epoch !== binding.epoch || !/^[a-f0-9]{64}$/.test(value.revision)) {
    throw new Error("Relay pending summary did not match its binding");
  }
  for (const counts of [value.pending, value.recoverable]) {
    if (!exact(counts, ["msg", "work"]) || Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0)) {
      throw new Error("Relay pending counts are invalid");
    }
  }
  return { pending: value.pending, recoverable: value.recoverable, revision: value.revision };
}

function leaseView(binding, kind, value, now) {
  if (!["msg", "work"].includes(kind) || !exact(value, [...LEASE_FIELDS, kind])
    || !ID.test(value.id) || !ID.test(value.mid) || value.sid !== binding.sid || value.epoch !== binding.epoch
    || value.kind !== kind || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || !Number.isSafeInteger(value.until) || value.until <= now) throw new Error("Relay returned an invalid addressed lease");
  let envelope;
  try { envelope = validateEnvelope({ [kind]: value[kind] }); }
  catch (error) { throw new Error("Relay returned a malformed addressed message", { cause: error }); }
  return { id: value.id, mid: value.mid, sid: value.sid, epoch: value.epoch, until: value.until,
    attempt: value.attempt, kind, message: { [kind]: envelope.data[kind] } };
}

function nextAt(until, now) {
  const remaining = until - now;
  if (remaining <= 0) throw new Error("Relay ownership expired");
  return now + Math.max(1, Math.floor(remaining / 3));
}

function settlementReceipt(value, lease, outcome) {
  return exact(value, ["epoch", "lease", "mid", "outcome", "sid", "time"])
    && value.lease === lease.id && value.mid === lease.mid && value.sid === lease.binding.sid
    && value.epoch === lease.binding.epoch && value.outcome === outcome && Number.isSafeInteger(value.time);
}

export function createRecipientSession({ relayRoot, bindings: initialBindings, bridge, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  if (typeof relayRoot !== "string" || !relayRoot || relayRoot.includes("\0") || typeof now !== "function"
    || typeof schedule !== "function" || typeof cancel !== "function") throw new TypeError("Recipient session options are invalid");
  let bindings = checkedBindings(initialBindings);
  const send = bridge ?? ((request, signal) => callOpenCodeBridge(relayRoot, "delivery.recipient", request, signal));
  if (typeof send !== "function") throw new TypeError("Recipient bridge is invalid");
  const sessions = new Map();
  const leases = new Map();
  let serial = Promise.resolve();
  let timer = null;
  let started = false;
  let closing = false;
  let lost = false;
  let uncertain = false;
  let claimsThisActivation = 0;
  let closePromise;
  const sessionAbort = new AbortController();

  const enqueue = (task) => {
    const result = serial.then(task, task);
    serial = result.then(() => undefined, () => undefined);
    return result;
  };

  function stopTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function loseOwnership() {
    lost = true;
    stopTimer();
  }

  async function sendBounded(request, callerSignal, { bindToSession = true } = {}) {
    const controller = new AbortController();
    let rejectCancelled;
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    let timer = null;
    let settled = false;
    const abort = (reason) => {
      if (settled) return;
      const error = reason instanceof Error ? reason : new Error("Relay recipient bridge call was cancelled");
      controller.abort(error);
      rejectCancelled(error);
    };
    const onSessionAbort = () => abort(sessionAbort.signal.reason ?? new Error("Relay recipient session is closing"));
    const onCallerAbort = () => abort(callerSignal.reason ?? new Error("Relay recipient call was cancelled"));
    if (bindToSession) {
      sessionAbort.signal.addEventListener("abort", onSessionAbort, { once: true });
      if (sessionAbort.signal.aborted) onSessionAbort();
    }
    if (callerSignal) {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      if (callerSignal.aborted) onCallerAbort();
    }
    timer = schedule(() => abort(new Error("Relay recipient bridge call timed out")), BRIDGE_CALL_MS);
    timer?.unref?.();
    const operation = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return send(request, controller.signal);
    });
    // A bridge may ignore AbortSignal. Observe its eventual settlement so that
    // the bounded caller does not create an unhandled rejection or reuse a late
    // mutating result after ownership has already been lost.
    operation.catch(() => {});
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      settled = true;
      if (timer !== null) cancel(timer);
      if (bindToSession) sessionAbort.signal.removeEventListener("abort", onSessionAbort);
      if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }

  async function call(binding, op, args, signal) {
    if (lost) throw new Error("Relay ownership is lost; recipient processing is stopped");
    try {
      return await sendBounded({ bindingId: binding.id, op, args }, signal);
    } catch (error) {
      if (["claim", "reply", "ack", "release"].includes(op)) uncertain = true;
      loseOwnership();
      throw new Error("Relay recipient call failed; local processing is stopped", { cause: error });
    }
  }

  async function renew(binding) {
    const value = await call(binding, "renew", {});
    let until;
    try {
      until = sessionDeadline(binding, value, now());
    } catch (error) {
      loseOwnership();
      throw error;
    }
    sessions.set(binding.id, { binding, until, next: nextAt(until, now()) });
  }

  async function touch(lease) {
    const value = await call(lease.binding, "touch", { lease: lease.id });
    let updated;
    try {
      updated = leaseView(lease.binding, lease.kind, value, now());
    } catch (error) {
      uncertain = true;
      loseOwnership();
      throw error;
    }
    if (updated.id !== lease.id || updated.mid !== lease.mid || updated.attempt !== lease.attempt) {
      uncertain = true;
      loseOwnership();
      throw new Error("Relay lease ownership changed");
    }
    lease.until = updated.until;
    lease.next = nextAt(updated.until, now());
  }

  function scheduleMaintenance() {
    stopTimer();
    if (!started || closing || lost) return;
    const due = [...sessions.values(), ...leases.values()].map((item) => item.next);
    if (due.length === 0) return;
    timer = schedule(() => {
      timer = null;
      void enqueue(async () => {
        if (closing || lost) return;
        const current = now();
        for (const lease of [...leases.values()]) if (lease.next <= now()) await touch(lease);
        for (const state of [...sessions.values()]) if (state.next <= current) await renew(state.binding);
        scheduleMaintenance();
      }).catch(() => {});
    }, Math.max(0, Math.min(...due) - now()));
    timer?.unref?.();
  }

  async function start() {
    if (started || closing) throw new Error("Recipient session cannot be started");
    await enqueue(async () => {
      for (const binding of bindings) await renew(binding);
      started = true;
      scheduleMaintenance();
    });
  }

  async function readPending(signal) {
    const result = [];
    for (const binding of bindings) {
      try {
        result.push(pendingView(binding, await call(binding, "pending", {}, signal)));
      } catch (error) {
        if (!lost) loseOwnership();
        throw error;
      }
    }
    return result;
  }

  async function claim(kind, signal) {
    if (!started || claimsThisActivation >= 1 || leases.size >= MAX_ACTIVE_LEASES) {
      throw new Error("A Relay claim is already active or this activation reached its claim limit");
    }
    claimsThisActivation++;
    for (const binding of bindings) {
      const value = await call(binding, "claim", { kind }, signal);
      if (value === null) continue;
      let lease;
      try {
        lease = leaseView(binding, kind, value, now());
      } catch (error) {
        uncertain = true;
        loseOwnership();
        throw error;
      }
      const saved = { ...lease, binding, next: nextAt(lease.until, now()), replied: false };
      if (leases.has(saved.id)) {
        uncertain = true;
        loseOwnership();
        throw new Error("Relay returned a duplicate lease");
      }
      leases.set(saved.id, saved);
      scheduleMaintenance();
      return { lease: saved.id, kind: saved.kind, message: saved.message };
    }
    scheduleMaintenance();
    return null;
  }

  function activeLease(id) {
    const lease = leases.get(id);
    if (!lease) throw new Error("This native session does not own the Relay lease");
    const session = sessions.get(lease.binding.id);
    if (!session || session.until <= now() || lease.until <= now()) {
      uncertain = true;
      loseOwnership();
      throw new Error("Relay session or lease ownership expired");
    }
    return lease;
  }

  async function reply(input, signal) {
    const lease = activeLease(input.lease);
    if (lease.kind !== "msg") throw new Error("Relay replies require an addressed message claim");
    if (lease.replied) throw new Error("A reply was already accepted for this lease");
    if (typeof input.msg !== "string" || !input.msg || Buffer.byteLength(input.msg, "utf8") > MAX_REPLY_BYTES) throw new TypeError("Relay reply is invalid or too large");
    const key = `relay-reply-${createHash("sha256").update(JSON.stringify([lease.binding.authority, lease.binding.worker, lease.binding.sid, lease.id, input.msg])).digest("hex")}`;
    const result = await call(lease.binding, "reply", { lease: lease.id, msg: input.msg, key }, signal);
    if (!exact(result, ["id", "init", "repeat"]) || !ID.test(result.id) || !Number.isSafeInteger(result.init) || typeof result.repeat !== "boolean") {
      uncertain = true;
      loseOwnership();
      throw new Error("Relay reply result is invalid");
    }
    lease.replied = true;
    return { sent: true };
  }

  async function settle(op, input, signal) {
    const lease = activeLease(input.lease);
    const args = op === "ack" ? { lease: lease.id, outcome: input.outcome } : { lease: lease.id };
    const result = await call(lease.binding, op, args, signal);
    const outcome = op === "ack" ? input.outcome : "released";
    if (!settlementReceipt(result, lease, outcome)) {
      uncertain = true;
      loseOwnership();
      throw new Error("Relay settlement result is invalid");
    }
    leases.delete(lease.id);
    scheduleMaintenance();
    return op === "ack" ? { acknowledged: true, outcome: input.outcome } : { released: true };
  }

  function invoke(op, input, signal) {
    return enqueue(async () => {
      if (!started || closing || lost) throw new Error("Relay ownership is unavailable; recipient processing is stopped");
      if (signal?.aborted) throw signal.reason ?? new Error("Native tool call was cancelled");
      if (op === "pending") return readPending(signal);
      if (op === "claim") return claim(input.kind, signal);
      if (op === "reply") return reply(input, signal);
      if (op === "ack" || op === "release") return settle(op, input, signal);
      throw new TypeError("Unsupported Relay recipient operation");
    });
  }

  function activationEnded() {
    return enqueue(() => { if (!closing && !lost) claimsThisActivation = 0; });
  }

  function rebind(nextBindings) {
    return enqueue(async () => {
      const next = checkedBindings(nextBindings);
      const previous = new Map(bindings.map((binding) => [binding.id, binding]));
      if (next.length !== bindings.length || next.some((binding) => {
        const old = [...previous.values()].find((item) => item.authority === binding.authority && item.worker === binding.worker && item.sid === binding.sid && item.epoch === binding.epoch);
        return !old;
      })) throw new Error("Recipient rebind changed the pinned identity");
      bindings = next;
      if (uncertain || closing) return false;
      lost = false;
      sessions.clear();
      for (const binding of bindings) await renew(binding);
      for (const lease of leases.values()) {
        const replacement = bindings.find((binding) => binding.authority === lease.binding.authority && binding.worker === lease.binding.worker && binding.sid === lease.binding.sid && binding.epoch === lease.binding.epoch);
        if (!replacement) throw new Error("Active Relay lease lost its pinned binding");
        lease.binding = replacement;
        await touch(lease);
      }
      scheduleMaintenance();
      return true;
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    stopTimer();
    sessionAbort.abort(new Error("Relay recipient session is closing"));
    closePromise = (async () => {
      await serial;
      if (!lost) {
        for (const lease of [...leases.values()]) {
          try {
            const result = await sendBounded({ bindingId: lease.binding.id, op: "release", args: { lease: lease.id } }, undefined, { bindToSession: false });
            if (!settlementReceipt(result, lease, "released")) {
              uncertain = true;
              loseOwnership();
              break;
            }
            leases.delete(lease.id);
          } catch {
            uncertain = true;
            loseOwnership();
            break;
          }
        }
      }
      leases.clear();
      sessions.clear();
    })();
    return closePromise;
  }

  return Object.freeze({ start, invoke, activationEnded, rebind, close, get state() {
    return Object.freeze({ started, lost, uncertain, activeLeases: leases.size });
  } });
}

const leaseSchema = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" };

function exactInput(value, keys) {
  return exact(value, keys);
}

export function recipientTools(recipient, nativeSession) {
  const definitions = [
    { name: `${TOOL_PREFIX}pending`, op: "pending", description: "Read addressed Relay message and work counts.", input: { type: "object", properties: {}, required: [], additionalProperties: false } },
    { name: `${TOOL_PREFIX}claim`, op: "claim", description: "Claim one addressed Relay message or work item.", input: { type: "object", properties: { kind: { type: "string", enum: ["msg", "work"] } }, required: ["kind"], additionalProperties: false } },
    { name: `${TOOL_PREFIX}reply`, op: "reply", description: "Reply to the sender of an addressed Relay message.", input: { type: "object", properties: { lease: leaseSchema, msg: { type: "string", minLength: 1, maxLength: MAX_REPLY_BYTES } }, required: ["lease", "msg"], additionalProperties: false } },
    { name: `${TOOL_PREFIX}ack`, op: "ack", description: "Acknowledge an addressed Relay item with an explicit outcome.", input: { type: "object", properties: { lease: leaseSchema, outcome: { type: "string", enum: ["done", "failed", "rejected"] } }, required: ["lease", "outcome"], additionalProperties: false } },
    { name: `${TOOL_PREFIX}release`, op: "release", description: "Release an addressed Relay item for another attempt.", input: { type: "object", properties: { lease: leaseSchema }, required: ["lease"], additionalProperties: false } },
  ];
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    input: definition.input,
    options: { permission: definition.name, codemode: false },
    execute: async (input, context) => {
      const keys = definition.op === "pending" ? [] : definition.op === "claim" ? ["kind"]
        : definition.op === "reply" ? ["lease", "msg"] : definition.op === "ack" ? ["lease", "outcome"] : ["lease"];
      if (context?.sessionID !== nativeSession || !(context.signal instanceof AbortSignal) || context.signal.aborted
        || !exactInput(input, keys)) throw new Error("Relay recipient tool invocation refused");
      const args = { ...input };
      const result = await recipient.invoke(definition.op, args, context.signal);
      return { content: JSON.stringify(result) };
    },
  }));
}
