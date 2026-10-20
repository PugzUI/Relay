import { writeFile, rename } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_CALLS = 8;
const MAX_BYTES = 128 * 1024;
const MAX_ROLES = 64;
const BODY_DEADLINE_MS = 3000;
const MODEL_ID = /^[A-Za-z0-9_:/.-]{1,256}$/;
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,120}$/;
const CHALLENGE_ID = /^(READY|DELIVERED)_[0-9a-f]{16}$/;
const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);
const NOTICE_PREFIX = "Relay pending state changed.";
const FAILURES = ["missing_body", "cancelled", "body_limit", "body_deadline", "model_unobserved"];

const errorCode = (error) =>
  FAILURES.includes(error?.message) ? error.message : "observation_failed";

function validOptions(ctx, nativeSession, reportPath, challenges) {
  if (ctx.app?.version !== "2.0.27") return false;
  if (!SESSION_ID.test(nativeSession ?? "")) return false;
  if (typeof reportPath !== "string" || !isAbsolute(reportPath) || reportPath.includes("\0"))
    return false;
  if (!Array.isArray(challenges) || challenges.length !== 2) return false;
  return challenges.every((value) => CHALLENGE_ID.test(value));
}

async function consumeBody(reader, decoder, select, state) {
  while (!state.stopped) {
    const { value, done } = await reader.read();
    if (state.stopped) throw new Error("cancelled");
    if (done) return select(state.text + decoder.decode(), true);
    state.bytes += value.byteLength;
    if (state.bytes > MAX_BYTES) throw new Error("body_limit");
    state.text += decoder.decode(value, { stream: true });
    const result = select(state.text, false);
    if (result !== null) return result;
  }
}

async function inspectBody(body, select) {
  if (!body) throw new Error("missing_body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = { text: "", bytes: 0, stopped: false };
  let timer;
  const reading = consumeBody(reader, decoder, select, state);
  try {
    return await Promise.race([
      reading,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("body_deadline")), BODY_DEADLINE_MS);
      }),
    ]);
  } finally {
    state.stopped = true;
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
    } catch {
      /* Incomplete SSE lines are retried after the next chunk. */
    }
  }
  if (done) throw new Error("model_unobserved");
  return null;
}

const parseRequestBody = (text, done) => (done ? JSON.parse(text) : null);

function messageContent(message) {
  return typeof message?.content === "string" ? message.content : "";
}

function requestRoles(messages) {
  return messages
    .slice(0, MAX_ROLES)
    .map((message) => (ROLES.has(message?.role) ? message.role : "unknown"));
}

function challengeFlags(messages, challenges) {
  return challenges.map((value) =>
    messages.some(
      (message) => message?.role === "system" && messageContent(message).includes(value),
    ),
  );
}

function hasRelayNotice(messages) {
  return messages.some(
    (message) => message?.role === "user" && messageContent(message).startsWith(NOTICE_PREFIX),
  );
}

function projectRequest(input, challenges, requestUrl) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  return {
    chat: new URL(requestUrl).pathname.endsWith("/chat/completions"),
    model: typeof input.model === "string" && MODEL_ID.test(input.model) ? input.model : null,
    stream: typeof input.stream === "boolean" ? input.stream : null,
    maxTokens:
      Number.isSafeInteger(input.max_tokens) && input.max_tokens > 0 ? input.max_tokens : null,
    tools: Array.isArray(input.tools) ? input.tools.length : 0,
    roles: requestRoles(messages),
    messagesTruncated: messages.length > MAX_ROLES,
    challengesInSystem: challengeFlags(messages, challenges),
    relayNotice: hasRelayNotice(messages),
  };
}

async function captureRequest(call, request, challenges) {
  try {
    const input = await inspectBody(request.clone().body, parseRequestBody);
    call.request = projectRequest(input, challenges, request.url);
  } catch (error) {
    call.requestError = errorCode(error);
  }
}

async function captureResponse(call, response) {
  try {
    call.responseModel = await inspectBody(response.clone().body, responseModel);
  } catch (error) {
    call.responseError = errorCode(error);
  }
}

async function disposeRegistrations(registrations, tasks, writes) {
  const errors = [];
  for (const registration of registrations) {
    try {
      await registration.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const result of await Promise.allSettled([...tasks, writes])) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  return errors;
}

export default {
  id: "relay-native-inference-observer",
  async setup(ctx) {
    const { nativeSession, reportPath, challenges } = ctx.options ?? {};
    if (!validOptions(ctx, nativeSession, reportPath, challenges)) {
      throw new Error("Invalid isolated inference observation options");
    }
    const calls = [];
    const requests = new WeakMap();
    const tasks = new Set();
    const registrations = [];
    let closed = false;
    let writes = Promise.resolve();
    const track = (operation) => {
      const task = operation();
      tasks.add(task);
      void task.finally(() => tasks.delete(task)).catch(() => {});
      return task;
    };
    const publish = () =>
      (writes = writes.then(async () => {
        await writeFile(
          `${reportPath}.pending`,
          JSON.stringify({ version: ctx.app.version, calls }),
          { mode: 0o600 },
        );
        await rename(`${reportPath}.pending`, reportPath);
      }));
    const matches = (event) =>
      !closed && event.sessionID === nativeSession && event.kind === "primary";
    const cleanup = async () => {
      closed = true;
      const errors = await disposeRegistrations(registrations, tasks, writes);
      if (errors.length) throw new AggregateError(errors, "Inference observer cleanup failed");
    };
    try {
      await publish();
      registrations.push(
        await ctx.session.hook("http.request", (event) => {
          if (!matches(event) || calls.length >= MAX_CALLS) return;
          const call = { kind: event.kind, expectedAgent: event.agent === "relay-probe" };
          calls.push(call);
          requests.set(event.request, call);
          return track(async () => {
            await captureRequest(call, event.request, challenges);
            await publish();
          });
        }),
      );
      registrations.push(
        await ctx.session.hook("http.response", (event) => {
          if (!matches(event)) return;
          const call = requests.get(event.request);
          if (!call || call.status !== undefined) return;
          call.status = event.response.status;
          void track(async () => {
            await captureResponse(call, event.response);
            await publish();
          });
        }),
      );
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Inference observer setup and cleanup failed",
        );
      }
      throw error;
    }
    return cleanup;
  },
};
