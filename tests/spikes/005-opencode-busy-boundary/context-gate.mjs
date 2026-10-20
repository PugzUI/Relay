import { access, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const APP_VERSION = "2.0.27";
const RELEASE_POLL_MS = 25;
const RELEASE_TIMEOUT_MS = 30_000;
const WAIT_ABORT_MS = 200;

function readOptions(ctx) {
  const { nativeSession, primeId, controlRoot } = ctx.options ?? {};
  const valid =
    ctx.app?.version === APP_VERSION &&
    /^ses_[A-Za-z0-9_-]{1,120}$/.test(nativeSession ?? "") &&
    /^msg_busy_[0-9a-f]{16}$/.test(primeId ?? "") &&
    typeof controlRoot === "string" &&
    isAbsolute(controlRoot);
  if (!valid) throw new Error("Invalid isolated native context gate options");
  return { nativeSession, primeId, controlRoot };
}

async function publish(controlRoot, name, value) {
  const path = join(controlRoot, name);
  await writeFile(`${path}.pending`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.pending`, path);
}

function isPrimeContext(event, nativeSession, primeId) {
  if (event.sessionID !== nativeSession) return false;
  return Boolean(event.messages?.some((message) => message.id === primeId));
}

async function observeNativeWait(ctx, controlRoot, nativeSession, waitAbort) {
  const waitingAt = Date.now();
  const waitTimer = setTimeout(() => waitAbort.abort(), WAIT_ABORT_MS);
  let outcome = "resolved";
  let errorName = null;
  try {
    await ctx.session.wait({ sessionID: nativeSession }, { signal: waitAbort.signal });
  } catch (error) {
    outcome = "rejected";
    errorName = error.name;
  } finally {
    clearTimeout(waitTimer);
  }
  await publish(controlRoot, "wait-observation.json", {
    outcome,
    errorName,
    aborted: waitAbort.signal.aborted,
    elapsedMs: Date.now() - waitingAt,
  });
}

async function awaitRelease(controlRoot, signal, startedAt) {
  while (!signal.aborted && Date.now() - startedAt < RELEASE_TIMEOUT_MS) {
    try {
      await access(join(controlRoot, "release"));
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(RELEASE_POLL_MS, undefined, { signal });
  }
  return false;
}

async function handleContext(ctx, state, event) {
  if (state.held) return;
  if (!isPrimeContext(event, state.nativeSession, state.primeId)) return;
  state.held = true;
  const startedAt = Date.now();
  await publish(state.controlRoot, "ready.json", {
    version: ctx.app.version,
    sameSession: true,
    primeSeen: true,
    startedAt,
  });
  void observeNativeWait(ctx, state.controlRoot, state.nativeSession, state.waitAbort).catch(
    (error) => console.error("Native wait diagnostic failed:", error.name),
  );
  let released = false;
  try {
    released = await awaitRelease(state.controlRoot, state.lifecycle.signal, startedAt);
  } finally {
    await publish(state.controlRoot, "complete.json", {
      startedAt,
      completedAt: Date.now(),
      released,
      aborted: state.lifecycle.signal.aborted,
    });
  }
  if (!released || state.lifecycle.signal.aborted) {
    throw new Error("Controlled native context did not finish normally");
  }
}

export default {
  id: "relay-native-context-gate",
  async setup(ctx) {
    const { nativeSession, primeId, controlRoot } = readOptions(ctx);
    const lifecycle = new AbortController();
    const waitAbort = new AbortController();
    const state = { nativeSession, primeId, controlRoot, lifecycle, waitAbort, held: false };
    const registration = await ctx.session.hook("context", (event) =>
      handleContext(ctx, state, event),
    );
    return async () => {
      lifecycle.abort();
      waitAbort.abort();
      await registration.dispose();
    };
  },
};
