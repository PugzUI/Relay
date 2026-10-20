import { createHash, randomUUID } from "node:crypto";
import { callOpenCodeBridge } from "./opencode-bridge.mjs";
import { createRecipientSession, recipientTools } from "./recipient-session.mjs";

const SUPPORTED_VERSION = "2.0.27";
const WORKER = /^[A-Za-z0-9._-]{1,63}:[A-Za-z0-9._-]{1,32}:(?:prime|[0-9]{3,32})$/;
const NATIVE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// Leave transport time inside the bridge's 2500 ms command deadline.
const SESSION_READ_MS = 1000;
const NATIVE_CALL_MS = 2000;
const MESSAGE_SCAN_LIMIT = 4096;
const RECONNECT_BACKOFF_MS = [0, 250, 500, 1000, 2000];
const EXECUTION_ENDED = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function pluginOptions(value) {
  const required = ["bindings", "nativeSession", "profile", "relayRoot"];
  if (
    !(exact(value, required) || (exact(value, [...required, "consume"]) && value.consume === true))
  )
    return null;
  if (
    typeof value.relayRoot !== "string" ||
    !value.relayRoot ||
    value.relayRoot.includes("\0") ||
    typeof value.profile !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.profile) ||
    typeof value.nativeSession !== "string" ||
    !/^ses_[A-Za-z0-9_-]{1,120}$/.test(value.nativeSession) ||
    !Array.isArray(value.bindings) ||
    value.bindings.length < 1 ||
    value.bindings.length > 16
  )
    return null;
  const identities = new Set();
  for (const binding of value.bindings) {
    if (
      !exact(binding, ["authority", "epoch", "sid", "worker"]) ||
      typeof binding.authority !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(binding.authority) ||
      typeof binding.worker !== "string" ||
      !WORKER.test(binding.worker) ||
      typeof binding.sid !== "string" ||
      !NATIVE_ID.test(binding.sid) ||
      !Number.isSafeInteger(binding.epoch) ||
      binding.epoch < 0
    )
      return null;
    const identity = JSON.stringify([
      binding.authority,
      binding.worker,
      binding.sid,
      binding.epoch,
    ]);
    if (identities.has(identity)) return null;
    identities.add(identity);
  }
  return value;
}

function generatedMessageId(attemptId) {
  const digest = createHash("sha256").update(`relay:${attemptId}`).digest("hex");
  return `msg_${digest.slice(0, 32)}`;
}

async function dispose(value) {
  if (typeof value === "function") await value();
  else if (value && typeof value.dispose === "function") await value.dispose();
}

