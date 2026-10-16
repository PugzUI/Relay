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
const EXECUTION_ENDED = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function pluginOptions(value) {
  const required = ["bindings", "nativeSession", "profile", "relayRoot"];
  if (!(exact(value, required) || exact(value, [...required, "consume"]) && value.consume === true)) return null;
  if (typeof value.relayRoot !== "string" || !value.relayRoot || value.relayRoot.includes("\0")
    || typeof value.profile !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.profile)
    || typeof value.nativeSession !== "string" || !/^ses_[A-Za-z0-9_-]{1,120}$/.test(value.nativeSession)
    || !Array.isArray(value.bindings) || value.bindings.length < 1 || value.bindings.length > 16) return null;
  const identities = new Set();
  for (const binding of value.bindings) {
    if (!exact(binding, ["authority", "epoch", "sid", "worker"])
      || typeof binding.authority !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(binding.authority)
      || typeof binding.worker !== "string" || !WORKER.test(binding.worker)
      || typeof binding.sid !== "string" || !NATIVE_ID.test(binding.sid)
      || !Number.isSafeInteger(binding.epoch) || binding.epoch < 0) return null;
    const identity = JSON.stringify([binding.authority, binding.worker, binding.sid, binding.epoch]);
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
  const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort();
    rejectAbort(controller.signal.reason);
  };
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation(controller.signal);
    })]);
  }
  finally {
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

export function createOpenCodePlugin({ callBridge = callOpenCodeBridge } = {}) {
  if (typeof callBridge !== "function") throw new TypeError("OpenCode bridge function is invalid");
  return {
    id: "pugzui-relay-delivery",
    async setup(ctx) {
      const options = pluginOptions(ctx.options);
      if (ctx.app?.version !== SUPPORTED_VERSION || !options || !ctx.session || typeof ctx.session.get !== "function" || typeof ctx.session.prompt !== "function" || typeof ctx.session.wait !== "function" || typeof ctx.session.hook !== "function" || typeof ctx.event?.subscribe !== "function") return;
      if (options.consume === true && (!ctx.tool || typeof ctx.tool.transform !== "function" || typeof ctx.tool.list !== "function")) {
        throw new Error("OpenCode native tool API is unavailable for recipient consumption");
      }
      let targetInfo;
      try {
        targetInfo = await withNativeDeadline(new AbortController().signal, SESSION_READ_MS,
          (signal) => ctx.session.get({ sessionID: options.nativeSession }, { signal }));
      }
      catch { return; }
      if (!targetInfo || targetInfo.id !== options.nativeSession) return;

      const attempts = new Map();
      let contextAttempts = new Set();
      const lifecycle = new AbortController();
      const eventLifecycle = new AbortController();
      const nativeReads = new Map();
      const bindingIds = [];
      let stopPromise = null;
      let reconnectPromise = null;
      let contextHook;
      let modelHook;
      let toolTransform;
      let recipientSession;
      let loop = Promise.resolve();
      let eventLoop = Promise.resolve();
      const runtimeInstance = `opencode-${process.pid}-${Math.floor(Date.now() - process.uptime() * 1000)}`;
      const makeTarget = () => Object.freeze({ runtimeInstance, profile: options.profile, nativeSession: options.nativeSession, lifecycleGeneration: randomUUID() });
      let target = makeTarget();
      const capabilities = Object.freeze({ context: true, idle: true, launch: false });

      // The native SDK can ignore abort. Reuse pending reads instead of leaking one per poll.
      const readNative = (method) => {
        if (nativeReads.has(method)) return nativeReads.get(method);
        const pending = Promise.resolve().then(() => ctx.session[method]({ sessionID: options.nativeSession }, { signal: lifecycle.signal }));
        nativeReads.set(method, pending);
        const clear = () => { if (nativeReads.get(method) === pending) nativeReads.delete(method); };
        void pending.then(clear, clear);
        return pending;
      };

      const report = (attemptId, entry) => {
        const observation = { state: entry.state, nativeRequestId: entry.nativeRequestId };
        entry.reportQueue = (entry.reportQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
          if (!bindingIds.length || lifecycle.signal.aborted) return;
          await callBridge(options.relayRoot, "delivery.observe", {
            bindingId: bindingIds[0], attemptId, observation,
          }, lifecycle.signal);
        });
        return entry.reportQueue;
      };

      async function bindBridge(fresh = false) {
        if (fresh) {
          const oldIds = bindingIds.splice(0);
          for (const bindingId of oldIds) await callBridge(options.relayRoot, "delivery.close", { bindingId }).catch(() => {});
          target = makeTarget();
        }
        const nextIds = [];
        try {
          for (const binding of options.bindings) {
            const registration = await callBridge(options.relayRoot, "delivery.bind", {
              ...binding,
              ...(options.consume === true ? { consume: true } : {}),
              profile: options.profile,
              target,
              capabilities,
            }, lifecycle.signal);
            if (!registration || typeof registration.bindingId !== "string" || !NATIVE_ID.test(registration.bindingId)) throw new Error("Relay binding was rejected");
            nextIds.push(registration.bindingId);
            if (lifecycle.signal.aborted) {
              for (const bindingId of nextIds) await callBridge(options.relayRoot, "delivery.close", { bindingId }).catch(() => {});
              return;
            }
          }
          if (lifecycle.signal.aborted) {
            for (const bindingId of nextIds) await callBridge(options.relayRoot, "delivery.close", { bindingId }).catch(() => {});
            return;
          }
          bindingIds.push(...nextIds);
          if (recipientSession) {
            await recipientSession.rebind(options.bindings.map((binding, index) => ({ ...binding, id: bindingIds[index] })));
          }
          for (const [attemptId, entry] of attempts) {
            if (entry.state === "context_observed" || entry.state === "turn_started") await report(attemptId, entry);
          }
        } catch (error) {
          for (const bindingId of nextIds) await callBridge(options.relayRoot, "delivery.close", { bindingId }).catch(() => {});
          bindingIds.splice(0);
          throw error;
        }
      }

      async function reconnect() {
        if (lifecycle.signal.aborted) return false;
        if (reconnectPromise) return reconnectPromise;
        reconnectPromise = (async () => {
          for (const [index, waitMs] of [0, 250, 500, 1000, 2000].entries()) {
            if (index && lifecycle.signal.aborted) return false;
            if (waitMs) await new Promise((resolveWait) => {
              const timer = setTimeout(() => {
                lifecycle.signal.removeEventListener("abort", cancel);
                resolveWait();
              }, waitMs);
              const cancel = () => { clearTimeout(timer); resolveWait(); };
              lifecycle.signal.addEventListener("abort", cancel, { once: true });
              timer.unref?.();
            });
            if (lifecycle.signal.aborted) return false;
            try {
              await bindBridge(true);
              return true;
            } catch {}
          }
          await stop();
          return false;
        })().finally(() => { reconnectPromise = null; });
        return reconnectPromise;
      }

      const onContext = (event) => {
        if (event?.sessionID !== options.nativeSession) return;
        contextAttempts.clear();
        const messageIds = currentMessageIds(event, options.nativeSession);
        if (!messageIds) return;
        for (const [attemptId, entry] of attempts) {
          if (!messageIds.has(entry.nativeRequestId)) continue;
          if (entry.state === "unknown") {
            entry.state = "context_observed";
            void report(attemptId, entry).catch(() => { void reconnect(); });
          }
          if (entry.state === "context_observed") contextAttempts.add(attemptId);
        }
      };
      const onModelRequest = (event) => {
        if (event?.sessionID !== options.nativeSession || event.kind !== "primary") return;
        const currentContext = contextAttempts;
        contextAttempts = new Set();
        for (const attemptId of currentContext) {
          const entry = attempts.get(attemptId);
          if (!entry || entry.state !== "context_observed") continue;
          entry.state = "turn_started";
          void report(attemptId, entry).catch(() => { void reconnect(); });
        }
      };

      try {
        contextHook = await ctx.session.hook("context", onContext);
        modelHook = await ctx.session.hook("model.request", onModelRequest);
        await bindBridge();
        if (options.consume === true) {
          recipientSession = createRecipientSession({
            relayRoot: options.relayRoot,
            bindings: options.bindings.map((binding, index) => ({ ...binding, id: bindingIds[index] })),
            bridge: async (request, signal) => {
              try {
                return await callBridge(options.relayRoot, "delivery.recipient", request, signal);
              } catch (error) {
                if (!lifecycle.signal.aborted) void reconnect().catch(() => {});
                throw error;
              }
            },
          });
          await recipientSession.start();
          const tools = recipientTools(recipientSession, options.nativeSession);
          toolTransform = await ctx.tool.transform((editor) => {
            const current = editor.list();
            if (current.length > 256 || tools.some((tool) => current.some((entry) => entry.id === tool.name))) {
              throw new Error("OpenCode recipient tool names conflict with the native tool set");
            }
            for (const tool of tools) editor.add(tool);
          });
          const installed = await ctx.tool.list();
          if (tools.some((tool) => !installed.some((entry) => entry.id === tool.name))) throw new Error("OpenCode recipient tools were not registered");
        }
      } catch {
        lifecycle.abort();
        eventLifecycle.abort();
        await recipientSession?.close().catch(() => {});
        await dispose(toolTransform).catch(() => {});
        await dispose(contextHook).catch(() => {});
        await dispose(modelHook).catch(() => {});
        for (const bindingId of bindingIds) await callBridge(options.relayRoot, "delivery.close", { bindingId }).catch(() => {});
        return;
      }

      const callNative = async (command) => {
        if (command.method === "status") {
          try {
            const session = await withNativeDeadline(lifecycle.signal, SESSION_READ_MS,
              () => readNative("get"));
            if (!session || session.id !== options.nativeSession) return { state: "unknown" };
            let waitSignal;
            try {
              await withNativeDeadline(lifecycle.signal, 200, (signal) => {
                waitSignal = signal;
                return readNative("wait");
              });
              return { state: "idle" };
            } catch {
              return { state: waitSignal?.aborted && !lifecycle.signal.aborted ? "busy" : "unknown" };
            }
          } catch {
            return { state: "unknown" };
          }
        }
        if (command.method === "submit") {
          const input = command.args;
          if (!input || typeof input.attemptId !== "string" || typeof input.notice !== "string" || !input.notice || Buffer.byteLength(input.notice, "utf8") > 4096) throw new Error("Invalid Relay notice");
          if (attempts.size >= 128) return { accepted: false, state: "held" };
          const nativeRequestId = generatedMessageId(input.attemptId);
          const entry = { nativeRequestId, state: "unknown" };
          attempts.set(input.attemptId, entry);
          const accepted = await withNativeDeadline(lifecycle.signal, NATIVE_CALL_MS, (signal) => ctx.session.prompt({
            sessionID: options.nativeSession,
            id: nativeRequestId,
            text: input.notice,
            delivery: "queue",
            resume: true,
          }, { signal }));
          if (!accepted || accepted.id !== nativeRequestId) throw new Error("Native admission could not be tied to the Relay attempt");
          return { accepted: true, nativeRequestId };
        }
        throw new Error("Unsupported native operation");
      };

      async function stop() {
        if (stopPromise) return stopPromise;
        lifecycle.abort();
        eventLifecycle.abort();
        stopPromise = (async () => {
          await recipientSession?.close().catch(() => {});
          await dispose(contextHook).catch(() => {});
          await dispose(modelHook).catch(() => {});
          await dispose(toolTransform).catch(() => {});
          for (const bindingId of bindingIds) await callBridge(options.relayRoot, "delivery.close", { bindingId }).catch(() => {});
          contextAttempts.clear();
          nativeReads.clear();
        })();
        return stopPromise;
      }

      loop = (async () => {
        while (!lifecycle.signal.aborted) {
          const bindingId = bindingIds[0];
          let next;
          try {
            next = await callBridge(options.relayRoot, "delivery.next", { bindingId }, lifecycle.signal);
          } catch {
            if (lifecycle.signal.aborted) break;
            if (!await reconnect()) break;
            continue;
          }
          if (!next || next.command === null) continue;
          const command = next.command;
          if (!command || typeof command.callId !== "string" || !["status", "submit"].includes(command.method)) {
            await stop();
            break;
          }
          let result;
          try { result = await callNative(command); }
          catch {
            // Native admission may have succeeded before the SDK rejected or timed out.
            // Keep its attempt unknown and never submit it again.
            await stop();
            break;
          }
          try {
            await callBridge(options.relayRoot, "delivery.complete", { bindingId, callId: command.callId, result }, lifecycle.signal);
          } catch {
            if (lifecycle.signal.aborted || !await reconnect()) break;
          }
        }
      })();

      eventLoop = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: eventLifecycle.signal })) {
            if (!EXECUTION_ENDED.has(event?.type) || event.data?.sessionID !== options.nativeSession) continue;
            for (const [attemptId, entry] of attempts) {
              if (entry.state !== "turn_started" || entry.waitingForIdle) continue;
              // Passive idle confirmation must outlive command deadlines without blocking the event feed.
              entry.waitingForIdle = true;
              void readNative("wait").then(async () => {
                entry.waitingForIdle = false;
                if (eventLifecycle.signal.aborted || attempts.get(attemptId) !== entry || entry.state !== "turn_started") return;
                entry.state = "safe_idle";
                await report(attemptId, entry);
                attempts.delete(attemptId);
              }, () => {
                entry.waitingForIdle = false;
              }).catch(() => { void reconnect(); });
            }
            void recipientSession?.activationEnded().catch(() => {});
          }
        } catch {
          if (!eventLifecycle.signal.aborted) await stop();
        }
      })();

      return async () => {
        await stop();
        await Promise.all([loop.catch(() => {}), eventLoop.catch(() => {})]);
      };
    },
  };
}
