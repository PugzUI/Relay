import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Fault } from "./fault.mjs";
import { formatDeliveryNotice } from "./delivery-notice.mjs";
import { createRecipientHandle } from "./recipient.mjs";
import {
  bindDeliverySession,
  deliveryStatus,
  deliveryTargetDigest,
  endDeliveryBinding,
  listDeliveryAttempts,
  listDeliveryBindings,
  releaseDeliveryOwner,
  relayRoot,
  reserveDeliveryAttempt,
  transitionDeliveryAttempt,
} from "./relay.mjs";
import { DELIVERY_CLIENTS, LIMITS, validateAddress } from "./validate.mjs";

export { DELIVERY_CLIENTS } from "./validate.mjs";

const supervisors = new Map();

const ADAPTER_PATHS = Object.freeze({
  codex: "./adapters/codex.mjs",
  cursor: "./adapters/cursor.mjs",
  omp: "./adapters/omp.mjs",
  antigravity: "./adapters/antigravity.mjs",
  hermes: "./adapters/hermes.mjs",
  zed: "./adapters/zed.mjs",
  zcode: "./adapters/zcode.mjs",
  opencode: "./adapters/opencode.mjs",
  kilo: "./adapters/kilo.mjs",
  cline: "./adapters/cline.mjs",
});
const TERMINAL = new Set(["safe_idle", "refused", "reconciled"]);
const UNRESOLVED = new Set([
  "reserved",
  "submitting",
  "admitted",
  "context_observed",
  "turn_started",
  "held",
  "uncertain",
]);
const OBSERVATIONS = new Set(["context_observed", "turn_started", "safe_idle", "held", "refused"]);
const REASONS = new Set([
  "auth-revoked",
  "binding-stale",
  "capacity-full",
  "cancelled",
  "deadline-elapsed",
  "native-held",
  "native-refused",
  "native-timeout",
  "native-unavailable",
  "native-unsupported",
  "observed",
  "operator-confirmed",
  "owner-recovery",
  "retry-exhausted",
  "submission-uncertain",
  "target-owned",
]);
const HUB_PENDING_PER_MINUTE = 20;
const HUB_PENDING_MIN_INTERVAL_MS = 3000;
const HUB_CACHE_MAX = LIMITS.deliveryBindingsMax;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code, message) => {
  throw new Fault(code, message);
};
const exact = (value, keys) => {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return false;
  const own = Reflect.ownKeys(value);
  return (
    own.every((key) => typeof key === "string") &&
    JSON.stringify(own.sort()) === JSON.stringify([...keys].sort())
  );
};
const refOf = (binding) => ({ binding: binding.id, generation: binding.generation });
const nonzero = (counts) => counts.msg > 0 || counts.work > 0;
const hasPending = (summary) => nonzero(summary.pending) || nonzero(summary.recoverable);

function validateClients(clients) {
  if (
    !Array.isArray(clients) ||
    clients.length > DELIVERY_CLIENTS.length ||
    new Set(clients).size !== clients.length ||
    clients.some((client) => !DELIVERY_CLIENTS.includes(client))
  )
    fail("input", "Delivery client selection is invalid");
  return [...clients];
}

async function loadAdapter(client) {
  const path = new URL(ADAPTER_PATHS[client], import.meta.url);
  try {
    await access(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Fault("unavailable", "Delivery adapter cannot be inspected");
  }
  const adapter = await import(path.href);
  if (
    adapter.client !== client ||
    typeof adapter.startDeliveryAdapter !== "function" ||
    !object(adapter.capabilities) ||
    Object.keys(adapter.capabilities).sort().join(",") !== "context,idle,launch" ||
    Object.values(adapter.capabilities).some((value) => typeof value !== "boolean") ||
    !["pending", "wired", "unsupported"].includes(adapter.evidence)
  ) {
    throw new Fault("schema", "First-party delivery adapter contract is invalid");
  }
  return adapter;
}

/** Read adapter metadata without starting any native listener or consumer. */
export async function inspectDeliveryAdapters(clients) {
  const selected = validateClients(clients);
  const result = [];
  for (const client of selected) {
    const adapter = await loadAdapter(client);
    result.push(
      Object.freeze(
        adapter
          ? {
              client,
              evidence: adapter.evidence,
              capabilities: Object.freeze({ ...adapter.capabilities }),
            }
          : {
              client,
              evidence: "unsupported",
              capabilities: Object.freeze({ context: false, idle: false, launch: false }),
            },
      ),
    );
  }
  return result;
}

function validateCapabilities(value) {
  if (
    !exact(value, ["context", "idle", "launch"]) ||
    Object.values(value).some((item) => typeof item !== "boolean")
  )
    fail("input", "Delivery capabilities are invalid");
  return Object.freeze({ context: value.context, idle: value.idle, launch: value.launch });
}

function validateConsumer(consumer, capabilities) {
  if (!object(consumer) || ![Object.prototype, null].includes(Object.getPrototypeOf(consumer)))
    fail("input", "Native delivery consumer is required");
  const allowed = ["observe", "status", "submit"];
  if (Reflect.ownKeys(consumer).some((key) => typeof key !== "string" || !allowed.includes(key)))
    fail("input", "Native delivery consumer has unknown fields");
  for (const key of allowed)
    if (consumer[key] !== undefined && typeof consumer[key] !== "function")
      fail("input", "Native delivery consumer method is invalid");
  if (capabilities.idle && (!consumer.status || !consumer.submit || !consumer.observe))
    fail("input", "Idle delivery requires status, submit, and observation methods");
  return consumer;
}

function validateSummary(summary, binding) {
  if (
    !exact(summary, ["authority", "epoch", "pending", "recoverable", "revision", "v", "worker"]) ||
    summary.v !== 1 ||
    summary.authority !== binding.authority ||
    summary.worker !== binding.worker ||
    summary.epoch !== binding.epoch ||
    !/^[a-f0-9]{64}$/.test(summary.revision)
  )
    fail("protocol", "Recipient summary does not match its exact binding");
  for (const counts of [summary.pending, summary.recoverable]) {
    if (
      !exact(counts, ["msg", "work"]) ||
      Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0)
    )
      fail("protocol", "Recipient summary counts are invalid");
  }
  return summary;
}

