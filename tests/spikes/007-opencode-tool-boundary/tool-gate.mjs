import { access, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TOOL = "relay_probe_gate";
const PROBE_AGENT = "relay-probe";
const MAX_TOOLS = 256;
const RELEASE_POLL_MS = 25;
const EXECUTION_TIMEOUT_MS = 30000;

function validOptions(ctx, nativeSession, nonce, controlRoot) {
  return (
    ctx.app?.version === "2.0.27" &&
    /^ses_[A-Za-z0-9_-]{1,120}$/.test(nativeSession ?? "") &&
    /^[0-9a-f]{16}$/.test(nonce ?? "") &&
    typeof controlRoot === "string" &&
    isAbsolute(controlRoot) &&
    !controlRoot.includes("\0")
  );
}

function permitted({ lifecycle, called, nativeSession, nonce, input, context }) {
  if (lifecycle.signal.aborted || called) return false;
  if (context.sessionID !== nativeSession || context.agent !== PROBE_AGENT) return false;
  if (!input || Object.keys(input).join(",") !== "nonce" || input.nonce !== nonce) return false;
  return context.signal instanceof AbortSignal && !context.signal.aborted;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text")
    return content[0].text;
  return null;
}

export default {
  id: "relay-native-tool-gate",
  async setup(ctx) {
    const { nativeSession, nonce, controlRoot } = ctx.options ?? {};
    if (!validOptions(ctx, nativeSession, nonce, controlRoot)) {
      throw new Error("Invalid isolated native tool gate options");
    }
    const lifecycle = new AbortController();
    const registrations = [];
    let called = false;
    let execution;
    let writes = Promise.resolve();

    const publish = (name, value) => {
      writes = writes.then(async () => {
        const path = join(controlRoot, name);
        await writeFile(`${path}.pending`, JSON.stringify(value), { mode: 0o600 });
        await rename(`${path}.pending`, path);
      });
      return writes;
    };

    const waitForRelease = async (signal) => {
      while (!signal.aborted) {
        try {
          await access(join(controlRoot, "release"));
          return true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await delay(RELEASE_POLL_MS, undefined, { signal });
      }
      return false;
    };

    const run = async (context) => {
      const startedAt = Date.now();
      const signal = AbortSignal.any([
        context.signal,
        lifecycle.signal,
        AbortSignal.timeout(EXECUTION_TIMEOUT_MS),
      ]);
      let released = false;
      await publish("ready.json", {
        version: ctx.app.version,
        sameSession: true,
        agentMatches: true,
        callId: context.id,
        messageId: context.messageID,
        startedAt,
      });
      try {
        released = await waitForRelease(signal);
        signal.throwIfAborted();
        return { content: `TOOL_RELEASED_${nonce}` };
      } finally {
        await publish("complete.json", {
          startedAt,
          completedAt: Date.now(),
          released,
          aborted: signal.aborted,
          nativeAborted: context.signal.aborted,
        });
      }
    };

    const disposeRegistrations = async () => {
      const errors = [];
      for (const registration of registrations) {
        try {
          await registration.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      return errors;
    };

    const settleExecution = async () => {
      if (!execution) return [];
      try {
        await execution;
        return [];
      } catch (error) {
        return error.name === "AbortError" ? [] : [error];
      }
    };

    const cleanup = async () => {
      lifecycle.abort();
      const errors = [...(await disposeRegistrations()), ...(await settleExecution())];
      try {
        await writes;
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "Native tool gate cleanup failed");
    };

    try {
      registrations.push(
        await ctx.tool.transform((editor) => {
          const tools = editor.list();
          if (tools.length > MAX_TOOLS)
            throw new Error("Isolated tool inventory exceeded its bound");
          for (const tool of tools) editor.remove(tool.id);
          editor.add({
            name: TOOL,
            description:
              "Wait for the isolated controller's release marker. Call once with the supplied nonce before replying to the preparation message.",
            input: {
              type: "object",
              properties: { nonce: { type: "string", const: nonce } },
              required: ["nonce"],
              additionalProperties: false,
            },
            options: { permission: TOOL, codemode: false },
            execute: (input, context) => {
              if (!permitted({ lifecycle, called, nativeSession, nonce, input, context })) {
                return Promise.reject(new Error("Native tool gate invocation refused"));
              }
              called = true;
              execution = run(context);
              return execution;
            },
          });
        }),
      );
      registrations.push(
        await ctx.tool.hook("execute.after", async (event) => {
          if (lifecycle.signal.aborted || event.sessionID !== nativeSession || event.tool !== TOOL)
            return;
          await publish("native-after.json", {
            status: event.status,
            callId: event.id,
            resultMatches:
              event.status === "completed" &&
              resultText(event.result?.content) === `TOOL_RELEASED_${nonce}`,
          });
        }),
      );
      const tools = await ctx.tool.list();
      if (tools.length !== 1 || tools[0].id !== TOOL) {
        throw new Error("Native tool gate was not the only registered tool");
      }
      await publish("registered.json", { version: ctx.app.version, tools: [TOOL] });
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Native tool gate setup and cleanup failed",
        );
      }
      throw error;
    }
    return cleanup;
  },
};
