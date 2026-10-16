import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, loadRegistrySync } from "../src/auth.mjs";

test("both registry readers reject writerless FIFOs without blocking", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-registry-fifo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fifo = join(root, "credentials.json");
  const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 1000 });
  assert.equal(created.status, 0, created.stderr);
  const code = `
    const {loadRegistry,loadRegistrySync}=await import(process.argv[1]);
    const results=[];
    for(const read of [loadRegistry,loadRegistrySync]) {
      try {await read(process.argv[2]);results.push('accepted')}
      catch(error){results.push(error.code)}
    }
    process.stdout.write(JSON.stringify(results));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code,
    new URL("../src/auth.mjs", import.meta.url).href, fifo], { encoding: "utf8", timeout: 3000, maxBuffer: 2048 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["unavailable", "unavailable"]);
  assert.equal((await lstat(fifo)).isFIFO(), true);
});

test("bounded registry readers preserve valid JSON and refuse oversized files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-registry-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "credentials.json");
  await writeFile(file, JSON.stringify({ version: 1, credentials: [] }), { mode: 0o600 });
  assert.deepEqual((await loadRegistry(file)).credentials, []);
  assert.deepEqual(loadRegistrySync(file).credentials, []);
  await writeFile(file, " ".repeat(1_048_577));
  await assert.rejects(loadRegistry(file), { code: "unavailable" });
  assert.throws(() => loadRegistrySync(file), { code: "unavailable" });
});
