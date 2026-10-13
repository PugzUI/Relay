import { rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export default {
  id: "relay-native-permission-tool",
  async setup(ctx) {
    const { nativeSession, controlRoot } = ctx.options ?? {};
    if (ctx.app?.version !== "2.0.27" || !/^ses_[A-Za-z0-9_-]{1,120}$/.test(nativeSession ?? "")
      || typeof controlRoot !== "string" || !isAbsolute(controlRoot) || controlRoot.includes("\0")) {
      throw new Error("Invalid isolated native permission tool options");
    }
    const registrations = [];
    let closed = false;
    let stopping;
    let writes = Promise.resolve();
    const publish = (name, value) => (writes = writes.then(async () => {
      const path = join(controlRoot, name);
      await writeFile(`${path}.pending`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${path}.pending`, path);
    }));
    const cleanup = () => stopping ??= (async () => {
      closed = true;
      const errors = [];
      for (const registration of registrations) {
        try { await registration.dispose(); } catch (error) { errors.push(error); }
      }
      try { await writes; } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Native permission tool cleanup failed");
    })();
    try {
      registrations.push(await ctx.tool.transform((editor) => {
        const tools = editor.list();
        if (tools.length > 256 || tools.filter((tool) => tool.id === "read" && tool.name === "read").length !== 1) {
          throw new Error("Expected native read tool was not found");
        }
        for (const tool of tools) if (tool.id !== "read") editor.remove(tool.id);
        editor.update("read", (tool) => {
          const options = { ...tool.options };
          delete options.pinned;
          tool.options = { ...options, codemode: false };
        });
      }));
      registrations.push(await ctx.tool.hook("execute.after", async (event) => {
        if (closed || event.sessionID !== nativeSession || event.tool !== "read") return;
        if (!["completed", "error"].includes(event.status)
          || ![event.id, event.messageID].every((value) => typeof value === "string" && value.length > 0 && value.length <= 256)) {
          throw new Error("Native read observation identity differs");
        }
        await publish("native-after.json", { version: ctx.app.version, status: event.status,
          callId: event.id, messageId: event.messageID });
      }));
      const tools = await ctx.tool.list();
      if (tools.length !== 1 || tools[0].id !== "read") throw new Error("Native read was not the sole exposed tool");
      await publish("registered.json", { version: ctx.app.version, tools: ["read"], nativeExecutorPreserved: true });
    } catch (error) {
      try { await cleanup(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Native permission tool setup and cleanup failed"); }
      throw error;
    }
    return cleanup;
  },
};