async function withNativeDeadline(parentSignal, timeoutMs, operation) {
  const controller = new AbortController();
  let rejectAbort;
  const cancelled = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    controller.abort();
    rejectAbort(controller.signal.reason);
  };
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await Promise.race([
      cancelled,
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return operation(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
}

function currentMessageIds(event, sessionId) {
  if (event?.sessionID !== sessionId || !Array.isArray(event.messages)) return null;
  const ids = new Set();
  const start = Math.max(0, event.messages.length - MESSAGE_SCAN_LIMIT);
  for (let index = start; index < event.messages.length; index++) {
    const id = event.messages[index]?.id;
    if (typeof id === "string" && NATIVE_ID.test(id)) ids.add(id);
  }
  return ids;
}

function nativeApiReady(ctx) {
  return (
    Boolean(ctx.session) &&
    typeof ctx.session.get === "function" &&
    typeof ctx.session.prompt === "function" &&
    typeof ctx.session.wait === "function" &&
    typeof ctx.session.hook === "function" &&
    typeof ctx.event?.subscribe === "function"
  );
}

function toolApiReady(ctx) {
  return (
    Boolean(ctx.tool) &&
    typeof ctx.tool.transform === "function" &&
    typeof ctx.tool.list === "function"
  );
}

function makeTarget(runtime) {
  return Object.freeze({
    runtimeInstance: runtime.runtimeInstance,
    profile: runtime.options.profile,
    nativeSession: runtime.options.nativeSession,
    lifecycleGeneration: randomUUID(),
  });
}

function createRuntime(ctx, options, callBridge) {
  const runtime = {
    ctx,
    options,
    callBridge,
    attempts: new Map(),
    contextAttempts: new Set(),
    lifecycle: new AbortController(),
    eventLifecycle: new AbortController(),
    nativeReads: new Map(),
    bindingIds: [],
    stopPromise: null,
    reconnectPromise: null,
    contextHook: null,
    modelHook: null,
    toolTransform: null,
    recipientSession: null,
    runtimeInstance: `opencode-${process.pid}-${Math.floor(Date.now() - process.uptime() * 1000)}`,
    capabilities: Object.freeze({ context: true, idle: true, launch: false }),
    target: null,
  };
  runtime.target = makeTarget(runtime);
  return runtime;
}

// The native SDK can ignore abort. Reuse pending reads instead of leaking one per poll.
function readNative(runtime, method) {
  const { nativeReads, options, ctx, lifecycle } = runtime;
  if (nativeReads.has(method)) return nativeReads.get(method);
  const pending = Promise.resolve().then(() =>
    ctx.session[method]({ sessionID: options.nativeSession }, { signal: lifecycle.signal }),
  );
  nativeReads.set(method, pending);
  const clear = () => {
    if (nativeReads.get(method) === pending) nativeReads.delete(method);
  };
  void pending.then(clear, clear);
  return pending;
}

function report(runtime, attemptId, entry) {
  const observation = { state: entry.state, nativeRequestId: entry.nativeRequestId };
  entry.reportQueue = (entry.reportQueue ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (!runtime.bindingIds.length || runtime.lifecycle.signal.aborted) return;
      await runtime.callBridge(
        runtime.options.relayRoot,
        "delivery.observe",
        {
          bindingId: runtime.bindingIds[0],
          attemptId,
          observation,
        },
        runtime.lifecycle.signal,
      );
    });
  return entry.reportQueue;
}

async function closeBindings(runtime, bindingIds) {
  for (const bindingId of bindingIds) {
    await runtime
      .callBridge(runtime.options.relayRoot, "delivery.close", { bindingId })
      .catch(() => {});
  }
}

async function rebindTarget(runtime) {
  const oldIds = runtime.bindingIds.splice(0);
  await closeBindings(runtime, oldIds);
  runtime.target = makeTarget(runtime);
}

async function registerBindings(runtime, nextIds) {
  for (const binding of runtime.options.bindings) {
    const registration = await runtime.callBridge(
      runtime.options.relayRoot,
      "delivery.bind",
      {
        ...binding,
        ...(runtime.options.consume === true ? { consume: true } : {}),
        profile: runtime.options.profile,
        target: runtime.target,
        capabilities: runtime.capabilities,
      },
      runtime.lifecycle.signal,
    );
    if (
      !registration ||
      typeof registration.bindingId !== "string" ||
      !NATIVE_ID.test(registration.bindingId)
    ) {
      throw new Error("Relay binding was rejected");
    }
    nextIds.push(registration.bindingId);
    if (runtime.lifecycle.signal.aborted) return false;
  }
  return !runtime.lifecycle.signal.aborted;
}

async function rebindRecipient(runtime) {
  if (!runtime.recipientSession) return;
  await runtime.recipientSession.rebind(
    runtime.options.bindings.map((binding, index) => ({
      ...binding,
      id: runtime.bindingIds[index],
    })),
  );
}

async function replayObservations(runtime) {
  for (const [attemptId, entry] of runtime.attempts) {
    if (entry.state === "context_observed" || entry.state === "turn_started")
      await report(runtime, attemptId, entry);
  }
}

async function bindBridge(runtime, fresh = false) {
  if (fresh) await rebindTarget(runtime);
  const nextIds = [];
  try {
    if (!(await registerBindings(runtime, nextIds))) {
      await closeBindings(runtime, nextIds);
      return;
    }
    runtime.bindingIds.push(...nextIds);
    await rebindRecipient(runtime);
    await replayObservations(runtime);
  } catch (error) {
    await closeBindings(runtime, nextIds);
    runtime.bindingIds.splice(0);
    throw error;
  }
}

function backoff(runtime, waitMs) {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      runtime.lifecycle.signal.removeEventListener("abort", cancel);
      resolveWait();
    }, waitMs);
    const cancel = () => {
      clearTimeout(timer);
      resolveWait();
    };
    runtime.lifecycle.signal.addEventListener("abort", cancel, { once: true });
    timer.unref?.();
  });
}

