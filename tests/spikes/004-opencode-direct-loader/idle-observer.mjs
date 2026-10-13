import { writeFile, rename } from "node:fs/promises";
import { isAbsolute } from "node:path";

export default {
  id: "relay-native-idle-observer",
  async setup(ctx) {
    const { nativeSession, reportPath } = ctx.options ?? {};
    if (ctx.app?.version !== "2.0.27" || !/^ses_[A-Za-z0-9_-]{1,120}$/.test(nativeSession ?? "")
      || typeof reportPath !== "string" || reportPath.includes("\0") || !isAbsolute(reportPath)
      || typeof ctx.session?.get !== "function" || typeof ctx.session?.wait !== "function") {
      throw new Error("Invalid isolated idle observation options");
    }
    const session = await ctx.session.get({ sessionID: nativeSession }, { signal: AbortSignal.timeout(3000) });
    if (session?.id !== nativeSession) throw new Error("Isolated native session identity differs");
    await ctx.session.wait({ sessionID: nativeSession }, { signal: AbortSignal.timeout(3000) });
    await writeFile(`${reportPath}.pending`, JSON.stringify({
      version: ctx.app.version, exactSessionConfigured: true, initialIdle: true,
    }), { mode: 0o600 });
    await rename(`${reportPath}.pending`, reportPath);
  },
};