function withDeadline(fn, controller, ms) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", aborted);
      callback(value);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(reject, new Fault("timeout", "Native delivery deadline elapsed"));
    }, ms);
    const aborted = () => finish(reject, new Fault("unavailable", "Native delivery was cancelled"));
    controller.signal.addEventListener("abort", aborted, { once: true });
    if (controller.signal.aborted) aborted();
    Promise.resolve()
      .then(fn)
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}

async function mapLimit(values, limit, fn) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await fn(values[index], index);
      }
    }),
  );
  return results;
}

function current(state, binding) {
  return !state.closed && state.bindings.get(binding.id) === binding && binding.active;
}

function recipientCurrent(state, binding) {
  if (!current(state, binding)) return false;
  try {
    const stored = listDeliveryBindings(state.local, state.ownerGeneration).find(
      (row) => row.id === binding.id,
    );
    return (
      stored?.state === "active" &&
      stored.generation === binding.generation &&
      stored.ownerGeneration === state.ownerGeneration &&
      stored.authority === binding.authority &&
      stored.worker === binding.worker &&
      stored.sid === binding.sid &&
      stored.epoch === binding.epoch
    );
  } catch {
    return false;
  }
}

function refsFor(state, targetDigest) {
  return [...state.bindings.values()]
    .filter((binding) => binding.active && binding.targetDigest === targetDigest)
    .map(refOf);
}

function activeTarget(state, binding) {
  if (!current(state, binding)) throw new Fault("owner", "Delivery binding generation is stale");
  const target = state.targets.get(binding.targetDigest);
  if (!target || target.consumer !== binding.consumer)
    throw new Fault("owner", "Native target binding is no longer current");
  return target;
}

async function withSlot(state, fn) {
  if (state.closed) throw new Fault("unavailable", "Delivery supervisor is closed");
  const acquired = await acquireSlot(state);
  try {
    if (state.closed) throw new Fault("unavailable", "Delivery supervisor is closed");
    return await fn();
  } finally {
    releaseSlot(state, acquired);
  }
}

async function acquireSlot(state) {
  if (state.activeCalls < LIMITS.deliveryNativeCalls) {
    state.activeCalls++;
    return true;
  }
  if (state.waiters.length >= LIMITS.deliveryBindings)
    throw new Fault("full", "Delivery call queue is full");
  await new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(new Fault("timeout", "Delivery call queue deadline elapsed"));
    }, LIMITS.deliveryDeadlineMs);
    state.waiters.push(waiter);
  });
  return true;
}

function releaseSlot(state, acquired) {
  if (!acquired) return;
  const next = state.waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
    return;
  }
  state.activeCalls--;
}

function hubApi(state, binding) {
  return binding.authority !== state.local.authority;
}

function hubReadAvailable(state) {
  const now = performance.now();
  state.hubReadTimes = state.hubReadTimes.filter((time) => now - time < 60_000);
  return (
    now >= state.hubNextReadAt &&
    now >= state.hubBackoffUntil &&
    state.hubReadTimes.length < HUB_PENDING_PER_MINUTE
  );
}

function cachedSummary(state, binding) {
  const cached = state.hubSummaryCache.get(binding.id);
  return cached
    ? { binding, summary: cached.summary, error: null, fresh: false }
    : { binding, summary: null, error: null, fresh: false };
}

function rememberHubSummary(state, binding, summary) {
  state.hubSummaryCache.delete(binding.id);
  state.hubSummaryCache.set(binding.id, { summary, receivedAt: performance.now() });
  while (state.hubSummaryCache.size > HUB_CACHE_MAX)
    state.hubSummaryCache.delete(state.hubSummaryCache.keys().next().value);
}

function noteHubFailure(state, error) {
  const code = error instanceof Fault ? error.code : "unavailable";
  if (!["rate", "unavailable", "timeout", "tls"].includes(code)) return;
  state.hubFailureCount = Math.min(state.hubFailureCount + 1, 8);
  const floor = code === "rate" ? 10_000 : 1000;
  const delay = Math.min(30_000, Math.max(floor, 500 * 2 ** (state.hubFailureCount - 1)));
  state.hubBackoffUntil = performance.now() + delay;
}

function nextHubBinding(state) {
  const bindings = [...state.bindings.values()].filter(
    (binding) => current(state, binding) && hubApi(state, binding),
  );
  if (!bindings.length) return null;
  const prior = bindings.findIndex((binding) => binding.id === state.hubCursor);
  return bindings[(prior + 1 + bindings.length) % bindings.length];
}

function authorityApi(state, authority) {
  if (authority === state.local.authority) return state.local;
  if (state.hub && state.hub.authority === authority) return state.hub;
  return null;
}

function reserveHubRead(state) {
  if (!hubReadAvailable(state))
    throw new Fault("rate", "Shared hub summary read budget is exhausted");
  const now = performance.now();
  state.hubReadTimes.push(now);
  state.hubNextReadAt = now + HUB_PENDING_MIN_INTERVAL_MS;
}

