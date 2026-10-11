import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Fault } from "./fault.mjs";
import {
  bindDeliverySession,
  deliveryStatus,
  deliveryTargetDigest,
  endDeliveryBinding,
  listDeliveryAttempts,
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
const UNRESOLVED = new Set(["reserved", "submitting", "admitted", "context_observed", "turn_started", "held", "uncertain"]);
const OBSERVATIONS = new Set(["context_observed", "turn_started", "safe_idle", "held", "refused"]);
const REASONS = new Set(["auth-revoked", "binding-stale", "capacity-full", "cancelled", "deadline-elapsed", "native-held", "native-refused", "native-timeout", "native-unavailable", "native-unsupported", "observed", "operator-confirmed", "owner-recovery", "retry-exhausted", "submission-uncertain", "target-owned"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code, message) => { throw new Fault(code, message); };
const exact = (value, keys) => {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.every((key) => typeof key === "string") && JSON.stringify(own.sort()) === JSON.stringify([...keys].sort());
};
const refOf = (binding) => ({ binding: binding.id, generation: binding.generation });
const nonzero = (counts) => counts.msg > 0 || counts.work > 0;
const hasPending = (summary) => nonzero(summary.pending) || nonzero(summary.recoverable);

function validateClients(clients) {
  if (!Array.isArray(clients) || clients.length > DELIVERY_CLIENTS.length || new Set(clients).size !== clients.length || clients.some((client) => !DELIVERY_CLIENTS.includes(client))) fail("input", "Delivery client selection is invalid");
  return [...clients];
}

async function loadAdapter(client) {
  const path = new URL(ADAPTER_PATHS[client], import.meta.url);
  try { await access(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Fault("unavailable", "Delivery adapter cannot be inspected"); }
  const adapter = await import(path.href);
  if (adapter.client !== client || typeof adapter.startDeliveryAdapter !== "function" || !object(adapter.capabilities) || Object.keys(adapter.capabilities).sort().join(",") !== "context,idle,launch" || Object.values(adapter.capabilities).some((value) => typeof value !== "boolean") || !["wired", "unsupported"].includes(adapter.evidence)) {
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
    result.push(Object.freeze(adapter
      ? { client, evidence: adapter.evidence, capabilities: Object.freeze({ ...adapter.capabilities }) }
      : { client, evidence: "unsupported", capabilities: Object.freeze({ context: false, idle: false, launch: false }) }));
  }
  return result;
}

function validateCapabilities(value) {
  if (!exact(value, ["context", "idle", "launch"]) || Object.values(value).some((item) => typeof item !== "boolean")) fail("input", "Delivery capabilities are invalid");
  return Object.freeze({ context: value.context, idle: value.idle, launch: value.launch });
}

function validateConsumer(consumer, capabilities) {
  if (!object(consumer) || ![Object.prototype, null].includes(Object.getPrototypeOf(consumer))) fail("input", "Native delivery consumer is required");
  const allowed = ["observe", "status", "submit"];
  if (Reflect.ownKeys(consumer).some((key) => typeof key !== "string" || !allowed.includes(key))) fail("input", "Native delivery consumer has unknown fields");
  for (const key of allowed) if (consumer[key] !== undefined && typeof consumer[key] !== "function") fail("input", "Native delivery consumer method is invalid");
  if (capabilities.idle && (!consumer.status || !consumer.submit || !consumer.observe)) fail("input", "Idle delivery requires status, submit, and observation methods");
  return consumer;
}

function validateSummary(summary, binding) {
  if (!exact(summary, ["authority", "epoch", "pending", "recoverable", "revision", "v", "worker"]) || summary.v !== 1 || summary.authority !== binding.authority || summary.worker !== binding.worker || summary.epoch !== binding.epoch || !/^[a-f0-9]{64}$/.test(summary.revision)) fail("protocol", "Recipient summary does not match its exact binding");
  for (const counts of [summary.pending, summary.recoverable]) {
    if (!exact(counts, ["msg", "work"]) || Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0)) fail("protocol", "Recipient summary counts are invalid");
  }
  return summary;
}

function noticeText(scopes) {
  const prefix = "Relay pending state changed. Read current state before acting.\n";
  const lines = [];
  for (const scope of scopes) {
    const summary = scope.summary;
    const line = `scope ${lines.length + 1}: msg=${summary.pending.msg} work=${summary.pending.work} recoverable_msg=${summary.recoverable.msg} recoverable_work=${summary.recoverable.work} revision=${summary.revision}\n`;
    if (Buffer.byteLength(prefix + lines.join("") + line, "utf8") > LIMITS.deliveryNoticeBytes) break;
    lines.push(line);
  }
  return lines.length ? prefix + lines.join("") : null;
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
    Promise.resolve().then(fn).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function mapLimit(values, limit, fn) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index);
    }
  }));
  return results;
}

