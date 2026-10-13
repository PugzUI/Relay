import { writeFile, rename } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_CALLS = 8;
const MAX_BYTES = 128 * 1024;
const MAX_ROLES = 64;
const MODEL_ID = /^[A-Za-z0-9_:/.-]{1,256}$/;
const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);
const errorCode = (error) => ["missing_body", "cancelled", "body_limit", "body_deadline", "model_unobserved"].includes(error?.message)
  ? error.message : "observation_failed";

async function inspectBody(body, select) {
  if (!body) throw new Error("missing_body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let stopped = false;
  let timer;
  const reading = (async () => {
    while (!stopped) {
      const { value, done } = await reader.read();
      if (stopped) throw new Error("cancelled");
      if (done) return select(text + decoder.decode(), true);
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("body_limit");
      text += decoder.decode(value, { stream: true });
      const result = select(text, false);
      if (result !== null) return result;
    }
  })();
  try {
    return await Promise.race([reading, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("body_deadline")), 3000);
    })]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    // A tee branch's cancellation waits for the original consumer; never await it here.
    void reader.cancel().catch(() => {});
  }
}

function responseModel(text, done) {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const model = JSON.parse(line.slice(5)).model;
      if (typeof model === "string" && MODEL_ID.test(model)) return model;
    } catch { /* Incomplete SSE lines are retried after the next chunk. */ }
  }
  if (done) throw new Error("model_unobserved");
  return null;
}

export default {
  id: "relay-native-inference-observer",
  async setup(ctx) {
    const { nativeSession, reportPath, challenges } = ctx.options ?? {};
    if (ctx.app?.version !== "2.0.27" || !/^ses_[A-Za-z0-9_-]{1,120}$/.test(nativeSession ?? "")
      || typeof reportPath !== "string" || !isAbsolute(reportPath) || reportPath.includes("\0")
      || !Array.isArray(challenges) || challenges.length !== 2
      || !challenges.every((value) => /^(READY|DELIVERED)_[0-9a-f]{16}$/.test(value))) {
      throw new Error("Invalid isolated inference observation options");
    }
    const calls = [];
    const requests = new WeakMap();
    const tasks = new Set();
    const track = (operation) => {
      const task = operation();
      tasks.add(task);
      void task.finally(() => tasks.delete(task)).catch(() => {});
      return task;
    };
    const registrations = [];
    let closed = false;
    let writes = Promise.resolve();
    const publish = () => (writes = writes.then(async () => {
      await writeFile(`${reportPath}.pending`, JSON.stringify({ version: ctx.app.version, calls }), { mode: 0o600 });
      await rename(`${reportPath}.pending`, reportPath);
    }));
    const matches = (event) => !closed && event.sessionID === nativeSession && event.kind === "primary";
    const cleanup = async () => {
      closed = true;
      const errors = [];
      for (const registration of registrations) {
        try { await registration.dispose(); } catch (error) { errors.push(error); }
      }
      for (const result of await Promise.allSettled([...tasks, writes])) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      if (errors.length) throw new AggregateError(errors, "Inference observer cleanup failed");
    };
    try {
      await publish();
      registrations.push(await ctx.session.hook("http.request", (event) => {
        if (!matches(event) || calls.length >= MAX_CALLS) return;
        const call = { kind: event.kind, expectedAgent: event.agent === "relay-probe" };
        calls.push(call);
        requests.set(event.request, call);
        return track(async () => {
          try {
            const input = await inspectBody(event.request.clone().body, (text, done) => done ? JSON.parse(text) : null);
            const messages = Array.isArray(input.messages) ? input.messages : [];
            const content = (message) => typeof message?.content === "string" ? message.content : "";
            call.request = {
              chat: new URL(event.request.url).pathname.endsWith("/chat/completions"),
              model: typeof input.model === "string" && MODEL_ID.test(input.model) ? input.model : null,
              stream: typeof input.stream === "boolean" ? input.stream : null,
              maxTokens: Number.isSafeInteger(input.max_tokens) && input.max_tokens > 0 ? input.max_tokens : null,
              tools: Array.isArray(input.tools) ? input.tools.length : 0,
              roles: messages.slice(0, MAX_ROLES).map((message) => ROLES.has(message?.role) ? message.role : "unknown"),
              messagesTruncated: messages.length > MAX_ROLES,
              challengesInSystem: challenges.map((value) => messages.some((message) => message?.role === "system" && content(message).includes(value))),
              relayNotice: messages.some((message) => message?.role === "user" && content(message).startsWith("Relay pending state changed.")),
            };
          } catch (error) { call.requestError = errorCode(error); }
          await publish();
        });
      }));
      registrations.push(await ctx.session.hook("http.response", (event) => {
        if (!matches(event)) return;
        const call = requests.get(event.request);
        if (!call || call.status !== undefined) return;
        call.status = event.response.status;
        void track(async () => {
          try { call.responseModel = await inspectBody(event.response.clone().body, responseModel); }
          catch (error) { call.responseError = errorCode(error); }
          await publish();
        });
      }));
    } catch (error) {
      try { await cleanup(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Inference observer setup and cleanup failed"); }
      throw error;
    }
    return cleanup;
  },
};
