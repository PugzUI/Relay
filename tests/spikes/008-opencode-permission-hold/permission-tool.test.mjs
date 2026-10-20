import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./permission-tool.mjs";

async function fixture(t, failHook = false) {
  const controlRoot = await mkdtemp(join(tmpdir(), "relay-permission-tool-"));
  t.after(() => rm(controlRoot, { recursive: true, force: true }));
  const execute = async () => ({ content: "NATIVE_READ_FIXTURE" });
  const read = { id: "read", name: "read", execute, options: { codemode: true, pinned: true } };
  const tools = [read, { id: "shell", name: "shell" }];
  let after;
  let disposed = 0;
  const ctx = {
    app: { version: "2.0.27" },
    options: { nativeSession: "ses_fixture", controlRoot },
    tool: {
      transform: (edit) => {
        edit({
          list: () => [...tools],
          remove: (id) =>
            tools.splice(
              tools.findIndex((tool) => tool.id === id),
              1,
            ),
          update: (id, change) => change(tools.find((tool) => tool.id === id)),
        });
        return {
          dispose: () => {
            disposed++;
          },
        };
      },
      hook: (name, callback) => {
        if (failHook) throw new Error("Fixture hook setup refused");
        assert.equal(name, "execute.after");
        after = callback;
        return {
          dispose: () => {
            disposed++;
          },
        };
      },
      list: async () => tools,
    },
  };
  return { controlRoot, execute, read, tools, ctx, after: () => after, disposed: () => disposed };
}

test("native permission fixture retains the real read executor and exposes no other tool", async (t) => {
  const value = await fixture(t);
  const cleanup = await plugin.setup(value.ctx);
  t.after(cleanup);
  assert.deepEqual(
    value.tools.map((tool) => tool.id),
    ["read"],
  );
  assert.equal(value.read.execute, value.execute);
  assert.deepEqual(value.read.options, { codemode: false });
  assert.equal(
    JSON.parse(await readFile(join(value.controlRoot, "registered.json"), "utf8"))
      .nativeExecutorPreserved,
    true,
  );
});

test("native read observer records only exact-scope metadata and fences callbacks after cleanup", async (t) => {
  const value = await fixture(t);
  const cleanup = await plugin.setup(value.ctx);
  const after = value.after();
  await after({
    tool: "read",
    sessionID: "ses_other",
    status: "completed",
    id: "call_other",
    messageID: "msg_other",
  });
  await assert.rejects(readFile(join(value.controlRoot, "native-after.json")), { code: "ENOENT" });
  await after({
    tool: "read",
    sessionID: "ses_fixture",
    status: "error",
    id: "call_fixture",
    messageID: "msg_fixture",
    error: { message: "PRIVATE_FIXTURE_BODY" },
  });
  const raw = await readFile(join(value.controlRoot, "native-after.json"), "utf8");
  assert.equal(raw.includes("PRIVATE_FIXTURE_BODY"), false);
  assert.equal(JSON.parse(raw).status, "error");
  await cleanup();
  await cleanup();
  assert.equal(value.disposed(), 2);
  await after({
    tool: "read",
    sessionID: "ses_fixture",
    status: "completed",
    id: "call_fixture",
    messageID: "msg_fixture",
  });
  assert.equal(await readFile(join(value.controlRoot, "native-after.json"), "utf8"), raw);
});

test("native permission fixture rolls back its transform when hook setup fails", async (t) => {
  const value = await fixture(t, true);
  await assert.rejects(plugin.setup(value.ctx), /Fixture hook setup refused/);
  assert.equal(value.disposed(), 1);
});
