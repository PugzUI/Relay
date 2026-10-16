import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as cli from "../src/cli.mjs";
import { credential, privateFile, withTempDir } from "./network-helpers.mjs";

async function clipboardFixture(run, script) {
  await withTempDir(async (root) => {
    const { token } = credential();
    const tokenFile = await privateFile(join(root, "viewer.token"), `${token}\n`);
    const record = join(root, "record.json");
    if (script) await writeFile(join(root, "wl-copy"), `#!${process.execPath}\n${script}`, { mode: 0o700 });
    const env = { ...process.env, PATH: root, WAYLAND_DISPLAY: "fixture-display", XDG_RUNTIME_DIR: root,
      RELAY_CLIPBOARD_RECORD: record, RELAY_CLIPBOARD_DIGEST: createHash("sha256").update(token).digest("hex") };
    await run({ tokenFile, record, env });
  });
}

test("local clipboard copy sends only the validated token on stdin, never in argv", { skip: process.platform === "win32" }, async () => {
  await clipboardFixture(async ({ tokenFile, record, env }) => {
    assert.equal(await cli.copyViewerToken(tokenFile, { env }), true);
    const observed = JSON.parse(await readFile(record, "utf8"));
    assert.deepEqual(observed.args, ["--type", "text/plain", "--sensitive"]);
    assert.equal(observed.matches, true);
  }, `import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
await writeFile(process.env.RELAY_CLIPBOARD_RECORD, JSON.stringify({ args: process.argv.slice(2),
  matches: createHash("sha256").update(input).digest("hex") === process.env.RELAY_CLIPBOARD_DIGEST }), { mode: 0o600 });
`);
});

test("a missing clipboard command is a nonfatal copy failure", async () => {
  await clipboardFixture(async ({ tokenFile, env }) => {
    assert.equal(await cli.copyViewerToken(tokenFile, { env }), false);
  });
});

test("a refused clipboard copy is not reported as success", { skip: process.platform === "win32" }, async () => {
  await clipboardFixture(async ({ tokenFile, env }) => {
    assert.equal(await cli.copyViewerToken(tokenFile, { env }), false);
  }, "process.exit(1);\n");
});

test("headless startup does not invoke a clipboard command", async () => {
  assert.equal(await cli.copyViewerToken("unused", { env: {} }), false);
});

test("clipboard cancellation does not wait for a stalled command", { skip: process.platform === "win32" }, async () => {
  await clipboardFixture(async ({ tokenFile, record, env }) => {
    const controller = new AbortController();
    const copy = cli.copyViewerToken(tokenFile, { env, signal: controller.signal });
    try {
      let started = false;
      const deadline = Date.now() + 1_000;
      while (!started && Date.now() < deadline) {
        try { await readFile(record); started = true; }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(started, true, "Clipboard child did not start");
      controller.abort();
      assert.equal(await copy, false);
    } finally { controller.abort(); await copy; }
  }, `import { writeFile } from "node:fs/promises";
await writeFile(process.env.RELAY_CLIPBOARD_RECORD, "started");
process.stdin.resume(); setInterval(() => {}, 1_000);
`);
});

test("a stalled clipboard command reaches its deadline", { skip: process.platform === "win32" }, async () => {
  await clipboardFixture(async ({ tokenFile, env }) => {
    assert.equal(await cli.copyViewerToken(tokenFile, { env }), false);
  }, "process.stdin.resume(); setInterval(() => {}, 1_000);\n");
});

test("serve permits disabling automatic clipboard copy without changing local defaults", () => {
  const parsed = cli.parseArgs(["serve", "--no-copy-token"]);
  assert.equal(parsed.defaultLocal, true);
  assert.equal(parsed.flags["no-copy-token"], true);
});
