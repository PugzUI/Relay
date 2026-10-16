import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDeliveryAdapter } from "../src/adapters/opencode.mjs";
import { callOpenCodeBridge, openCodeSocketPath } from "../src/adapters/opencode-bridge.mjs";

async function rootFor(t) {
  const root = await mkdtemp(join(tmpdir(), "relay-bridge-io-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("bridge rejects malformed UTF-8 before invoking a native binding", async (t) => {
  const root = await rootFor(t);
  let calls = 0;
  const adapter = await startDeliveryAdapter({ client: "opencode", root,
    signal: new AbortController().signal, onEvidence() {},
    bind: async () => { calls++; return { close: async () => {}, observe: () => true }; },
  });
  t.after(() => adapter.close());
  const token = await readFile(join(root, "opencode-delivery.token"), "utf8");
  const text = JSON.stringify({ v: 1, rid: "utf8-test", op: "delivery.bind", args: {
    authority: "authority", worker: "fixture:worker:001", sid: "session", epoch: 1,
    profile: "replace-byte", target: { profile: "replace-byte", nativeSession: "native",
      runtimeInstance: "runtime", lifecycleGeneration: "life" },
    capabilities: { context: true, idle: true, launch: false },
  } });
  const body = Buffer.from(text.replaceAll("replace-byte", "X"));
  for (let index = 0; index < body.length; index++) if (body[index] === 88) body[index] = 0xff;
  const status = await new Promise((resolve, reject) => {
    const req = request({ socketPath: openCodeSocketPath(root), path: "/v1/call", method: "POST",
      headers: { authorization: `Relay ${token}`, "content-type": "application/json", "content-length": body.length },
      signal: AbortSignal.timeout(2000),
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end(body);
  });
  assert.equal(status, 400);
  assert.equal(calls, 0);
});

test("bridge client rejects malformed UTF-8 in a successful response", async (t) => {
  const root = await rootFor(t);
  await writeFile(join(root, "opencode-delivery.token"), "a".repeat(64), { mode: 0o600 });
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const { rid } = JSON.parse(Buffer.concat(chunks).toString());
    const body = Buffer.from(JSON.stringify({ v: 1, rid, ok: true, result: "X",
      time: Date.now(), replayed: false, remainingMs: null }));
    body[body.indexOf('"X"') + 1] = 0xff;
    res.writeHead(200, { "content-type": "application/json", "content-length": body.length }); res.end(body);
  });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(openCodeSocketPath(root), resolve); });
  await assert.rejects(callOpenCodeBridge(root, "delivery.next", { bindingId: "test" }, AbortSignal.timeout(2000)));
});

test("bridge token reads and adapter startup reject writerless FIFOs without blocking", { skip: process.platform === "win32" }, async (t) => {
  const root = await rootFor(t);
  const fifo = join(root, "opencode-delivery.token");
  const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 1000 });
  assert.equal(created.status, 0, created.stderr);
  const program = `
    const {callOpenCodeBridge} = await import(process.argv[1]);
    const {startDeliveryAdapter} = await import(process.argv[2]);
    let rejected = false;
    try { await callOpenCodeBridge(process.argv[3], 'delivery.next', {}); }
    catch { rejected = true; }
    const evidence = [];
    const adapter = await startDeliveryAdapter({client:'opencode',root:process.argv[3],
      signal:new AbortController().signal,bind:async()=>{throw new Error('unexpected binding')},
      onEvidence:value=>evidence.push(value)});
    await adapter.close();
    process.stdout.write(JSON.stringify({rejected,unsupported:evidence.includes('unsupported')}));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program,
    new URL("../src/adapters/opencode-bridge.mjs", import.meta.url).href,
    new URL("../src/adapters/opencode.mjs", import.meta.url).href, root],
  { encoding: "utf8", timeout: 3000, maxBuffer: 2048 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { rejected: true, unsupported: true });
  assert.equal((await lstat(fifo)).isFIFO(), true, "an unsafe foreign token target is preserved");
});

test("bridge calls have a total deadline even after partial response bytes", async (t) => {
  const root = await rootFor(t);
  await writeFile(join(root, "opencode-delivery.token"), "a".repeat(64), { mode: 0o600 });
  const caller = new AbortController();
  const originalTimeout = globalThis.setTimeout;
  let expire;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms === 18000) expire = () => callback(...args);
    return originalTimeout(callback, ms, ...args);
  });
  let received;
  const arrived = new Promise((resolve) => { received = resolve; });
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"v":1,');
    received();
  });
  t.after(async () => {
    caller.abort(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(openCodeSocketPath(root), resolve); });
  const outcome = callOpenCodeBridge(root, "delivery.next", { bindingId: "test" }, caller.signal)
    .then(() => ({ accepted: true }), (error) => ({ error }));
  await arrived;
  assert.equal(typeof expire, "function", "an absolute deadline is installed independently of socket traffic");
  expire();
  const result = await outcome;
  assert.equal(result.error?.message, "Native bridge call timed out");
});
