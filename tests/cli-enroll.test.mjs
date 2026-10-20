import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { main } from "../src/cli.mjs";
import { setup } from "../src/relay.mjs";

test("enroll awaits config loading and reports a missing config", async () => {
  const parent = await mkdtemp(join(tmpdir(), "relay-cli-enroll-"));
  const root = resolve(parent, "store");
  try {
    setup({ root, device: "enroll" });
    let stderr = "";
    const io = {
      stdin: null,
      stdout: { write() {} },
      stderr: {
        write(value) {
          stderr += value;
        },
      },
    };
    const code = await main(
      ["enroll", "--root", root, "--config", join(parent, "missing.json")],
      io,
    );
    assert.notEqual(code, 0);
    assert.match(stderr, /Config file cannot be read/);
    assert.doesNotMatch(stderr, /config has no fixed hub binding/);
  } finally {
    assert.ok(root.startsWith(`${resolve(parent)}${sep}`));
    await rm(parent, { recursive: true, force: true });
  }
});