async function retryBind(runtime) {
  for (const [index, waitMs] of RECONNECT_BACKOFF_MS.entries()) {
    if (index && runtime.lifecycle.signal.aborted) return false;
    if (waitMs) await backoff(runtime, waitMs);
    if (runtime.lifecycle.signal.aborted) return false;
    try {
      await bindBridge(runtime, true);
      return true;
    } catch {}
  }
  await stop(runtime);
  return false;
}

function reconnect(runtime) {
  if (runtime.lifecycle.signal.aborted) return Promise.resolve(false);
  if (runtime.reconnectPromise) return runtime.reconnectPromise;
  runtime.reconnectPromise = retryBind(runtime).finally(() => {
    runtime.reconnectPromise = null;
  });
  return runtime.reconnectPromise;
}

function observeContext(runtime, attemptId, entry) {
  if (entry.state === "unknown") {
    entry.state = "context_observed";
    void report(runtime, attemptId, entry).catch(() => {
      void reconnect(runtime).catch(() => {});
    });
  }
  if (entry.state === "context_observed") runtime.contextAttempts.add(attemptId);
}

function onContext(runtime, event) {
  if (event?.sessionID !== runtime.options.nativeSession) return;
  runtime.contextAttempts.clear();
  const messageIds = currentMessageIds(event, runtime.options.nativeSession);
  if (!messageIds) return;
  for (const [attemptId, entry] of runtime.attempts) {
    if (!messageIds.has(entry.nativeRequestId)) continue;
    observeContext(runtime, attemptId, entry);
  }
}

function onModelRequest(runtime, event) {
  if (event?.sessionID !== runtime.options.nativeSession || event.kind !== "primary") return;
  const currentContext = runtime.contextAttempts;
  runtime.contextAttempts = new Set();
  for (const attemptId of currentContext) {
    const entry = runtime.attempts.get(attemptId);
    if (entry?.state !== "context_observed") continue;
    entry.state = "turn_started";
    void report(runtime, attemptId, entry).catch(() => {
      void reconnect(runtime).catch(() => {});
    });
  }
}

async function nativeStatus(runtime) {
  let session;
  try {
    session = await withNativeDeadline(runtime.lifecycle.signal, SESSION_READ_MS, () =>
      readNative(runtime, "get"),
    );
  } catch {
    return { state: "unknown" };
  }
  if (!session || session.id !== runtime.options.nativeSession) return { state: "unknown" };
  let waitSignal;
  try {
    await withNativeDeadline(runtime.lifecycle.signal, 200, (signal) => {
      waitSignal = signal;
      return readNative(runtime, "wait");
    });
    return { state: "idle" };
  } catch {
    return { state: waitSignal?.aborted && !runtime.lifecycle.signal.aborted ? "busy" : "unknown" };
  }
}

async function nativeSubmit(runtime, input) {
  if (
    !input ||
    typeof input.attemptId !== "string" ||
    typeof input.notice !== "string" ||
    !input.notice ||
    Buffer.byteLength(input.notice, "utf8") > 4096
  ) {
    throw new Error("Invalid Relay notice");
  }
  if (runtime.attempts.size >= 128) return { accepted: false, state: "held" };
  const nativeRequestId = generatedMessageId(input.attemptId);
  const entry = { nativeRequestId, state: "unknown" };
  runtime.attempts.set(input.attemptId, entry);
  const accepted = await withNativeDeadline(runtime.lifecycle.signal, NATIVE_CALL_MS, (signal) =>
    runtime.ctx.session.prompt(
      {
        sessionID: runtime.options.nativeSession,
        id: nativeRequestId,
        text: input.notice,
        delivery: "queue",
        resume: true,
      },
      { signal },
    ),
  );
  if (!accepted || accepted.id !== nativeRequestId)
    throw new Error("Native admission could not be tied to the Relay attempt");
  return { accepted: true, nativeRequestId };
}

