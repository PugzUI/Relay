import assert from "node:assert/strict";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { demoOptions } from "../scripts/demo.mjs";
import { connect } from "../src/index.mjs";

test("default demo options remain offline regardless of serve environment", () => {
  assert.deepEqual(demoOptions([], { RELAY_DEMO_PORT: "invalid", RELAY_DEMO_DURATION_MS: "invalid" }), { serve: false });
  assert.deepEqual(demoOptions(["--serve"], {}), { serve: true, port: 4200, durationMs: 300_000 });
  assert.deepEqual(demoOptions(["--serve", "--port", "4312", "--duration-ms", "2000"], {}), { serve: true, port: 4312, durationMs: 2000 });
  assert.throws(() => demoOptions(["--port", "4312"], {}), /require --serve/);
  assert.throws(() => demoOptions(["--serve", "--port", "0"], {}), /out of range/);
  assert.throws(() => demoOptions(["--serve", "--duration-ms", "999"], {}), /at least 1000/);
});

test("terminal demo prints receipts without starting a listener or exposing sessions", async () => {
  const result = await runDemo([]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.inbox.total, 1);
  assert.equal(output.work.total, 1);
  assert.equal(output.consumed.flat().length, 2);
  assert.ok(output.consumed.flat().every((receipt) => receipt.outcome === "done" && receipt.result));
  assert.equal("url" in output, false);
  assert.equal(/"sid"\s*:|"sessionId"\s*:/i.test(result.stdout), false);
});

test("serve mode refuses an existing token destination without changing it", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "relay-demo-token-test-"));
  const tokenFile = join(parent, "token");
  const target = join(parent, "target");
  await writeFile(target, "operator data\n", { mode: 0o600 });
  await symlink(target, tokenFile);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const result = await runDemo(["--serve"], { RELAY_DEMO_TOKEN_FILE: tokenFile });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /demo failed/);
  assert.match(result.stderr, /EEXIST/);
  assert.equal((await readFile(target, "utf8")), "operator data\n");
  assert.equal((await lstat(tokenFile)).isSymbolicLink(), true);
});

test("serve mode writes a private token, reports only its path, and cleans up on SIGTERM", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "relay-demo-test-"));
  const tokenFile = join(parent, "token");
  let child;
  t.after(async () => {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await rm(parent, { recursive: true, force: true });
  });
  const port = await freePort();
  child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/demo.mjs", import.meta.url)), "--serve", "--port", String(port), "--duration-ms", "30000"], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RELAY_DEMO_TOKEN_FILE: tokenFile },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const ready = await Promise.race([
    once(child.stdout, "data").then(() => true),
    once(child, "exit").then(([code]) => { throw new Error(`demo exited before ready (${code}): ${stderr}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("demo did not become ready")), 10_000); timer.unref(); }),
  ]);
  assert.equal(ready, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const token = (await readFile(tokenFile, "utf8")).trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  if (process.platform !== "win32") assert.equal((await stat(tokenFile)).mode & 0o077, 0);
  assert.ok(stdout.includes(tokenFile));
  assert.equal(stdout.includes(token), false);
  assert.equal(/"sid"\s*:|"sessionId"\s*:/i.test(stdout), false);
  assert.match(stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  const readyState = JSON.parse(stdout);
  const client = await connect({ url: `http://127.0.0.1:${port}`, tokenFile, mode: "local" });
  try {
    await client.snapshot({ limit: 64 });
    for (const board of ["bounty", `host:${readyState.device.id}`]) {
      await client.list({ board, kind: "msg", data: true });
      await client.list({ board, kind: "work", data: true });
    }
    await assert.rejects(client.register("worker", { slot: "001" }), (error) => error.code === "denied");
    await assert.rejects(client.post("invalid-session", "bounty", { msg: "denied" }), (error) => error.code === "denied");
    await assert.rejects(client.claim("invalid-session", { board: "bounty" }), (error) => error.code === "denied");
    await assert.rejects(client.stats(), (error) => error.code === "denied");
  } finally {
    await client.close();
  }
  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  await assert.rejects(stat(tokenFile), { code: "ENOENT" });
  assert.equal(stdout.includes(token), false);
});

async function runDemo(args, env = process.env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/demo.mjs", import.meta.url)), ...args], { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  const output = (stream) => new Promise((resolve) => {
    let value = "";
    stream.setEncoding("utf8").on("data", (chunk) => { value += chunk; });
    stream.on("end", () => resolve(value));
  });
  const stdout = output(child.stdout);
  const stderr = output(child.stderr);
  const [code] = await once(child, "exit");
  return { code, stdout: await stdout, stderr: await stderr };
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
