import { createHash } from "node:crypto";
import { Fault } from "./fault.mjs";
import { LIMITS, validateAddress, validateEnvelope, validateKey } from "./validate.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every((key) => typeof key === "string") &&
  JSON.stringify(Reflect.ownKeys(value).sort()) === JSON.stringify([...keys].sort());
const fail = (code, message) => {
  throw new Fault(code, message);
};
const ambiguous = (error) =>
  !(error instanceof Fault) ||
  ["timeout", "unavailable", "protocol", "uncertain", "tls"].includes(error.code);
const definiteLoss = (error) =>
  error instanceof Fault && ["session", "expired", "lease"].includes(error.code);

function validateLease(value, binding, kind) {
  const keys = ["attempt", "epoch", "id", "kind", "mid", "sid", "until", kind];
  if (
    !exact(value, keys) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 128 ||
    typeof value.mid !== "string" ||
    value.mid.length < 1 ||
    value.mid.length > 128 ||
    value.sid !== binding.sid ||
    value.epoch !== binding.epoch ||
    !Number.isSafeInteger(value.until) ||
    value.until < 0 ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    value.kind !== kind
  ) {
    throw new Fault("protocol", "Recipient lease does not match its binding");
  }
  validateEnvelope({ [kind]: value[kind] });
  return Object.freeze({
    id: value.id,
    mid: value.mid,
    sid: value.sid,
    epoch: value.epoch,
    until: value.until,
    attempt: value.attempt,
    kind,
  });
}

function validateSession(value, binding) {
  if (
    !exact(value, ["id", "worker", "epoch", "until", "ended"]) ||
    value.id !== binding.sid ||
    value.worker !== binding.worker ||
    value.epoch !== binding.epoch ||
    !Number.isSafeInteger(value.until) ||
    value.until < 0 ||
    value.ended !== null
  ) {
    throw new Fault("protocol", "Renewed recipient session does not match its binding");
  }
  return value;
}

function validatePending(value, binding) {
  if (
    !exact(value, ["v", "authority", "worker", "epoch", "revision", "pending", "recoverable"]) ||
    value.v !== 1 ||
    value.authority !== binding.authority ||
    value.worker !== binding.worker ||
    value.epoch !== binding.epoch ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.revision)
  ) {
    throw new Fault("protocol", "Recipient summary does not match its binding");
  }
  for (const counts of [value.pending, value.recoverable]) {
    if (
      !exact(counts, ["msg", "work"]) ||
      Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0)
    ) {
      throw new Fault("protocol", "Recipient summary counts are invalid");
    }
  }
  return value;
}

function validateMessage(value, lease, binding) {
  const keys = [
    "acked",
    "board",
    "from",
    "id",
    "init",
    "kind",
    "needs",
    "seq",
    "series",
    "state",
    "to",
  ];
  if (
    !exact(value, keys) ||
    value.id !== lease.mid ||
    value.kind !== lease.kind ||
    value.state !== "claimed" ||
    value.board !== null ||
    value.to !== binding.worker ||
    typeof value.from !== "string" ||
    !Array.isArray(value.needs) ||
    value.needs.length > LIMITS.needsMax ||
    value.needs.some((item) => typeof item !== "string") ||
    !Number.isSafeInteger(value.seq) ||
    !Number.isSafeInteger(value.init) ||
    value.init < 0 ||
    value.acked !== null ||
    (value.series !== null && typeof value.series !== "string")
  ) {
    throw new Fault("protocol", "Claimed message metadata is invalid");
  }
  validateAddress(value.from);
  return value;
}

function validateAdmission(value) {
  if (
    !exact(value, ["id", "repeat", "init"]) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 128 ||
    typeof value.repeat !== "boolean" ||
    !Number.isSafeInteger(value.init) ||
    value.init < 0
  ) {
    throw new Fault("protocol", "Reply admission is invalid");
  }
  return value;
}

function existingReply(tracked, signature) {
  const entry = tracked.reply;
  if (!entry) return null;
  if (entry.signature !== signature)
    fail("key_conflict", "Lease reply key was reused for different content");
  if (entry.state === "accepted") return { result: entry.result, promise: null };
  if (entry.state === "uncertain") fail("uncertain", "Reply admission outcome is unresolved");
  if (entry.promise) return { result: null, promise: entry.promise };
  return null;
}