function callNative(runtime, command) {
  if (command.method === "status") return nativeStatus(runtime);
  if (command.method === "submit") return nativeSubmit(runtime, command.args);
  throw new Error("Unsupported native operation");
}

async function releaseRuntime(runtime) {
  await runtime.recipientSession?.close().catch(() => {});
  await dispose(runtime.contextHook).catch(() => {});
  await dispose(runtime.modelHook).catch(() => {});
  await dispose(runtime.toolTransform).catch(() => {});
  await closeBindings(runtime, runtime.bindingIds);
  runtime.contextAttempts.clear();
  runtime.nativeReads.clear();
}

function stop(runtime) {
  if (runtime.stopPromise) return runtime.stopPromise;
  runtime.lifecycle.abort();
  runtime.eventLifecycle.abort();
  runtime.stopPromise = releaseRuntime(runtime);
  return runtime.stopPromise;
}

async function rollback(runtime) {
  runtime.lifecycle.abort();
  runtime.eventLifecycle.abort();
  await runtime.recipientSession?.close().catch(() => {});
  await dispose(runtime.toolTransform).catch(() => {});
  await dispose(runtime.contextHook).catch(() => {});
  await dispose(runtime.modelHook).catch(() => {});
  await closeBindings(runtime, runtime.bindingIds);
}

async function startRecipient(runtime) {
  const { ctx, options } = runtime;
  runtime.recipientSession = createRecipientSession({
    relayRoot: options.relayRoot,
    bindings: options.bindings.map((binding, index) => ({
      ...binding,
      id: runtime.bindingIds[index],
    })),
    bridge: async (request, signal) => {
      try {
        return await runtime.callBridge(options.relayRoot, "delivery.recipient", request, signal);
      } catch (error) {
        if (!runtime.lifecycle.signal.aborted) void reconnect(runtime).catch(() => {});
        throw error;
      }
    },
  });
  await runtime.recipientSession.start();
  const tools = recipientTools(runtime.recipientSession, options.nativeSession);
  runtime.toolTransform = await ctx.tool.transform((editor) => {
    const current = editor.list();
    if (
      current.length > 256 ||
      tools.some((tool) => current.some((entry) => entry.id === tool.name))
    ) {
      throw new Error("OpenCode recipient tool names conflict with the native tool set");
    }
    for (const tool of tools) editor.add(tool);
  });
  const installed = await ctx.tool.list();
  if (tools.some((tool) => !installed.some((entry) => entry.id === tool.name))) {
    throw new Error("OpenCode recipient tools were not registered");
  }
}

async function startRuntime(runtime) {
  const { ctx, options } = runtime;
  try {
    runtime.contextHook = await ctx.session.hook("context", (event) => onContext(runtime, event));
    runtime.modelHook = await ctx.session.hook("model.request", (event) =>
      onModelRequest(runtime, event),
    );
    await bindBridge(runtime);
    if (options.consume === true) await startRecipient(runtime);
    return true;
  } catch {
    await rollback(runtime);
    return false;
  }
}

async function readTarget(ctx, options) {
  try {
    const targetInfo = await withNativeDeadline(
      new AbortController().signal,
      SESSION_READ_MS,
      (signal) => ctx.session.get({ sessionID: options.nativeSession }, { signal }),
    );
    if (!targetInfo || targetInfo.id !== options.nativeSession) return null;
    return targetInfo;
  } catch {
    return null;
  }
}

function supportedCommand(command) {
  return (
    Boolean(command) &&
    typeof command.callId === "string" &&
    ["status", "submit"].includes(command.method)
  );
}

async function executeCommand(runtime, command) {
  try {
    return { ok: true, result: await callNative(runtime, command) };
  } catch {
    // Native admission may have succeeded before the SDK rejected or timed out.
    // Keep its attempt unknown and never submit it again.
    await stop(runtime);
    return { ok: false };
  }
}