async function fetchSummary(state, binding, { scheduled = true } = {}) {
  const api = authorityApi(state, binding.authority);
  if (!api) throw new Fault("auth", "Delivery authority is not configured");
  const remote = api !== state.local;
  if (remote && scheduled) reserveHubRead(state);
  try {
    const summary = await withSlot(state, async () =>
      validateSummary(await api.pending(binding.sid), binding),
    );
    if (remote) {
      state.hubFailureCount = 0;
      state.hubBackoffUntil = 0;
      if (scheduled) rememberHubSummary(state, binding, summary);
    }
    return summary;
  } catch (error) {
    if (remote) noteHubFailure(state, error);
    throw error;
  }
}

async function summaryFor(state, binding, { scheduledHubId = null, explicit = false } = {}) {
  if (!hubApi(state, binding))
    return { binding, summary: await fetchSummary(state, binding), error: null, fresh: true };
  if (!explicit && binding.id !== scheduledHubId) return cachedSummary(state, binding);
  if (!hubReadAvailable(state)) return cachedSummary(state, binding);
  try {
    return { binding, summary: await fetchSummary(state, binding), error: null, fresh: true };
  } catch (error) {
    return { binding, summary: null, error, fresh: false };
  }
}

function classifySummaryFailure(value) {
  if (!(value.error instanceof Fault)) return "retry";
  if (["auth", "denied", "session"].includes(value.error.code)) return "unbind";
  if (["owner", "schema", "protocol"].includes(value.error.code)) return "fatal";
  return "retry";
}

async function summariesFor(state, target, options = {}) {
  const bindings = [...target.bindingIds]
    .map((id) => state.bindings.get(id))
    .filter((binding) => binding && current(state, binding));
  const values = await mapLimit(bindings, LIMITS.deliveryNativeCalls, async (binding) => {
    try {
      return await summaryFor(state, binding, options);
    } catch (error) {
      return { binding, summary: null, error };
    }
  });
  const available = [];
  for (const value of values) {
    if (value.summary) {
      available.push(value);
      continue;
    }
    const outcome = classifySummaryFailure(value);
    if (outcome === "fatal") throw value.error;
    if (outcome === "unbind") {
      state.tickFailures++;
      state.lastErrorCode = value.error.code;
      await unbind(state, value.binding);
      continue;
    }
    state.tickFailures++;
    state.lastErrorCode = value.error instanceof Fault ? value.error.code : "unavailable";
  }
  return available;
}

function priorRevisions(attempts) {
  const revisions = new Map();
  for (const attempt of attempts) {
    const accepted =
      ["admitted", "context_observed", "turn_started", "safe_idle"].includes(attempt.state) ||
      (attempt.state === "reconciled" && attempt.reconcileOutcome === "observed");
    if (!accepted) continue;
    for (const scope of attempt.scopes) {
      const seen = revisions.get(scope.binding) ?? new Set();
      seen.add(scope.revision);
      revisions.set(scope.binding, seen);
    }
  }
  return revisions;
}

function changedScopes(values, attempts) {
  const revisions = priorRevisions(attempts);
  const refusals = new Map();
  for (const attempt of attempts) {
    const notAccepted =
      attempt.state === "refused" ||
      (attempt.state === "reconciled" && attempt.reconcileOutcome === "not-accepted");
    if (!notAccepted) continue;
    for (const scope of attempt.scopes) {
      const key = `${scope.binding}:${scope.revision}`;
      const row = refusals.get(key) ?? { count: 0, changed: 0, latestId: null };
      row.count++;
      if (attempt.changed >= row.changed) {
        row.changed = attempt.changed;
        row.latestId = attempt.id;
      }
      refusals.set(key, row);
    }
  }
  const now = Date.now();
  return values.filter(({ binding, summary, fresh }) => {
    if (!fresh || !hasPending(summary) || revisions.get(binding.id)?.has(summary.revision))
      return false;
    const prior = refusals.get(`${binding.id}:${summary.revision}`);
    if (!prior) return true;
    if (prior.count > LIMITS.deliveryRetries) return false;
    const base = Math.min(
      LIMITS.deliveryRetryMaxMs,
      LIMITS.deliveryRetryMinMs * 2 ** (prior.count - 1),
    );
    const spread = Math.max(1, Math.min(base, LIMITS.deliveryRetryMaxMs - base + 1));
    const seed = Number.parseInt(prior.latestId?.slice(-8) ?? "0", 16) || 0;
    const delay = base + (seed % spread);
    return now >= prior.changed + delay;
  });
}

function transition(state, attempt, from, to, refs, extra = {}) {
  return transitionDeliveryAttempt(state.local, {
    id: attempt.id,
    ownerGeneration: state.ownerGeneration,
    bindings: refs,
    from,
    to,
    ...extra,
  });
}

function expectedResultKeys(value) {
  if (!value.accepted) return ["accepted", "state"];
  return Object.hasOwn(value, "nativeRequestId") ? ["accepted", "nativeRequestId"] : ["accepted"];
}

function validateRequestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    throw new Fault("protocol", "Native request identity is invalid");
  return value;
}

function validateNativeResult(value) {
  if (!object(value) || typeof value.accepted !== "boolean")
    throw new Fault("protocol", "Native consumer result is invalid");
  if (!exact(value, expectedResultKeys(value)))
    throw new Fault("protocol", "Native consumer result has unknown fields");
  if (Object.hasOwn(value, "nativeRequestId")) validateRequestId(value.nativeRequestId);
  if (!value.accepted && !["held", "refused"].includes(value.state))
    throw new Fault("protocol", "Native refusal state is invalid");
  return value;
}