/** Create the authority-pinned recipient surface owned by one delivery binding. */
export function createRecipientHandle({
  binding,
  api,
  isCurrent,
  readPending,
  replyKeys = new Map(),
}) {
  if (
    !binding ||
    !api ||
    api.authority !== binding.authority ||
    typeof isCurrent !== "function" ||
    typeof readPending !== "function" ||
    !(replyKeys instanceof Map)
  ) {
    fail("input", "Recipient handle dependencies are invalid");
  }

  let closed = false;
  let uncertainClaim = false;
  let claimInFlight = false;
  let activeMutations = 0;
  let cancelResolve;
  const cancelled = new Promise((resolve) => {
    cancelResolve = resolve;
  });
  const claims = new Map();
  const uncertainSettlements = new Set();

  function current() {
    return !closed && isCurrent(binding);
  }

  function assertCurrent() {
    if (!current()) fail("owner", "Recipient binding generation is stale");
  }

  function assertCanClaim() {
    assertCurrent();
    if (claimInFlight || uncertainClaim || uncertainSettlements.size)
      fail("uncertain", "A prior recipient claim or settlement is unresolved");
    if (claims.size >= LIMITS.deliveryBindingsMax) fail("full", "Recipient lease tracking is full");
  }

  function trackLateClaim(value, kind) {
    if (value === null) return;
    try {
      const lease = validateLease(value, binding, kind);
      claims.set(lease.id, { lease, state: "uncertain", busy: false, reply: null });
      uncertainSettlements.add(lease.id);
    } catch {
      markUncertainClaim();
    }
  }

  function markUncertainClaim() {
    uncertainClaim = true;
  }

  function noteLateOutcome(value, mutating, onLate) {
    if (!current() && mutating) onLate?.(value);
  }

  function releaseMutation(mutating) {
    if (mutating) activeMutations--;
  }

  function markUncertainMutation(mutating) {
    if (mutating) uncertainClaim = true;
  }

  function unsettledOutcome(error) {
    return ambiguous(error) || !current();
  }

  async function invokeApi(fn, { mutating = false, onLate } = {}) {
    assertCurrent();
    const operation = Promise.resolve().then(() => {
      assertCurrent();
      return fn();
    });
    const outcome = operation.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    if (mutating) activeMutations++;
    outcome
      .then(({ value }) => noteLateOutcome(value, mutating, onLate))
      .finally(() => releaseMutation(mutating))
      .catch(() => {});
    const result = await Promise.race([outcome, cancelled.then(() => ({ cancelled: true }))]);
    if (result.cancelled) {
      markUncertainMutation(mutating);
      fail("owner", "Recipient operation was cancelled with an unresolved outcome");
    }
    if (result.error) throw result.error;
    if (!current()) {
      markUncertainMutation(mutating);
      fail("owner", "Recipient binding changed during an operation");
    }
    return result.value;
  }

  function trackedLease(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 128)
      fail("input", "Recipient lease identity is invalid");
    const tracked = claims.get(value);
    if (!tracked) fail("lease", "Lease was not claimed by this binding");
    if (tracked.state === "uncertain" || uncertainSettlements.has(value))
      fail("uncertain", "Recipient lease outcome is unresolved");
    return tracked;
  }

  function reserveReplyKey(key, lease, message) {
    const scopedKey = createHash("sha256")
      .update(JSON.stringify([binding.authority, binding.worker, key]))
      .digest("hex");
    const signature = createHash("sha256")
      .update(JSON.stringify([lease.mid, message]))
      .digest("hex");
    const prior = replyKeys.get(scopedKey);
    if (prior !== undefined && prior !== signature)
      fail("key_conflict", "Reply key belongs to another claimed message or reply");
    if (prior === undefined && replyKeys.size >= LIMITS.deliveryRows)
      fail("full", "Recipient reply key tracking is full");
    replyKeys.set(scopedKey, signature);
  }

  function assertClaimArguments(args) {
    if (!exact(args, ["kind"]) || !["msg", "work"].includes(args.kind))
      fail("input", "Addressed claim arguments are invalid");
  }

  async function assertClaimSession() {
    const summary = validatePending(await invokeApi(readPending), binding);
    if (summary.worker !== binding.worker || summary.epoch !== binding.epoch)
      fail("session", "Recipient session no longer matches its binding");
  }

  function adoptClaim(value, kind) {
    let lease;
    try {
      lease = validateLease(value, binding, kind);
    } catch (error) {
      markUncertainClaim();
      throw error;
    }
    claims.set(lease.id, { lease, state: "live", busy: false, reply: null });
    if (!current()) {
      uncertainSettlements.add(lease.id);
      markUncertainClaim();
      fail("owner", "Recipient binding changed after claim");
    }
    return value;
  }

  async function claim(args) {
    assertClaimArguments(args);
    assertCanClaim();
    claimInFlight = true;
    let dispatched = false;
    try {
      await assertClaimSession();
      dispatched = true;
      const value = await invokeApi(() => api.claim(binding.sid, { kind: args.kind }), {
        mutating: true,
        onLate: (late) => trackLateClaim(late, args.kind),
      });
      if (value === null) return null;
      return adoptClaim(value, args.kind);
    } catch (error) {
      if (dispatched && unsettledOutcome(error)) markUncertainClaim();
      throw error;
    } finally {
      claimInFlight = false;
    }
  }

  async function renew(args) {
    if (!exact(args, [])) fail("input", "Renew arguments are invalid");
    const value = await invokeApi(() => api.renew(binding.sid), { mutating: true });
    return validateSession(value, binding);
  }

  async function pending(args) {
    if (!exact(args, [])) fail("input", "Pending arguments are invalid");
    return validatePending(await invokeApi(readPending), binding);
  }

  async function touchOwned(tracked, leaseId) {
    const value = await invokeApi(() => api.touch(binding.sid, tracked.lease.id), {
      mutating: true,
      onLate: () => uncertainSettlements.add(leaseId),
    });
    const lease = validateLease(value, binding, tracked.lease.kind);
    if (
      lease.id !== tracked.lease.id ||
      lease.mid !== tracked.lease.mid ||
      lease.attempt !== tracked.lease.attempt
    ) {
      tracked.state = "uncertain";
      uncertainSettlements.add(leaseId);
      fail("protocol", "Touched lease identity changed");
    }
    tracked.lease = lease;
    return value;
  }

  function recordLeaseFailure(value, tracked, error) {
    if (unsettledOutcome(error)) {
      tracked.state = "uncertain";
      uncertainSettlements.add(value);
    } else if (definiteLoss(error)) {
      claims.delete(value);
      uncertainSettlements.delete(value);
    }
  }

  async function withLease(value, action, apply) {
    const tracked = trackedLease(value);
    if (tracked.busy) fail("active", "Recipient lease already has an operation in flight");
    tracked.busy = true;
    try {
      const result = await action(tracked);
      apply(tracked, result);
      return result;
    } catch (error) {
      recordLeaseFailure(value, tracked, error);
      throw error;
    } finally {
      tracked.busy = false;
    }
  }

  async function touch(args) {
    if (!exact(args, ["lease"])) fail("input", "Touch arguments are invalid");
    const result = await withLease(
      args.lease,
      (tracked) =>
        invokeApi(() => api.touch(binding.sid, tracked.lease.id), {
          mutating: true,
          onLate: () => {
            trackedLease(args.lease).state = "uncertain";
          },
        }),
      (tracked, value) => {
        const lease = validateLease(value, binding, tracked.lease.kind);
        if (
          lease.id !== tracked.lease.id ||
          lease.mid !== tracked.lease.mid ||
          lease.attempt !== tracked.lease.attempt
        )
          fail("protocol", "Touched lease identity changed");
        tracked.lease = lease;
      },
    );
    return result;
  }

  async function ack(args) {
    if (
      !exact(args, ["lease", "outcome"]) ||
      !["done", "failed", "rejected"].includes(args.outcome)
    )
      fail("input", "Acknowledgement arguments are invalid");
    const result = await withLease(
      args.lease,
      (tracked) =>
        invokeApi(() => api.ack(binding.sid, tracked.lease.id, args.outcome), {
          mutating: true,
          onLate: () => uncertainSettlements.add(args.lease),
        }),
      (tracked, receipt) => {
        if (
          !exact(receipt, ["mid", "lease", "sid", "epoch", "outcome", "time"]) ||
          receipt.mid !== tracked.lease.mid ||
          receipt.lease !== tracked.lease.id ||
          receipt.sid !== binding.sid ||
          receipt.epoch !== binding.epoch ||
          receipt.outcome !== args.outcome ||
          !Number.isSafeInteger(receipt.time) ||
          receipt.time < 0
        ) {
          tracked.state = "uncertain";
          uncertainSettlements.add(args.lease);
          fail("protocol", "Acknowledgement receipt does not match its lease");
        }
        claims.delete(args.lease);
        uncertainSettlements.delete(args.lease);
      },
    );
    return result;
  }

  async function release(args) {
    if (!exact(args, ["lease"])) fail("input", "Release arguments are invalid");
    const result = await withLease(
      args.lease,
      (tracked) =>
        invokeApi(() => api.release(binding.sid, tracked.lease.id), {
          mutating: true,
          onLate: () => uncertainSettlements.add(args.lease),
        }),
      (tracked, receipt) => {
        if (
          !exact(receipt, ["mid", "lease", "sid", "epoch", "outcome", "time"]) ||
          receipt.mid !== tracked.lease.mid ||
          receipt.lease !== tracked.lease.id ||
          receipt.sid !== binding.sid ||
          receipt.epoch !== binding.epoch ||
          receipt.outcome !== "released" ||
          !Number.isSafeInteger(receipt.time) ||
          receipt.time < 0
        ) {
          tracked.state = "uncertain";
          uncertainSettlements.add(args.lease);
          fail("protocol", "Release receipt does not match its lease");
        }
        claims.delete(args.lease);
        uncertainSettlements.delete(args.lease);
      },
    );
    return result;
  }

  function prepareReply(args) {
    if (!exact(args, ["key", "lease", "msg"]) || typeof args.msg !== "string")
      fail("input", "Reply arguments are invalid");
    const key = validateKey(args.key);
    validateEnvelope({ msg: args.msg });
    const tracked = trackedLease(args.lease);
    const signature = JSON.stringify([key, args.msg]);
    return { key, lease: args.lease, msg: args.msg, signature, tracked };
  }

  function recordReplyFailure(tracked, entry, leaseId, error) {
    if (unsettledOutcome(error)) {
      entry.state = "uncertain";
      tracked.state = "uncertain";
      uncertainSettlements.add(leaseId);
    } else if (definiteLoss(error)) {
      claims.delete(leaseId);
      uncertainSettlements.delete(leaseId);
      entry.state = "failed";
    } else entry.state = "failed";
  }

  async function deliverReply(tracked, entry, request) {
    try {
      await touchOwned(tracked, request.lease);
      const metadata = await invokeApi(() => api.get(tracked.lease.mid, {}));
      const message = validateMessage(metadata, tracked.lease, binding);
      await touchOwned(tracked, request.lease);
      const admission = await invokeApi(
        () => api.send(binding.sid, message.from, { msg: request.msg }, { key: request.key }),
        {
          mutating: true,
          onLate: () => uncertainSettlements.add(request.lease),
        },
      );
      const result = validateAdmission(admission);
      entry.state = "accepted";
      entry.result = result;
      return result;
    } catch (error) {
      recordReplyFailure(tracked, entry, request.lease, error);
      throw error;
    } finally {
      entry.promise = null;
      tracked.busy = false;
    }
  }

  async function reply(args) {
    const request = prepareReply(args);
    const tracked = request.tracked;
    const existing = existingReply(tracked, request.signature);
    if (existing) {
      if (existing.promise) {
        const admitted = await existing.promise;
        return admitted;
      }
      return existing.result;
    }
    if (tracked.busy) fail("active", "Recipient lease already has an operation in flight");
    reserveReplyKey(request.key, tracked.lease, request.msg);
    tracked.busy = true;
    const entry = {
      signature: request.signature,
      state: "pending",
      promise: null,
      result: null,
    };
    tracked.reply = entry;
    entry.promise = deliverReply(tracked, entry, request);
    const admitted = await entry.promise;
    return admitted;
  }

  const operations = new Map([
    ["pending", pending],
    ["renew", renew],
    ["claim", claim],
    ["touch", touch],
    ["ack", ack],
    ["release", release],
    ["reply", reply],
  ]);

  async function recipient(op, args) {
    assertCurrent();
    const operation = operations.get(op);
    if (!operation) fail("input", "Recipient operation is unsupported");
    const result = await operation(args);
    return result;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (activeMutations) uncertainClaim = true;
    cancelResolve();
  }

  return Object.freeze({ recipient, close });
}
