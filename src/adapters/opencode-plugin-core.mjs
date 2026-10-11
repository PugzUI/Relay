import { createHash, randomUUID } from "node:crypto";
import { callOpenCodeBridge } from "./opencode-bridge.mjs";

const SUPPORTED_VERSION = "2.0.26";
const WORKER = /^[A-Za-z0-9._-]{1,63}:[A-Za-z0-9._-]{1,32}:(?:prime|[0-9]{3,32})$/;
const NATIVE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SESSION_READ_MS = 3000;
const NATIVE_CALL_MS = 8000;
const MESSAGE_SCAN_LIMIT = 4096;

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function pluginOptions(value) {
  if (!exact(value, ["bindings", "nativeSession", "profile", "relayRoot"])) return null;
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
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try { return await operation(controller.signal); }
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

export function createOpenCodePlugin() {
  return {
    id: "pugzui-relay-delivery",
    async setup(ctx) {
      const options = pluginOptions(ctx.options);
      if (ctx.app?.version !== SUPPORTED_VERSION || !options || !ctx.session || typeof ctx.session.get !== "function" || typeof ctx.session.prompt !== "function" || typeof ctx.session.wait !== "function" || typeof ctx.session.hook !== "function" || typeof ctx.event?.subscribe !== "function") return;
      let targetInfo;
      try {
        targetInfo = await withNativeDeadline(new AbortController().signal, SESSION_READ_MS,
          (signal) => ctx.session.get({ sessionID: options.nativeSession }, { signal }));
      }
      catch { return; }
      if (!targetInfo || targetInfo.id !== options.nativeSession) return;

      const attempts = new Map();
      const lifecycle = new AbortController();
      const eventLifecycle = new AbortController();
      const bindingIds = [];
      let stopPromise = null;
      let contextHook;
      let modelHook;
      let loop = Promise.resolve();
      let eventLoop = Promise.resolve();
      const target = Object.freeze({
        runtimeInstance: `opencode-${process.pid}-${Math.floor(Date.now() - process.uptime() * 1000)}`,
        profile: options.profile,
        nativeSession: options.nativeSession,
        lifecycleGeneration: randomUUID(),
      });
      const capabilities = Object.freeze({ context: true, idle: true, launch: false });

      const report = async (attemptId, entry) => {
        if (!bindingIds.length || lifecycle.signal.aborted) return;
        await callOpenCodeBridge(options.relayRoot, "delivery.observe", {
          bindingId: bindingIds[0],
          attemptId,
          observation: { state: entry.state, nativeRequestId: entry.nativeRequestId },
        }, lifecycle.signal);
      };

      const onContext = (event) => {
        const messageIds = currentMessageIds(event, options.nativeSession);
        if (!messageIds) return;
        for (const [attemptId, entry] of attempts) {
          if (entry.state !== "unknown" || !messageIds.has(entry.nativeRequestId)) continue;
          entry.state = "context_observed";
          void report(attemptId, entry).catch(() => { void stop(); });
        }
      };
      const onModelRequest = (event) => {
        const messageIds = currentMessageIds(event, options.nativeSession);
        if (!messageIds) return;
        for (const [attemptId, entry] of attempts) {
          if (entry.state !== "context_observed" || !messageIds.has(entry.nativeRequestId)) continue;
          entry.state = "turn_started";
          void report(attemptId, entry).catch(() => { void stop(); });
        }
      };

      try {
        contextHook = await ctx.session.hook("context", onContext);
        modelHook = await ctx.session.hook("model.request", onModelRequest);
        for (const binding of options.bindings) {
          const registration = await callOpenCodeBridge(options.relayRoot, "delivery.bind", {
            ...binding,
            profile: options.profile,
            target,
            capabilities,
          }, lifecycle.signal);
          if (!registration || typeof registration.bindingId !== "string" || !NATIVE_ID.test(registration.bindingId)) throw new Error("Relay binding was rejected");
          bindingIds.push(registration.bindingId);
        }
      } catch {
        lifecycle.abort();
        eventLifecycle.abort();
        await dispose(contextHook).catch(() => {});
        await dispose(modelHook).catch(() => {});
        for (const bindingId of bindingIds) await callOpenCodeBridge(options.relayRoot, "delivery.close", { bindingId }).catch(() => {});
        return;
      }

      const callNative = async (command) => {
        if (command.method === "status") {
          try {
            const session = await withNativeDeadline(lifecycle.signal, SESSION_READ_MS,
              (signal) => ctx.session.get({ sessionID: options.nativeSession }, { signal }));
            if (!session || session.id !== options.nativeSession) return { state: "unknown" };
            const waitAbort = new AbortController();
            const timer = setTimeout(() => waitAbort.abort(), 200);
            try {
              await ctx.session.wait({ sessionID: options.nativeSession }, { signal: waitAbort.signal });
              return { state: "idle" };
            } catch {
              return { state: waitAbort.signal.aborted ? "busy" : "unknown" };
            } finally {
              clearTimeout(timer);
            }
          } catch {
            return { state: "unknown" };
          }
        }
        if (command.method === "submit") {
          const input = command.args;
          if (!input || typeof input.attemptId !== "string" || !input.notice || typeof input.notice.text !== "string" || Buffer.byteLength(input.notice.text, "utf8") > 4096) throw new Error("Invalid Relay notice");
          if (attempts.size >= 128) return { accepted: false, state: "held" };
          const nativeRequestId = generatedMessageId(input.attemptId);
          const entry = { nativeRequestId, state: "unknown" };
          attempts.set(input.attemptId, entry);
          const accepted = await withNativeDeadline(lifecycle.signal, NATIVE_CALL_MS, (signal) => ctx.session.prompt({
            sessionID: options.nativeSession,
            id: nativeRequestId,
            text: input.notice.text,
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
          await dispose(contextHook).catch(() => {});
          await dispose(modelHook).catch(() => {});
          for (const bindingId of bindingIds) await callOpenCodeBridge(options.relayRoot, "delivery.close", { bindingId }).catch(() => {});
          attempts.clear();
        })();
        return stopPromise;
      }

      loop = (async () => {
        try {
          while (!lifecycle.signal.aborted) {
            const bindingId = bindingIds[0];
            const next = await callOpenCodeBridge(options.relayRoot, "delivery.next", { bindingId }, lifecycle.signal);
            if (!next || next.command === null) continue;
            const command = next.command;
            if (!command || typeof command.callId !== "string" || !["status", "submit"].includes(command.method)) throw new Error("Invalid native command");
            const result = await callNative(command);
            await callOpenCodeBridge(options.relayRoot, "delivery.complete", { bindingId, callId: command.callId, result }, lifecycle.signal);
          }
        } catch {
          if (!lifecycle.signal.aborted) await stop();
        }
      })();

      eventLoop = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: eventLifecycle.signal })) {
            if (event?.type !== "session.status" || event.properties?.sessionID !== options.nativeSession || event.properties.status?.type !== "idle") continue;
            for (const [attemptId, entry] of attempts) {
              if (entry.state !== "turn_started") continue;
              entry.state = "safe_idle";
              await report(attemptId, entry);
              attempts.delete(attemptId);
            }
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