function validateObservation(value) {
  if (
    !object(value) ||
    (!OBSERVATIONS.has(value.state) && value.state !== "unknown") ||
    !exact(
      value,
      Object.hasOwn(value, "nativeRequestId") ? ["state", "nativeRequestId"] : ["state"],
    )
  )
    throw new Fault("protocol", "Native observation is invalid");
  if (
    value.nativeRequestId !== undefined &&
    (typeof value.nativeRequestId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(value.nativeRequestId))
  )
    throw new Fault("protocol", "Native request identity is invalid");
  return value;
}

function recordObservation(state, binding, attemptId, observation) {
  if (!current(state, binding)) return false;
  const attempt = listDeliveryAttempts(state.local, state.ownerGeneration).find(
    (row) => row.id === attemptId,
  );
  if (!attempt || attempt.targetDigest !== binding.targetDigest || TERMINAL.has(attempt.state))
    return false;
  const refs = refsFor(state, binding.targetDigest);
  if (!refs.length) return false;
  const value = validateObservation(
    typeof observation === "string" ? { state: observation } : observation,
  );
  if (
    attempt.nativeRequestId &&
    value.nativeRequestId &&
    attempt.nativeRequestId !== value.nativeRequestId
  )
    throw new Fault("protocol", "Native observation belongs to another request");
  return applyObservation(state, attempt, value, refs);
}

function observationRequest(attempt, observation) {
  const requestId = observation.nativeRequestId ?? attempt.nativeRequestId ?? undefined;
  return requestId ? { nativeRequestId: requestId } : {};
}

function applyRefusal(attempt, observation, cursor, move) {
  const reasonCode = observation.state === "held" ? "native-held" : "native-refused";
  if (
    observation.state === "refused" &&
    (attempt.admittedAt !== null ||
      ["admitted", "context_observed", "turn_started"].includes(cursor.state))
  ) {
    if (cursor.state !== "uncertain") move("uncertain", { reasonCode });
    else return false;
  } else if (cursor.state === "context_observed" || cursor.state === "turn_started") {
    move("uncertain", { reasonCode });
  } else if (UNRESOLVED.has(cursor.state)) move(observation.state, { reasonCode });
  else return false;
  return true;
}

function applyProgress(observation, cursor, move) {
  if (observation.state === "context_observed") {
    if (["admitted", "uncertain"].includes(cursor.state)) move("context_observed");
    else return false;
  } else if (observation.state === "turn_started") {
    if (cursor.state === "context_observed") move("turn_started");
    else return false;
  } else if (observation.state === "safe_idle") {
    if (cursor.state === "turn_started") move("safe_idle");
    else return false;
  }
  return true;
}

function applyObservation(state, attempt, observation, refs) {
  if (observation.state === "unknown") return false;
  const cursor = { state: attempt.state };
  const move = (to, extra = {}) => {
    transition(state, attempt, cursor.state, to, refs, {
      ...observationRequest(attempt, observation),
      ...extra,
    });
    cursor.state = to;
  };
  if (cursor.state === observation.state) return false;
  if (cursor.state === "held" && observation.state !== "held")
    move("uncertain", { reasonCode: "observed" });
  if (observation.state === "held" || observation.state === "refused")
    return applyRefusal(attempt, observation, cursor, move);
  if (cursor.state === "reserved") return false;
  if (
    cursor.state === "submitting" &&
    observation.state !== "held" &&
    observation.state !== "refused"
  )
    move("admitted");
  return applyProgress(observation, cursor, move);
}

function createTicket(state, binding, values, attempts) {
  const scopes = changedScopes(values, attempts);
  if (!scopes.length) return null;
  const formatted = formatDeliveryNotice(scopes);
  if (!formatted.text) return null;
  const notice = formatted.text;
  const bindings = formatted.scopes;
  const attemptId = `delivery-${randomUUID()}`;
  const saved = reserveDeliveryAttempt(state.local, {
    id: attemptId,
    ownerGeneration: state.ownerGeneration,
    bindings: bindings.map(({ binding, summary }) => ({
      binding: binding.id,
      generation: binding.generation,
      summary,
    })),
  });
  let attempt = listDeliveryAttempts(state.local, state.ownerGeneration).find(
    (row) => row.id === saved.id,
  );
  if (!attempt) throw new Fault("schema", "Persisted delivery attempt cannot be read");
  const refs = bindings.map(({ binding }) => refOf(binding));
  attempt = transition(state, attempt, "reserved", "submitting", refs);
  const handleBinding =
    bindings.find(({ binding: item }) => current(state, item))?.binding ?? binding;
  let admitted = false;
  let completed = false;
  return Object.freeze({
    attemptId,
    notice,
    admitted: (nativeRequestId) => {
      if (!current(state, handleBinding) || admitted || completed) return false;
      const extra = nativeRequestId === undefined ? {} : { nativeRequestId };
      const result = transition(
        state,
        attempt,
        "submitting",
        "admitted",
        refsFor(state, binding.targetDigest),
        extra,
      );
      admitted = true;
      return result;
    },
    observe: (observation) => {
      if (!current(state, handleBinding) || completed) return false;
      const result = recordObservation(state, handleBinding, attemptId, observation);
      if (result) {
        const latest = listDeliveryAttempts(state.local, state.ownerGeneration).find(
          (row) => row.id === attemptId,
        );
        if (latest && TERMINAL.has(latest.state)) completed = true;
      }
      return result;
    },
    hold: () => {
      if (!current(state, handleBinding) || admitted || completed) return false;
      return transition(
        state,
        attempt,
        "submitting",
        "held",
        refsFor(state, binding.targetDigest),
        { reasonCode: "native-held" },
      );
    },
    refuse: (reasonCode = "native-refused") => {
      if (!current(state, handleBinding) || admitted || completed) return false;
      if (!REASONS.has(reasonCode)) throw new Fault("input", "Delivery reason code is invalid");
      const result = transition(
        state,
        attempt,
        "submitting",
        "refused",
        refsFor(state, binding.targetDigest),
        { reasonCode },
      );
      completed = true;
      return result;
    },
  });
}

