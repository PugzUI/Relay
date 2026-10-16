import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.mjs";

test("config rejects non-object documents with a stable input fault", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-config-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const value of [null, [], true, 1, "config"]) {
    const file = join(root, "config.json");
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(readConfig(file), { code: "input", message: "Config must be an object" });
  }
});

test("config size errors identify the rejected condition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-config-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "config.json");
  await writeFile(file, " ".repeat(1_048_577), { mode: 0o600 });
  await assert.rejects(readConfig(file), { code: "input", message: "Config file is too large" });
});
