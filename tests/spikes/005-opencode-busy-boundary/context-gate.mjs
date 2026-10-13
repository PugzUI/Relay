import { access, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export default {
  id: "relay-native-context-gate",
  async setup(ctx) {
    const { nativeSession, primeId, controlRoot } = ctx.options ?? {};
    if (ctx.app?.version !== "2.0.27" || !/^ses_[A-Za-z0-9_-]{1,120}$/.test(nativeSession ?? "")
      || !/^msg_busy_[0-9a-f]{16}$/.test(primeId ?? "") || typeof controlRoot !== "string" || !isAbsolute(controlRoot)) {
      throw new Error("Invalid isolated native context gate options");
    }
    const lifecycle = new AbortController();
    const waitAbort = new AbortController();
    let held = false;
    const publish = async (name, value) => {
      const path = join(controlRoot, name);
      await writeFile(`${path}.pending`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${path}.pending`, path);
    };
    const registration = await ctx.session.hook("context", async (event) => {
      if (held || event.sessionID !== nativeSession || !event.messages?.some((message) => message.id === primeId)) return;
      held = true;
      const startedAt = Date.now();
      await publish("ready.json", { version: ctx.app.version, sameSession: true, primeSeen: true, startedAt });
      const waitingAt = Date.now();
      const waitTimer = setTimeout(() => waitAbort.abort(), 200);
      const measureWait = async () => {
        let outcome = "resolved";
        let errorName = null;
        try { await ctx.session.wait({ sessionID: nativeSession }, { signal: waitAbort.signal }); }
        catch (error) { outcome = "rejected"; errorName = error.name; }
        finally { clearTimeout(waitTimer); }
        await publish("wait-observation.json", { outcome, errorName, aborted: waitAbort.signal.aborted, elapsedMs: Date.now() - waitingAt });
      };
      void measureWait().catch((error) => console.error("Native wait diagnostic failed:", error.name));
      let released = false;
      try {
        while (!lifecycle.signal.aborted && Date.now() - startedAt < 30000) {
          try {
            await access(join(controlRoot, "release"));
            released = true;
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await delay(25, undefined, { signal: lifecycle.signal });
        }
      } finally {
        await publish("complete.json", { startedAt, completedAt: Date.now(), released, aborted: lifecycle.signal.aborted });
      }
      if (!released || lifecycle.signal.aborted) throw new Error("Controlled native context did not finish normally");
    });
    return async () => {
      lifecycle.abort();
      waitAbort.abort();
      await registration.dispose();
    };
  },
};