async function readNotice(state, binding) {
  const target = activeTarget(state, binding);
  const values = await summariesFor(state, target, { explicit: true });
  if (!values.some((value) => value.fresh)) return null;
  const attempts = listDeliveryAttempts(state.local, state.ownerGeneration);
  if (
    attempts.some(
      (attempt) => attempt.targetDigest === binding.targetDigest && UNRESOLVED.has(attempt.state),
    )
  )
    return null;
  return createTicket(state, binding, values, attempts);
}

async function invokeNative(state, binding, method, input) {
  if (state.closed || !current(state, binding))
    throw new Fault("owner", "Native delivery binding is stale");
  return await withSlot(state, async () => {
    const controller = new AbortController();
    state.controllers.add(controller);
    const abort = () => controller.abort();
    state.abort.signal.addEventListener("abort", abort, { once: true });
    if (state.abort.signal.aborted) controller.abort();
    try {
      return await withDeadline(
        () => method({ ...input, signal: controller.signal }),
        controller,
        LIMITS.deliveryDeadlineMs,
      );
    } finally {
      state.abort.signal.removeEventListener("abort", abort);
      state.controllers.delete(controller);
    }
  });
}

function capacityEligible(state, binding) {
  if (!state.launchConfigured) return false;
  if (!state.pool?.ensureCapacity) return false;
  if (!binding.capabilities.launch) return false;
  return binding.authority === state.local.authority;
}

async function localDemand(state, binding, target) {
  const values = await summariesFor(state, target);
  const local = values.find(
    (value) =>
      value.binding.authority === state.local.authority && value.binding.sid === binding.sid,
  );
  if (!local?.fresh) return null;
  const demand = Math.min(512, local.summary.pending.work + local.summary.recoverable.work);
  return demand < 1 ? null : demand;
}

function trackCapacityRequest(state, binding, demand) {
  const request = withSlot(state, () =>
    state.pool.ensureCapacity({ primeSid: binding.sid, demand, readySpare: 0 }),
  );
  state.capacityRequests.set(binding.sid, request);
  return request.finally(() => {
    if (state.capacityRequests.get(binding.sid) === request)
      state.capacityRequests.delete(binding.sid);
  });
}

async function requestCapacity(state, binding, target) {
  if (!capacityEligible(state, binding)) return null;
  const address = validateAddress(binding.worker);
  if (address.slot !== "prime") return null;
  if (!target.consumer.status) return null;
  const currentStatus = await invokeNative(state, binding, target.consumer.status, {});
  if (!exact(currentStatus, ["state"]) || currentStatus.state !== "absent") return null;
  const demand = await localDemand(state, binding, target);
  if (demand === null) return null;
  if (state.capacityRequests.has(binding.sid)) return state.capacityRequests.get(binding.sid);
  return trackCapacityRequest(state, binding, demand);
}

async function reconcileAttempt(state, target, attempt) {
  if (!target.consumer.observe) return;
  const binding = [...target.bindingIds]
    .map((id) => state.bindings.get(id))
    .find((item) => item && current(state, item));
  if (!binding) return;
  const refs = refsFor(state, attempt.targetDigest);
  if (!refs.length) return;
  try {
    const result = validateObservation(
      await invokeNative(state, binding, target.consumer.observe, {
        attemptId: attempt.id,
        nativeRequestId: attempt.nativeRequestId,
      }),
    );
    applyObservation(state, attempt, result, refs);
  } catch (error) {
    state.tickFailures++;
    state.lastErrorCode = error instanceof Fault ? error.code : "unavailable";
    if (error instanceof Fault && ["owner", "protocol", "schema"].includes(error.code)) {
      if (error.code === "owner") {
        state.closed = true;
        clearTimeout(state.timer);
        state.abort.abort();
      }
      throw error;
    }
  }
}

function dispatchEligible(state, binding, target, values, attempts) {
  if (state.activeCalls >= LIMITS.deliveryNativeCalls) return false;
  if (!binding.capabilities.idle) return false;
  if (!target.consumer.status || !target.consumer.submit) return false;
  return changedScopes(values, attempts).length > 0;
}

async function readNativeStatus(state, binding, target) {
  const currentStatus = await invokeNative(state, binding, target.consumer.status, {});
  if (
    !exact(currentStatus, ["state"]) ||
    !["busy", "idle", "absent", "unknown", "held", "refused"].includes(currentStatus.state)
  )
    throw new Fault("protocol", "Native runtime state is invalid");
  return currentStatus.state;
}

async function submitTicket(state, binding, target, ticket) {
  const result = validateNativeResult(
    await invokeNative(state, binding, target.consumer.submit, {
      attemptId: ticket.attemptId,
      notice: ticket.notice,
    }),
  );
  if (!current(state, binding)) return;
  if (result.accepted) ticket.admitted(result.nativeRequestId);
  else if (result.state === "held") ticket.hold();
  else ticket.refuse();
}