async function completeCommand(runtime, bindingId, command, result) {
  try {
    await runtime.callBridge(
      runtime.options.relayRoot,
      "delivery.complete",
      {
        bindingId,
        callId: command.callId,
        result,
      },
      runtime.lifecycle.signal,
    );
    return true;
  } catch {
    if (runtime.lifecycle.signal.aborted) return false;
    return Boolean(await reconnect(runtime));
  }
}

async function recover(runtime) {
  if (runtime.lifecycle.signal.aborted) return false;
  return Boolean(await reconnect(runtime));
}

async function runLoopStep(runtime) {
  const bindingId = runtime.bindingIds[0];
  let next;
  try {
    next = await runtime.callBridge(
      runtime.options.relayRoot,
      "delivery.next",
      { bindingId },
      runtime.lifecycle.signal,
    );
  } catch {
    return recover(runtime);
  }
  if (!next || next.command === null) return true;
  const command = next.command;
  if (!supportedCommand(command)) {
    await stop(runtime);
    return false;
  }
  const outcome = await executeCommand(runtime, command);
  if (!outcome.ok) return false;
  return completeCommand(runtime, bindingId, command, outcome.result);
}

async function runLoop(runtime) {
  while (!runtime.lifecycle.signal.aborted) {
    if (!(await runLoopStep(runtime))) break;
  }
}

async function settleIdle(runtime, attemptId, entry) {
  entry.waitingForIdle = false;
  if (
    runtime.eventLifecycle.signal.aborted ||
    runtime.attempts.get(attemptId) !== entry ||
    entry.state !== "turn_started"
  )
    return;
  entry.state = "safe_idle";
  await report(runtime, attemptId, entry);
  runtime.attempts.delete(attemptId);
}

function confirmIdle(runtime) {
  for (const [attemptId, entry] of runtime.attempts) {
    if (entry.state !== "turn_started" || entry.waitingForIdle) continue;
    // Passive idle confirmation must outlive command deadlines without blocking the event feed.
    entry.waitingForIdle = true;
    void readNative(runtime, "wait")
      .then(
        () => settleIdle(runtime, attemptId, entry),
        () => {
          entry.waitingForIdle = false;
        },
      )
      .catch(() => {
        void reconnect(runtime).catch(() => {});
      });
  }
}

async function runEventLoop(runtime) {
  try {
    for await (const event of runtime.ctx.event.subscribe({
      signal: runtime.eventLifecycle.signal,
    })) {
      if (
        !EXECUTION_ENDED.has(event?.type) ||
        event.data?.sessionID !== runtime.options.nativeSession
      )
        continue;
      confirmIdle(runtime);
      void runtime.recipientSession?.activationEnded().catch(() => {});
    }
  } catch {
    if (!runtime.eventLifecycle.signal.aborted) await stop(runtime);
  }
}

async function setupPlugin(ctx, callBridge) {
  const options = pluginOptions(ctx.options);
  if (ctx.app?.version !== SUPPORTED_VERSION || !options || !nativeApiReady(ctx)) return undefined;
  if (options.consume === true && !toolApiReady(ctx)) {
    throw new Error("OpenCode native tool API is unavailable for recipient consumption");
  }
  const target = await readTarget(ctx, options);
  if (!target) return undefined;
  const runtime = createRuntime(ctx, options, callBridge);
  if (!(await startRuntime(runtime))) return undefined;
  runtime.loop = runLoop(runtime);
  runtime.eventLoop = runEventLoop(runtime);
  return async () => {
    await stop(runtime);
    await Promise.all([runtime.loop.catch(() => {}), runtime.eventLoop.catch(() => {})]);
  };
}

export function createOpenCodePlugin({ callBridge = callOpenCodeBridge } = {}) {
  if (typeof callBridge !== "function") throw new TypeError("OpenCode bridge function is invalid");
  return {
    id: "pugzui-relay-delivery",
    setup(ctx) {
      return setupPlugin(ctx, callBridge);
    },
  };
}
