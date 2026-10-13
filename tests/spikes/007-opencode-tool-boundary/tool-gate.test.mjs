import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import freeProvider from "../003-opencode-native-delivery/free-provider.mjs";

const options = { baseURL: "http://127.0.0.1:8080/v1", route: "openrouter/free", contextTokens: 2048, outputTokens: 1024 };

test("isolated free provider exposes tools only after an explicit boolean opt-in", async () => {
  for (const tools of [undefined, false, true]) {
    let model;
    const cleanup = await freeProvider.setup({
      options: { ...options, ...(tools === undefined ? {} : { tools }) },
      provider: { transform: async (edit) => {
        edit({ add: (value) => { [model] = value.models; } });
        return { dispose: async () => {} };
      } },
      session: { hook: async () => ({ dispose: async () => {} }) },
    });
    try { assert.equal(model.capabilities.tools, tools === true); }
    finally { await cleanup(); }
  }
});

async function fixture(t) {
  const { default: gate } = await import("./tool-gate.mjs");
  const controlRoot = await mkdtemp(join(process.env.TMPDIR, "relay-tool-gate-"));

  let tool;
  let after;
  const removed = [];
  const cleanup = await gate.setup({
    app: { version: "2.0.27" },
    options: { nativeSession: "ses_tool_fixture", nonce: "0000000000000000", controlRoot },
    tool: {
      transform: async (edit) => {
        edit({ list: () => [{ id: "bash" }], remove: (id) => removed.push(id), add: (value) => { tool = value; } });
        return { dispose: async () => {} };
      },
      list: async () => [{ ...tool, id: tool.name }],
      hook: async (name, callback) => { assert.equal(name, "execute.after"); after = callback; return { dispose: async () => {} }; },
    },
  });
  t.after(async () => { try { await cleanup(); } finally { await rm(controlRoot, { recursive: true, force: true }); } });
  const context = { sessionID: "ses_tool_fixture", agent: "relay-probe", messageID: "msg_fixture", id: "call_fixture", signal: new AbortController().signal };
  return { controlRoot, tool, after, removed, context, cleanup };
}

async function waitForReady(controlRoot) {
  for (let count = 0; count < 40; count++) {
    try { return JSON.parse(await readFile(join(controlRoot, "ready.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  throw new Error("Tool gate did not become active");
}

test("native tool gate stays active until its owned release marker exists", async (t) => {
  const { controlRoot, tool, after, removed, context } = await fixture(t);
  assert.deepEqual(removed, ["bash"]);
  let finished = false;
  const execution = tool.execute({ nonce: "0000000000000000" }, context).then((value) => { finished = true; return value; });
  const ready = await waitForReady(controlRoot);
  assert.equal(ready.callId, context.id);
  assert.equal(finished, false);
  await writeFile(join(controlRoot, "release"), "release\n", { mode: 0o600 });
  const result = await execution;
  assert.equal(result.content, "TOOL_RELEASED_0000000000000000");
  await after({ ...context, tool: tool.name, status: "completed", result: { content: [{ type: "text", text: result.content }] } });
  const complete = JSON.parse(await readFile(join(controlRoot, "complete.json"), "utf8"));
  assert.equal(complete.released, true);
  assert.equal(complete.aborted, false);
  assert.equal(JSON.parse(await readFile(join(controlRoot, "native-after.json"), "utf8")).status, "completed");
  assert.equal(JSON.parse(await readFile(join(controlRoot, "native-after.json"), "utf8")).resultMatches, true);
});

test("native tool gate refuses another session, invalid input, and duplicate invocation", async (t) => {
  const { controlRoot, tool, context } = await fixture(t);
  await assert.rejects(tool.execute({ nonce: "0000000000000000" }, { ...context, sessionID: "ses_other_fixture" }), /invocation refused/);
  await assert.rejects(tool.execute({ nonce: "0000000000000001" }, context), /invocation refused/);
  await assert.rejects(tool.execute({ nonce: "0000000000000000", extra: true }, context), /invocation refused/);
  const execution = tool.execute({ nonce: "0000000000000000" }, context);
  await waitForReady(controlRoot);
  await assert.rejects(tool.execute({ nonce: "0000000000000000" }, context), /invocation refused/);
  await writeFile(join(controlRoot, "release"), "release\n", { mode: 0o600 });
  await execution;
});

test("native tool gate cancellation and teardown leave no pending execution or late callback", async (t) => {
  for (const nativeAbort of [true, false]) {
    await t.test(nativeAbort ? "native cancellation" : "plugin teardown", async (t) => {
      const { controlRoot, tool, context, after, cleanup } = await fixture(t);
      const controller = new AbortController();
      const execution = tool.execute({ nonce: "0000000000000000" }, { ...context, signal: controller.signal });
      const rejected = assert.rejects(execution, (error) => error.name === "AbortError");
      await waitForReady(controlRoot);
      if (nativeAbort) controller.abort();
      await cleanup();
      await rejected;
      const complete = JSON.parse(await readFile(join(controlRoot, "complete.json"), "utf8"));
      assert.equal(complete.released, false);
      assert.equal(complete.aborted, true);
      assert.equal(complete.nativeAborted, nativeAbort);
      await after({ ...context, tool: tool.name, status: "completed", result: { content: "TOOL_RELEASED_0000000000000000" } });
      await assert.rejects(readFile(join(controlRoot, "native-after.json")), { code: "ENOENT" });
    });
  }
});

test("isolated free provider refuses non-boolean tool opt-ins before registering", async () => {
  for (const tools of [null, 1, "true"]) {
    await assert.rejects(freeProvider.setup({ options: { ...options, tools } }), /Invalid isolated free provider/);
  }
});