function markUncertain(state, binding, ticket, error) {
  try {
    const latest = listDeliveryAttempts(state.local, state.ownerGeneration).find(
      (item) => item.id === ticket.attemptId,
    );
    if (latest?.state === "submitting")
      transition(state, latest, "submitting", "uncertain", refsFor(state, binding.targetDigest), {
        reasonCode:
          error instanceof Fault && error.code === "timeout"
            ? "native-timeout"
            : "submission-uncertain",
      });
  } catch (transitionError) {
    if (transitionError instanceof Fault && transitionError.code === "owner") throw transitionError;
    state.lastErrorCode = transitionError instanceof Fault ? transitionError.code : "unavailable";
  }
}

function settleDispatchFailure(state, binding, ticket, error) {
  if (!current(state, binding)) return;
  if (ticket) markUncertain(state, binding, ticket, error);
  state.tickFailures++;
  state.lastErrorCode = error instanceof Fault ? error.code : "unavailable";
}

async function dispatch(state, binding, target, values, attempts) {
  if (!dispatchEligible(state, binding, target, values, attempts)) return;
  let ticket = null;
  try {
    const status = await readNativeStatus(state, binding, target);
    if (status === "absent") {
      await requestCapacity(state, binding, target);
      return;
    }
    if (status !== "idle") return;
    if (!current(state, binding)) return;
    ticket = createTicket(state, binding, values, attempts);
    if (!ticket) return;
    await submitTicket(state, binding, target, ticket);
  } catch (error) {
    settleDispatchFailure(state, binding, ticket, error);
  }
}

function schedulePass(state, delay) {
  if (!state.started || state.closed) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void runPass(state);
  }, delay);
}

async function passTarget(state, target, attempts, selectedHub) {
  if (state.closed) return;
  const targetAttempts = attempts.filter(
    (attempt) => attempt.targetDigest === target.digest && UNRESOLVED.has(attempt.state),
  );
  if (targetAttempts.length) {
    for (const attempt of targetAttempts) await reconcileAttempt(state, target, attempt);
    return;
  }
  const values = await summariesFor(state, target, { scheduledHubId: selectedHub?.id ?? null });
  if (!values.some((value) => value.fresh)) return;
  const eligible = changedScopes(values, attempts);
  if (eligible.length) await dispatch(state, eligible[0].binding, target, values, attempts);
}

async function executePass(state) {
  state.lastErrorCode = null;
  try {
    const attempts = listDeliveryAttempts(state.local, state.ownerGeneration);
    const allTargets = [...state.targets.values()];
    const prior = allTargets.findIndex((target) => target.digest === state.targetCursor);
    const start = allTargets.length ? (prior + 1 + allTargets.length) % allTargets.length : 0;
    const targets = [...allTargets.slice(start), ...allTargets.slice(0, start)];
    if (targets.length) state.targetCursor = targets[0].digest;
    const selectedHub = hubReadAvailable(state) ? nextHubBinding(state) : null;
    if (selectedHub) state.hubCursor = selectedHub.id;
    await mapLimit(targets, LIMITS.deliveryNativeCalls, (target) =>
      passTarget(state, target, attempts, selectedHub),
    );
  } catch (error) {
    state.tickFailures++;
    state.lastErrorCode = error instanceof Fault ? error.code : "unavailable";
    if (error instanceof Fault && error.code === "owner") {
      state.closed = true;
      clearTimeout(state.timer);
      state.timer = null;
      state.abort.abort();
    }
  }
}

function runPass(state) {
  if (state.closed) return Promise.resolve();
  clearTimeout(state.timer);
  state.timer = null;
  if (state.passPromise) {
    state.passRequested = true;
    return state.passPromise;
  }
  const pass = executePass(state);
  state.passPromise = pass;
  const settle = () => {
    if (state.passPromise === pass) state.passPromise = null;
    if (state.closed || !state.started) return;
    if (state.passRequested) {
      state.passRequested = false;
      schedulePass(state, 0);
    } else schedulePass(state, state.pollMs);
  };
  pass.then(settle, settle);
  return pass;
}

function requestPass(state) {
  if (state.closed || !state.started || state.starting) return;
  if (state.passPromise) {
    state.passRequested = true;
    return;
  }
  schedulePass(state, 0);
}

function validateBindInput(state, input) {
  if (
    !exact(input, [
      "authority",
      "capabilities",
      "client",
      "consumer",
      "epoch",
      "sid",
      "target",
      "worker",
    ])
  )
    fail("input", "Native binding fields are invalid");
  if (!state.clients.includes(input.client)) fail("input", "Native binding fields are invalid");
  if (
    typeof input.authority !== "string" ||
    typeof input.worker !== "string" ||
    typeof input.sid !== "string"
  )
    fail("input", "Native binding fields are invalid");
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0)
    fail("input", "Native binding fields are invalid");
  return input;
}

async function confirmRecipient(state, api, input) {
  if (api !== state.local) return;
  const summary = await fetchSummary(state, {
    authority: input.authority,
    worker: input.worker,
    sid: input.sid,
    epoch: input.epoch,
  });
  if (summary.worker !== input.worker || summary.epoch !== input.epoch)
    fail("session", "Native binding is not the exact live recipient");
}