/** Create a bounded supervisor. Construction is inert; start() claims only the already-owned broker generation. */
export function createDeliverySupervisor(options) {
  if (!exact(options, ["clients", "hub", "launchConfigured", "local", "ownerGeneration", "pollMs", "pool"]) || !options.local || !Number.isSafeInteger(options.ownerGeneration) || options.ownerGeneration < 1) fail("input", "Delivery supervisor options are invalid");
  const root = relayRoot(options.local);
  if (supervisors.has(root)) fail("active", "A delivery supervisor already owns this local root");
  const clients = validateClients(options.clients);
  const pollMs = options.pollMs ?? LIMITS.deliveryPollMs;
  if (!Number.isSafeInteger(pollMs) || pollMs < LIMITS.deliveryPollMinMs || pollMs > LIMITS.deliveryPollMaxMs) fail("input", "Delivery poll interval is invalid");
  if (options.hub && options.hub.authority === options.local.authority) fail("input", "Delivery authorities must be distinct");
  if (typeof options.local.pending !== "function" || typeof options.local.authority !== "string" || options.hub && (typeof options.hub.pending !== "function" || typeof options.hub.authority !== "string") || options.pool !== undefined && options.pool !== null && typeof options.pool.ensureCapacity !== "function" || options.launchConfigured !== undefined && typeof options.launchConfigured !== "boolean") fail("input", "Delivery dependencies are invalid");

  const state = {
    local: options.local,
    hub: options.hub ?? null,
    pool: options.pool ?? null,
    launchConfigured: options.launchConfigured === true,
    ownerGeneration: options.ownerGeneration,
    pollMs,
    clients,
    bindings: new Map(),
    targets: new Map(),
    adapterHandles: [],
    adapterStates: new Map(),
    controllers: new Set(),
    activeCalls: 0,
    waiters: [],
    capacityRequests: new Map(),
    timer: null,
    scheduledTimer: null,
    started: false,
    starting: false,
    runScheduled: false,
    closed: false,
    running: false,
    tickFailures: 0,
    lastErrorCode: null,
    abort: new AbortController(),
  };

  function current(binding) {
    return !state.closed && state.bindings.get(binding.id) === binding && binding.active;
  }

  function refsFor(targetDigest) {
    return [...state.bindings.values()].filter((binding) => binding.active && binding.targetDigest === targetDigest).map(refOf);
  }

  function activeTarget(binding) {
    if (!current(binding)) throw new Fault("owner", "Delivery binding generation is stale");
    const target = state.targets.get(binding.targetDigest);
    if (!target || target.consumer !== binding.consumer) throw new Fault("owner", "Native target binding is no longer current");
    return target;
  }

  async function withSlot(fn) {
    if (state.closed) throw new Fault("unavailable", "Delivery supervisor is closed");
    let acquired = false;
    if (state.activeCalls >= LIMITS.deliveryNativeCalls) {
      if (state.waiters.length >= LIMITS.deliveryBindings) throw new Fault("full", "Delivery call queue is full");
      await new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = state.waiters.indexOf(waiter);
          if (index >= 0) state.waiters.splice(index, 1);
          reject(new Fault("timeout", "Delivery call queue deadline elapsed"));
        }, LIMITS.deliveryDeadlineMs);
        state.waiters.push(waiter);
      });
      acquired = true;
    } else { state.activeCalls++; acquired = true; }
    try {
      if (state.closed) throw new Fault("unavailable", "Delivery supervisor is closed");
      return await fn();
    }
    finally {
      if (acquired) {
        const next = state.waiters.shift();
        if (next) { clearTimeout(next.timer); next.resolve(); }
        else state.activeCalls--;
      }
    }
  }

  async function summaryFor(binding) {
    const api = binding.authority === state.local.authority ? state.local
      : state.hub?.authority === binding.authority ? state.hub : null;
    if (!api) throw new Fault("auth", "Delivery authority is not configured");
    return withSlot(async () => validateSummary(await api.pending(binding.sid), binding));
  }

  async function summariesFor(target) {
    const bindings = [...target.bindingIds].map((id) => state.bindings.get(id)).filter((binding) => binding && current(binding));
    const values = await mapLimit(bindings, LIMITS.deliveryNativeCalls, async (binding) => {
      try { return { binding, summary: await summaryFor(binding), error: null }; }
      catch (error) { return { binding, summary: null, error }; }
    });
    const available = [];
    for (const value of values) {
      if (value.summary) available.push(value);
      else if (value.error instanceof Fault && ["auth", "denied", "session"].includes(value.error.code)) {
        state.tickFailures++;
        state.lastErrorCode = value.error.code;
        await unbind(value.binding);
      } else if (value.error instanceof Fault && ["owner", "schema", "protocol"].includes(value.error.code)) {
        throw value.error;
      } else {
        state.tickFailures++;
        state.lastErrorCode = value.error instanceof Fault ? value.error.code : "unavailable";
      }
    }
    return available;
  }

  function priorRevisions(attempts) {
    const revisions = new Map();
    for (const attempt of attempts) {
      if (attempt.submittingAt === null) continue;
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
    return values.filter(({ binding, summary }) => hasPending(summary) && !revisions.get(binding.id)?.has(summary.revision));
  }

  function transition(attempt, from, to, refs, extra = {}) {
    return transitionDeliveryAttempt(state.local, {
      id: attempt.id,
      ownerGeneration: state.ownerGeneration,
      bindings: refs,
      from,
      to,
      ...extra,
    });
  }

  function validateNativeResult(value) {
    if (!object(value) || typeof value.accepted !== "boolean") throw new Fault("protocol", "Native consumer result is invalid");
    const keys = value.accepted
      ? Object.hasOwn(value, "nativeRequestId") ? ["accepted", "nativeRequestId"] : ["accepted"]
      : ["accepted", "state"];
    if (!exact(value, keys)) throw new Fault("protocol", "Native consumer result has unknown fields");
    if (Object.hasOwn(value, "nativeRequestId") && (typeof value.nativeRequestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.nativeRequestId))) throw new Fault("protocol", "Native request identity is invalid");
    if (!value.accepted && !["held", "refused"].includes(value.state)) throw new Fault("protocol", "Native refusal state is invalid");
    return value;
  }

  function validateObservation(value) {
    if (!object(value) || !OBSERVATIONS.has(value.state) && value.state !== "unknown" || !exact(value, Object.hasOwn(value, "nativeRequestId") ? ["state", "nativeRequestId"] : ["state"])) throw new Fault("protocol", "Native observation is invalid");
    if (value.nativeRequestId !== undefined && (typeof value.nativeRequestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.nativeRequestId))) throw new Fault("protocol", "Native request identity is invalid");
    return value;
  }

  function recordObservation(binding, attemptId, observation) {
    if (!current(binding)) return false;
    const attempt = listDeliveryAttempts(state.local, state.ownerGeneration).find((row) => row.id === attemptId);
    if (!attempt || attempt.targetDigest !== binding.targetDigest || TERMINAL.has(attempt.state)) return false;
    const refs = refsFor(binding.targetDigest);
    if (!refs.length) return false;
    const value = validateObservation(typeof observation === "string" ? { state: observation } : observation);
    if (attempt.nativeRequestId && value.nativeRequestId && attempt.nativeRequestId !== value.nativeRequestId) throw new Fault("protocol", "Native observation belongs to another request");
    return applyObservation(attempt, value, refs);
  }

  function applyObservation(attempt, observation, refs) {
    if (observation.state === "unknown") return false;
    let currentState = attempt.state;
    const requestId = observation.nativeRequestId ?? attempt.nativeRequestId ?? undefined;
    const withRequest = requestId ? { nativeRequestId: requestId } : {};
    const move = (to, extra = {}) => {
      transition(attempt, currentState, to, refs, { ...withRequest, ...extra });
      currentState = to;
    };
    if (currentState === observation.state) return false;
    if (currentState === "held" && observation.state !== "held") move("uncertain", { reasonCode: "observed" });
    if (observation.state === "held" || observation.state === "refused") {
      const reasonCode = observation.state === "held" ? "native-held" : "native-refused";
      if (currentState === "context_observed" || currentState === "turn_started") {
        move("uncertain", { reasonCode });
      } else if (UNRESOLVED.has(currentState)) move(observation.state, { reasonCode });
      else return false;
      return true;
    }
    if (currentState === "reserved") return false;
    if (currentState === "submitting" && observation.state !== "held" && observation.state !== "refused") move("admitted");
    if (observation.state === "context_observed") {
      if (["admitted", "uncertain"].includes(currentState)) move("context_observed");
      else return false;
    } else if (observation.state === "turn_started") {
      if (currentState === "context_observed") move("turn_started");
      else return false;
    } else if (observation.state === "safe_idle") {
      if (currentState === "turn_started") move("safe_idle");
      else return false;
    }
    return true;
  }

  function createTicket(binding, values, attempts) {
    const scopes = changedScopes(values, attempts);
    if (!scopes.length) return null;
    const formattedScopes = [];
    for (const value of scopes) {
      const candidate = [...formattedScopes, { binding: value.binding, summary: value.summary }];
      if (!noticeText(candidate)) break;
      formattedScopes.push(candidate.at(-1));
    }
    const notice = noticeText(formattedScopes);
    if (!notice) return null;
    const bindings = formattedScopes;
    const attemptId = `delivery-${randomUUID()}`;
    const saved = reserveDeliveryAttempt(state.local, {
      id: attemptId,
      ownerGeneration: state.ownerGeneration,
      bindings: bindings.map(({ binding, summary }) => ({ binding: binding.id, generation: binding.generation, summary })),
    });
    let attempt = listDeliveryAttempts(state.local, state.ownerGeneration).find((row) => row.id === saved.id);
    if (!attempt) throw new Fault("schema", "Persisted delivery attempt cannot be read");
    const refs = bindings.map(({ binding }) => refOf(binding));
    attempt = transition(attempt, "reserved", "submitting", refs);
    const handleBinding = bindings.find(({ binding: item }) => current(item))?.binding ?? binding;
    let admitted = false;
    let completed = false;
    return Object.freeze({
      attemptId,
      notice,
      admitted: (nativeRequestId) => {
        if (!current(handleBinding) || admitted || completed) return false;
        const extra = nativeRequestId === undefined ? {} : { nativeRequestId };
        const result = transition(attempt, "submitting", "admitted", refsFor(binding.targetDigest), extra);
        admitted = true;
        return result;
      },
      observe: (observation) => {
        if (!current(handleBinding) || completed) return false;
        const result = recordObservation(handleBinding, attemptId, observation);
        if (result) {
          const latest = listDeliveryAttempts(state.local, state.ownerGeneration).find((row) => row.id === attemptId);
          if (latest && TERMINAL.has(latest.state)) completed = true;
        }
        return result;
      },
      refuse: (reasonCode = "native-refused") => {
        if (!current(handleBinding) || admitted || completed) return false;
        if (!REASONS.has(reasonCode)) throw new Fault("input", "Delivery reason code is invalid");
        const result = transition(attempt, "submitting", "refused", refsFor(binding.targetDigest), { reasonCode });
        completed = true;
        return result;
      },
    });
  }

  async function readNotice(binding) {
    const target = activeTarget(binding);
    const values = await summariesFor(target);
    if (!values.length) return null;
    const attempts = listDeliveryAttempts(state.local, state.ownerGeneration);
    if (attempts.some((attempt) => attempt.targetDigest === binding.targetDigest && UNRESOLVED.has(attempt.state))) return null;
    return createTicket(binding, values, attempts);
  }

  async function invokeNative(binding, method, input) {
    if (state.closed || !current(binding)) throw new Fault("owner", "Native delivery binding is stale");
    return withSlot(async () => {
      const controller = new AbortController();
      state.controllers.add(controller);
      const abort = () => controller.abort();
      state.abort.signal.addEventListener("abort", abort, { once: true });
      if (state.abort.signal.aborted) controller.abort();
      try { return await withDeadline(() => method({ ...input, signal: controller.signal }), controller, LIMITS.deliveryDeadlineMs); }
      finally {
        state.abort.signal.removeEventListener("abort", abort);
        state.controllers.delete(controller);
      }
    });
  }

  async function requestCapacity(binding, target) {
    if (!state.launchConfigured || !state.pool?.ensureCapacity || !binding.capabilities.launch || binding.authority !== state.local.authority) return null;
    const address = validateAddress(binding.worker);
    if (address.slot !== "prime") return null;
    if (!target.consumer.status) return null;
    const currentStatus = await invokeNative(binding, target.consumer.status, {});
    if (!exact(currentStatus, ["state"]) || currentStatus.state !== "absent") return null;
    const values = await summariesFor(target);
    const local = values.find((value) => value.binding.authority === state.local.authority && value.binding.sid === binding.sid);
    if (!local) return null;
    const demand = Math.min(512, local.summary.pending.work + local.summary.recoverable.work);
    if (demand < 1) return null;
    if (state.capacityRequests.has(binding.sid)) return state.capacityRequests.get(binding.sid);
    const request = withSlot(() => state.pool.ensureCapacity({ primeSid: binding.sid, demand, readySpare: 0 }));
    state.capacityRequests.set(binding.sid, request);
    try { return await request; }
    finally { if (state.capacityRequests.get(binding.sid) === request) state.capacityRequests.delete(binding.sid); }
  }

  async function reconcileAttempt(target, attempt) {
    if (!target.consumer.observe) return;
    const binding = [...target.bindingIds].map((id) => state.bindings.get(id)).find((item) => item && current(item));
    if (!binding) return;
    const refs = refsFor(attempt.targetDigest);
    if (!refs.length) return;
    try {
      const result = validateObservation(await invokeNative(binding, target.consumer.observe, {
        attemptId: attempt.id,
        nativeRequestId: attempt.nativeRequestId,
      }));
      applyObservation(attempt, result, refs);
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

  async function dispatch(binding, target, values, attempts) {
    if (state.activeCalls >= LIMITS.deliveryNativeCalls || !binding.capabilities.idle || !target.consumer.status || !target.consumer.submit) return;
    let ticket;
    try {
      const currentStatus = await invokeNative(binding, target.consumer.status, {});
      if (!exact(currentStatus, ["state"]) || !["busy", "idle", "absent", "unknown", "held", "refused"].includes(currentStatus.state)) throw new Fault("protocol", "Native runtime state is invalid");
      if (currentStatus.state === "absent") { await requestCapacity(binding, target); return; }
      if (currentStatus.state !== "idle") return;
      if (!current(binding)) return;
      ticket = createTicket(binding, values, attempts);
      if (!ticket) return;
      const result = validateNativeResult(await invokeNative(binding, target.consumer.submit, { attemptId: ticket.attemptId, notice: ticket.notice }));
      if (!current(binding)) return;
      if (result.accepted) ticket.admitted(result.nativeRequestId);
      else ticket.refuse(result.state === "held" ? "native-held" : "native-refused");
    } catch (error) {
      if (!current(binding)) return;
      if (ticket) {
        try {
          const latest = listDeliveryAttempts(state.local, state.ownerGeneration).find((item) => item.id === ticket.attemptId);
          if (latest?.state === "submitting") transition(latest, "submitting", "uncertain", refsFor(binding.targetDigest), { reasonCode: error instanceof Fault && error.code === "timeout" ? "native-timeout" : "submission-uncertain" });
        } catch (transitionError) {
          if (transitionError instanceof Fault && transitionError.code === "owner") throw transitionError;
          state.lastErrorCode = transitionError instanceof Fault ? transitionError.code : "unavailable";
        }
      }
      state.tickFailures++;
      state.lastErrorCode = error instanceof Fault ? error.code : "unavailable";
    }
  }

  async function runPass() {
    if (state.closed) return;
    if (state.running) {
      while (state.running && !state.closed) await new Promise((resolve) => setTimeout(resolve, 1));
      return;
    }
    state.running = true;
    state.lastErrorCode = null;
    try {
      const attempts = listDeliveryAttempts(state.local, state.ownerGeneration);
      const targets = [...state.targets.values()];
      await mapLimit(targets, LIMITS.deliveryNativeCalls, async (target) => {
        if (state.closed) return;
        const targetAttempts = attempts.filter((attempt) => attempt.targetDigest === target.digest && UNRESOLVED.has(attempt.state));
        if (targetAttempts.length) {
          for (const attempt of targetAttempts) await reconcileAttempt(target, attempt);
          return;
        }
        const values = await summariesFor(target);
        if (!values.length) return;
        await dispatch(values[0].binding, target, values, attempts);
      });
    } catch (error) {
      state.tickFailures++;
      state.lastErrorCode = error instanceof Fault ? error.code : "unavailable";
      if (error instanceof Fault && error.code === "owner") {
        state.closed = true;
        clearTimeout(state.timer);
        state.abort.abort();
      }
    } finally {
      state.running = false;
      if (state.started && !state.closed) state.timer = setTimeout(() => { void runPass(); }, state.pollMs);
    }
  }

  function requestPass() {
    if (state.closed || state.starting || state.running || state.runScheduled) return;
    state.runScheduled = true;
    state.scheduledTimer = setTimeout(() => {
      state.scheduledTimer = null;
      state.runScheduled = false;
      void runPass();
    }, 0);
  }

  async function bind(input) {
    if (!state.started || state.closed) fail("unavailable", "Delivery supervisor is not running");
    if (!exact(input, ["authority", "capabilities", "client", "consumer", "epoch", "sid", "target", "worker"]) || !state.clients.includes(input.client) || typeof input.authority !== "string" || typeof input.worker !== "string" || typeof input.sid !== "string" || !Number.isSafeInteger(input.epoch) || input.epoch < 0) fail("input", "Native binding fields are invalid");
    const capabilities = validateCapabilities(input.capabilities);
    const consumer = validateConsumer(input.consumer, capabilities);
    const target = input.target;
    const targetDigest = deliveryTargetDigest(target);
    const existingTarget = state.targets.get(targetDigest);
    if (existingTarget && existingTarget.consumer !== consumer) fail("active", "Native target already has a different consumer binding");
    const api = input.authority === state.local.authority ? state.local : state.hub?.authority === input.authority ? state.hub : null;
    if (!api) fail("auth", "Native binding authority is not configured");
    const summary = validateSummary(await withSlot(() => api.pending(input.sid)), input);
    if (summary.worker !== input.worker || summary.epoch !== input.epoch) fail("session", "Native binding is not the exact live recipient");
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
    const targetRecord = existingTarget ?? { digest: targetDigest, target, consumer, bindingIds: new Set() };
    targetRecord.bindingIds.add(record.id);
    state.targets.set(targetDigest, targetRecord);
    const handle = Object.freeze({
      notice: () => readNotice(record),
      safeBoundary: requestPass,
      observe: (attemptId, observation) => recordObservation(record, attemptId, observation),
      requestCapacity: () => requestCapacity(record, targetRecord),
      close: () => unbind(record),
    });
    requestPass();
    return handle;
  }

  async function unbind(binding) {
    if (!current(binding)) return;
    const target = state.targets.get(binding.targetDigest);
    const attempts = listDeliveryAttempts(state.local, state.ownerGeneration).filter((attempt) => attempt.targetDigest === binding.targetDigest && UNRESOLVED.has(attempt.state));
    for (const attempt of attempts) {
      if (attempt.state === "reserved") transition(attempt, "reserved", "refused", refsFor(binding.targetDigest), { reasonCode: "cancelled" });
      else if (attempt.state !== "uncertain") transition(attempt, attempt.state, "uncertain", refsFor(binding.targetDigest), { reasonCode: "cancelled" });
    }
    binding.active = false;
    state.bindings.delete(binding.id);
    target?.bindingIds.delete(binding.id);
    if (target && target.bindingIds.size === 0) state.targets.delete(target.digest);
    endDeliveryBinding(state.local, { binding: binding.id, generation: binding.generation, ownerGeneration: state.ownerGeneration });
  }

  async function start() {
    if (state.started || state.closed) fail("active", "Delivery supervisor has already started or closed");
    state.started = true;
    state.starting = true;
    for (const client of state.clients) {
      const adapter = await loadAdapter(client);
      if (!adapter || adapter.evidence !== "wired") {
        state.adapterStates.set(client, Object.freeze({ evidence: adapter?.evidence ?? "unsupported", capabilities: adapter?.capabilities ?? { context: false, idle: false, launch: false } }));
        continue;
      }
      const result = await adapter.startDeliveryAdapter(Object.freeze({ client, bind, signal: state.abort.signal }));
      if (!exact(result, ["close"]) || typeof result.close !== "function") throw new Fault("protocol", "Native adapter did not return an owned close handle");
      state.adapterHandles.push(result);
      state.adapterStates.set(client, Object.freeze({ evidence: "wired", capabilities: Object.freeze({ ...adapter.capabilities }) }));
    }
    state.starting = false;
    await runPass();
    return Object.freeze({ clients: [...state.adapterStates.keys()] });
  }

  async function close() {
    if (state.closed && !state.started) return;
    state.closed = true;
    state.started = false;
    state.starting = false;
    clearTimeout(state.timer);
    clearTimeout(state.scheduledTimer);
    state.scheduledTimer = null;
    state.runScheduled = false;
    state.abort.abort();
    for (const controller of state.controllers) controller.abort();
    for (const waiter of state.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Fault("unavailable", "Delivery supervisor is closing"));
    }
    while (state.running) await new Promise((resolve) => setTimeout(resolve, 1));
    while (state.activeCalls) await new Promise((resolve) => setTimeout(resolve, 1));
    const failures = [];
    for (const handle of [...state.adapterHandles].reverse()) {
      try { await handle.close(); } catch (error) { failures.push(error); }
    }
    state.adapterHandles.length = 0;
    const attempts = listDeliveryAttempts(state.local, state.ownerGeneration).filter((attempt) => UNRESOLVED.has(attempt.state));
    for (const attempt of attempts) {
      try {
        const refs = refsFor(attempt.targetDigest);
        if (!refs.length) continue;
        if (attempt.state === "reserved") transition(attempt, "reserved", "refused", refs, { reasonCode: "cancelled" });
        else if (attempt.state !== "uncertain") transition(attempt, attempt.state, "uncertain", refs, { reasonCode: "cancelled" });
      } catch (error) { failures.push(error); }
    }
    for (const binding of [...state.bindings.values()]) {
      binding.active = false;
      try { endDeliveryBinding(state.local, { binding: binding.id, generation: binding.generation, ownerGeneration: state.ownerGeneration }); }
      catch (error) { failures.push(error); }
    }
    state.bindings.clear();
    state.targets.clear();
    try { releaseDeliveryOwner(state.local, state.ownerGeneration); } catch (error) { failures.push(error); }
    if (supervisors.get(root) === supervisor) supervisors.delete(root);
    if (failures.length) throw new Fault("unavailable", "Delivery supervisor cleanup was incomplete");
  }

  function status() {
    const core = deliveryStatus(state.local);
    const clients = state.clients.map((client) => {
      const value = state.adapterStates.get(client);
      return Object.freeze({ client, evidence: value?.evidence ?? "unsupported", capabilities: value?.capabilities ?? Object.freeze({ context: false, idle: false, launch: false }) });
    });
    return Object.freeze({ enabled: state.started && !state.closed, pollMs: state.pollMs, clients, core, activeCalls: state.activeCalls, readFailures: state.tickFailures, lastErrorCode: state.lastErrorCode });
  }

  const supervisor = Object.freeze({ start, close, bind, refresh: runPass, status });
  supervisors.set(root, supervisor);
  return supervisor;
}
