import { access, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TOOL = "relay_probe_gate";

export default {
  id: "relay-native-tool-gate",
  async setup(ctx) {
    const { nativeSession, nonce, controlRoot } = ctx.options ?? {};
    if (ctx.app?.version !== "2.0.27" || !/^ses_[A-Za-z0-9_-]{1,120}$/.test(nativeSession ?? "")
      || !/^[0-9a-f]{16}$/.test(nonce ?? "") || typeof controlRoot !== "string"
      || !isAbsolute(controlRoot) || controlRoot.includes("\0")) throw new Error("Invalid isolated native tool gate options");
    const lifecycle = new AbortController();
    const registrations = [];
    let called = false;
    let execution;
    let writes = Promise.resolve();
    const publish = (name, value) => (writes = writes.then(async () => {
      const path = join(controlRoot, name);
      await writeFile(`${path}.pending`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${path}.pending`, path);
    }));
    const cleanup = async () => {
      lifecycle.abort();
      const errors = [];
      for (const registration of registrations) {
        try { await registration.dispose(); } catch (error) { errors.push(error); }
      }
      if (execution) {
        try { await execution; } catch (error) { if (error.name !== "AbortError") errors.push(error); }
      }
      try { await writes; } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Native tool gate cleanup failed");
    };
    try {
      registrations.push(await ctx.tool.transform((editor) => {
        const tools = editor.list();
        if (tools.length > 256) throw new Error("Isolated tool inventory exceeded its bound");
        for (const tool of tools) editor.remove(tool.id);
        editor.add({
          name: TOOL,
          description: "Wait for the isolated controller's release marker. Call once with the supplied nonce before replying to the preparation message.",
          input: { type: "object", properties: { nonce: { type: "string", const: nonce } }, required: ["nonce"], additionalProperties: false },
          options: { permission: TOOL, codemode: false },
          execute: async (input, context) => {
            if (lifecycle.signal.aborted || called || context.sessionID !== nativeSession || context.agent !== "relay-probe"
              || !input || Object.keys(input).join(",") !== "nonce" || input.nonce !== nonce
              || !(context.signal instanceof AbortSignal) || context.signal.aborted) throw new Error("Native tool gate invocation refused");
            called = true;
            execution = (async () => {
              const startedAt = Date.now();
              const signal = AbortSignal.any([context.signal, lifecycle.signal, AbortSignal.timeout(30000)]);
              let released = false;
              await publish("ready.json", { version: ctx.app.version, sameSession: true, agentMatches: true,
                callId: context.id, messageId: context.messageID, startedAt });
              try {
                while (!signal.aborted) {
                  try { await access(join(controlRoot, "release")); released = true; break; }
                  catch (error) { if (error.code !== "ENOENT") throw error; }
                  await delay(25, undefined, { signal });
                }
                signal.throwIfAborted();
                return { content: `TOOL_RELEASED_${nonce}` };
              } finally {
                await publish("complete.json", { startedAt, completedAt: Date.now(), released,
                  aborted: signal.aborted, nativeAborted: context.signal.aborted });
              }
            })();
            return execution;
          },
        });
      }));
      registrations.push(await ctx.tool.hook("execute.after", async (event) => {
        if (lifecycle.signal.aborted || event.sessionID !== nativeSession || event.tool !== TOOL) return;
        const content = event.result?.content;
        const text = typeof content === "string" ? content
          : Array.isArray(content) && content.length === 1 && content[0]?.type === "text" ? content[0].text : null;
        await publish("native-after.json", { status: event.status, callId: event.id,
          resultMatches: event.status === "completed" && text === `TOOL_RELEASED_${nonce}` });
      }));
      const tools = await ctx.tool.list();
      if (tools.length !== 1 || tools[0].id !== TOOL) throw new Error("Native tool gate was not the only registered tool");
      await publish("registered.json", { version: ctx.app.version, tools: [TOOL] });
    } catch (error) {
      try { await cleanup(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Native tool gate setup and cleanup failed"); }
      throw error;
    }
    return cleanup;
  },
};