async function bindState(state, input) {
  if (!state.started || state.closed) fail("unavailable", "Delivery supervisor is not running");
  validateBindInput(state, input);
  const capabilities = validateCapabilities(input.capabilities);
  const consumer = validateConsumer(input.consumer, capabilities);
  const target = input.target;
  const targetDigest = deliveryTargetDigest(target);
  const existingTarget = state.targets.get(targetDigest);
  if (existingTarget && existingTarget.consumer !== consumer)
    fail("active", "Native target already has a different consumer binding");
  const api = authorityApi(state, input.authority);
  if (!api) fail("auth", "Native binding authority is not configured");
  await confirmRecipient(state, api, input);
  const binding = bindDeliverySession(state.local, {
    authority: input.authority,
    worker: input.worker,
    sid: input.sid,
    epoch: input.epoch,
    target,
    capabilities,
    ownerGeneration: state.ownerGeneration,
  });
  const record = { ...binding, client: input.client, consumer, active: true };
  state.bindings.set(record.id, record);
  const recipientHandle = createRecipientHandle({
    binding: record,
    api,
    isCurrent: (value) => recipientCurrent(state, value),
    // The background hint budget must not reject an agent responding to its hint.
    // Foreground reads still use fresh authority state and the broker's own limits.
    readPending: async () =>
      validateSummary(await fetchSummary(state, record, { scheduled: false }), record),
    replyKeys: state.recipientReplyKeys,
  });
  record.recipientHandle = recipientHandle;
  const targetRecord = existingTarget ?? {
    digest: targetDigest,
    target,
    consumer,
    bindingIds: new Set(),
  };
  targetRecord.target = target;
  targetRecord.bindingIds.add(record.id);
  state.targets.set(targetDigest, targetRecord);
  const handle = Object.freeze({
    notice: () => readNotice(state, record),
    safeBoundary: () => requestPass(state),
    recipient: (op, args) => recipientHandle.recipient(op, args),
    observe: (attemptId, observation) => recordObservation(state, record, attemptId, observation),
    requestCapacity: () => requestCapacity(state, record, targetRecord),
    close: () => Promise.resolve().then(() => unbind(state, record)),
  });
  requestPass(state);
  return handle;
}

function cancelAttempt(state, attempt, refs) {
  if (attempt.state === "reserved")
    transition(state, attempt, "reserved", "refused", refs, { reasonCode: "cancelled" });
  else if (attempt.state !== "uncertain")
    transition(state, attempt, attempt.state, "uncertain", refs, { reasonCode: "cancelled" });
}

function unbind(state, binding) {
  if (!current(state, binding)) return;
  binding.recipientHandle?.close();
  const target = state.targets.get(binding.targetDigest);
  const attempts = listDeliveryAttempts(state.local, state.ownerGeneration).filter(
    (attempt) => attempt.targetDigest === binding.targetDigest && UNRESOLVED.has(attempt.state),
  );
  for (const attempt of attempts)
    cancelAttempt(state, attempt, refsFor(state, binding.targetDigest));
  binding.active = false;
  state.bindings.delete(binding.id);
  state.hubSummaryCache.delete(binding.id);
  target?.bindingIds.delete(binding.id);
  if (target && target.bindingIds.size === 0) state.targets.delete(target.digest);
  endDeliveryBinding(state.local, {
    binding: binding.id,
    generation: binding.generation,
    ownerGeneration: state.ownerGeneration,
  });
}

async function startSupervisor(state) {
  if (state.started || state.closed)
    fail("active", "Delivery supervisor has already started or closed");
  state.started = true;
  state.starting = true;
  for (const client of state.clients) {
    const adapter = await loadAdapter(client);
    const capabilities = Object.freeze({
      ...(adapter?.capabilities ?? { context: false, idle: false, launch: false }),
    });
    const publishEvidence = (evidence) => {
      if (!["pending", "wired", "unsupported"].includes(evidence))
        fail("protocol", "Native adapter reported invalid evidence");
      const activeCapabilities =
        evidence === "unsupported"
          ? Object.freeze({ context: false, idle: false, launch: false })
          : capabilities;
      state.adapterStates.set(
        client,
        Object.freeze({ evidence, capabilities: activeCapabilities }),
      );
    };
    if (!adapter || adapter.evidence === "unsupported") {
      publishEvidence(adapter?.evidence ?? "unsupported");
      continue;
    }
    publishEvidence(adapter.evidence);
    const result = await adapter.startDeliveryAdapter(
      Object.freeze({
        client,
        bind: state.bind,
        signal: state.abort.signal,
        root: state.root,
        onEvidence: publishEvidence,
      }),
    );
    if (!exact(result, ["close"]) || typeof result.close !== "function")
      throw new Fault("protocol", "Native adapter did not return an owned close handle");
    state.adapterHandles.push(result);
  }
  state.starting = false;
  await runPass(state);
  return Object.freeze({ clients: [...state.adapterStates.keys()] });
}

function rejectWaiters(state) {
  for (const waiter of state.waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(new Fault("unavailable", "Delivery supervisor is closing"));
  }
}

async function closeAdapterHandles(state, failures) {
  for (const handle of [...state.adapterHandles].reverse()) {
    try {
      await handle.close();
    } catch (error) {
      failures.push(error);
    }
  }
  state.adapterHandles.length = 0;
}

function cancelAttempts(state, failures) {
  const attempts = listDeliveryAttempts(state.local, state.ownerGeneration).filter((attempt) =>
    UNRESOLVED.has(attempt.state),
  );
  for (const attempt of attempts) {
    try {
      const refs = refsFor(state, attempt.targetDigest);
      if (!refs.length) continue;
      cancelAttempt(state, attempt, refs);
    } catch (error) {
      failures.push(error);
    }
  }
}

function closeBindings(state, failures) {
  for (const binding of [...state.bindings.values()]) {
    binding.recipientHandle?.close();
    binding.active = false;
    state.hubSummaryCache.delete(binding.id);
    try {
      endDeliveryBinding(state.local, {
        binding: binding.id,
        generation: binding.generation,
        ownerGeneration: state.ownerGeneration,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  state.bindings.clear();
  state.targets.clear();
}

function releaseOwner(state, failures) {
  try {
    releaseDeliveryOwner(state.local, state.ownerGeneration);
  } catch (error) {
    failures.push(error);
  }
}

async function closeSupervisor(state) {
  if (state.closed && !state.started) return;
  state.closed = true;
  state.started = false;
  state.starting = false;
  clearTimeout(state.timer);
  state.timer = null;
  state.passRequested = false;
  state.abort.abort();
  for (const controller of state.controllers) controller.abort();
  rejectWaiters(state);
  await state.passPromise;
  while (state.activeCalls) await new Promise((resolve) => setTimeout(resolve, 1));
  const failures = [];
  await closeAdapterHandles(state, failures);
  cancelAttempts(state, failures);
  closeBindings(state, failures);
  releaseOwner(state, failures);
  if (supervisors.get(state.root) === state.supervisor) supervisors.delete(state.root);
  if (failures.length) throw new Fault("unavailable", "Delivery supervisor cleanup was incomplete");
}

function statusOf(state) {
  const core = deliveryStatus(state.local);
  const clients = state.clients.map((client) => {
    const value = state.adapterStates.get(client);
    return Object.freeze({
      client,
      evidence: value?.evidence ?? "unsupported",
      capabilities:
        value?.capabilities ?? Object.freeze({ context: false, idle: false, launch: false }),
    });
  });
  return Object.freeze({
    enabled: state.started && !state.closed,
    pollMs: state.pollMs,
    clients,
    core,
    activeCalls: state.activeCalls,
    readFailures: state.tickFailures,
    lastErrorCode: state.lastErrorCode,
  });
}

function validateSupervisorOptions(options) {
  if (
    !exact(options, [
      "clients",
      "hub",
      "launchConfigured",
      "local",
      "ownerGeneration",
      "pollMs",
      "pool",
    ])
  )
    fail("input", "Delivery supervisor options are invalid");
  if (!options.local) fail("input", "Delivery supervisor options are invalid");
  if (!Number.isSafeInteger(options.ownerGeneration))
    fail("input", "Delivery supervisor options are invalid");
  if (options.ownerGeneration < 1) fail("input", "Delivery supervisor options are invalid");
  return options;
}

function validatePollMs(value) {
  if (!Number.isSafeInteger(value)) fail("input", "Delivery poll interval is invalid");
  if (value < LIMITS.deliveryPollMinMs) fail("input", "Delivery poll interval is invalid");
  if (value > LIMITS.deliveryPollMaxMs) fail("input", "Delivery poll interval is invalid");
  return value;
}

function validateDistinctAuthorities(options) {
  if (!options.hub) return;
  if (options.hub.authority === options.local.authority)
    fail("input", "Delivery authorities must be distinct");
}

function validateSupervisorAuthority(options) {
  if (typeof options.local.pending !== "function")
    fail("input", "Delivery dependencies are invalid");
  if (typeof options.local.authority !== "string")
    fail("input", "Delivery dependencies are invalid");
  if (!options.hub) return;
  if (typeof options.hub.pending !== "function") fail("input", "Delivery dependencies are invalid");
  if (typeof options.hub.authority !== "string") fail("input", "Delivery dependencies are invalid");
}

function validateSupervisorPool(options) {
  if (
    options.pool !== undefined &&
    options.pool !== null &&
    typeof options.pool.ensureCapacity !== "function"
  )
    fail("input", "Delivery dependencies are invalid");
  if (options.launchConfigured !== undefined && typeof options.launchConfigured !== "boolean")
    fail("input", "Delivery dependencies are invalid");
}

/** Create a bounded supervisor. Construction is inert; start() claims only the already-owned broker generation. */
export function createDeliverySupervisor(options) {
  validateSupervisorOptions(options);
  const root = relayRoot(options.local);
  if (supervisors.has(root)) fail("active", "A delivery supervisor already owns this local root");
  const clients = validateClients(options.clients);
  const pollMs = options.pollMs ?? LIMITS.deliveryPollMs;
  validatePollMs(pollMs);
  validateDistinctAuthorities(options);
  validateSupervisorAuthority(options);
  validateSupervisorPool(options);

  const state = {
    local: options.local,
    hub: options.hub ?? null,
    pool: options.pool ?? null,
    launchConfigured: options.launchConfigured === true,
    ownerGeneration: options.ownerGeneration,
    pollMs,
    clients,
    root,
    supervisor: null,
    bind: null,
    bindings: new Map(),
    targets: new Map(),
    adapterHandles: [],
    adapterStates: new Map(),
    controllers: new Set(),
    activeCalls: 0,
    waiters: [],
    capacityRequests: new Map(),
    hubReadTimes: [],
    hubNextReadAt: 0,
    hubBackoffUntil: 0,
    hubFailureCount: 0,
    hubCursor: null,
    hubSummaryCache: new Map(),
    recipientReplyKeys: new Map(),
    targetCursor: null,
    passPromise: null,
    passRequested: false,
    timer: null,
    started: false,
    starting: false,
    closed: false,
    tickFailures: 0,
    lastErrorCode: null,
    abort: new AbortController(),
  };
  state.bind = (input) => bindState(state, input);

  const supervisor = Object.freeze({
    start: () => startSupervisor(state),
    close: () => closeSupervisor(state),
    bind: state.bind,
    refresh: () => runPass(state),
    status: () => statusOf(state),
  });
  state.supervisor = supervisor;
  supervisors.set(root, supervisor);
  return supervisor;
}
