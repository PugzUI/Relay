import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, open, serve, setup } from "../src/index.mjs";
import { listCapacity, listLaunches } from "../src/relay.mjs";
import { createPool } from "../src/pool.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = path.resolve(os.tmpdir());
const workerName = "worker";

function assertPrivateRoot(root) {
  assert.ok(root.startsWith(`${scratchRoot}${path.sep}`), `test root must be beneath ${scratchRoot}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function emptyGrant() {
  return {
    enroll: [], register: [], workers: [], recipients: [], boardPost: [], boardClaim: [],
    inboxRead: [], workRead: [],
    inspect: { messages: false, receipts: false, audit: false, topology: false },
    reportDevice: null,
  };
}

function credential(principal, grant) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    entry: { principal, tokenDigest: createHash("sha256").update(token).digest("hex"), grant },
  };
}

async function privateWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, content, { mode: 0o600 });
}

async function createBroker(root, role, entries, { pool = null } = {}) {
  const port = await freePort();
  const credentialsFile = path.join(root, "credentials.json");
  const configFile = path.join(root, "broker.json");
  await privateWrite(credentialsFile, `${JSON.stringify({ version: 1, credentials: entries })}\n`);
  await privateWrite(configFile, `${JSON.stringify({
    version: 1,
    role,
    mode: "local",
    listen: { host: "127.0.0.1", port },
    tls: null,
    allowedPeers: [],
    credentialsFile: "./credentials.json",
    hub: null,
    pool,
    views: [],
  })}\n`);
  const broker = await serve({ root, configFile });
  try {
    assert.equal(broker.address.address, "127.0.0.1");
    assert.equal(broker.address.port, port);
  } catch (error) {
    await broker.close();
    throw error;
  }
  return { broker, url: `http://127.0.0.1:${port}` };
}

async function connectWithToken(url, root, token, name) {
  const tokenFile = path.join(root, `${name}.token`);
  await privateWrite(tokenFile, `${token}\n`);
  const client = await connect({ url, tokenFile, mode: "local" });
  return { client, tokenFile };
}

async function createPair(t) {
  const root = await mkdtemp(path.join(scratchRoot, "relay-integration-"));
  assertPrivateRoot(root);
  const owned = { clients: [], brokers: [], relays: [], pools: [], servers: [], roots: [root] };
  t.after(async () => {
    await cleanup([
      ...owned.pools.reverse().map((pool) => () => pool.close()),
      ...owned.clients.reverse().map((client) => () => client.close()),
      ...owned.relays.reverse().map((relay) => () => relay.close()),
      ...owned.brokers.reverse().map((broker) => () => broker.close()),
      ...owned.servers.reverse().map((server) => () => closeServer(server)),
      ...owned.roots.reverse().map((item) => async () => {
        assertPrivateRoot(item);
        await rm(item, { recursive: true, force: true });
      }),
    ]);
  });

  const hubRoot = path.join(root, "hub");
  const hostRoot = path.join(root, "host");
  await mkdir(hubRoot, { mode: 0o700 });
  await mkdir(hostRoot, { mode: 0o700 });
  const hubDevice = setup({ root: hubRoot, device: "hub", role: "hub" });
  const hostDevice = setup({ root: hostRoot, device: "east", role: "host" });
  const worker = `${hostDevice.name}:${workerName}:001`;
  const hostBoard = `host:${hostDevice.id}`;

  const hubGrant = emptyGrant();
  hubGrant.enroll = [{ deviceId: hostDevice.id, deviceName: hostDevice.name }];
  hubGrant.register = [{ deviceId: hostDevice.id, deviceName: hostDevice.name, runtimes: [workerName], allocate: false }];
  hubGrant.workers = [worker];
  hubGrant.recipients = [worker];
  hubGrant.boardPost = ["bounty"];
  hubGrant.boardClaim = ["bounty"];
  hubGrant.inboxRead = ["bounty"];
  hubGrant.workRead = ["bounty"];
  hubGrant.inspect = { messages: true, receipts: true, audit: true, topology: true };
  const hubCredential = credential("east-host", hubGrant);
  const hub = await createBroker(hubRoot, "hub", [hubCredential.entry]);
  owned.brokers.push(hub.broker);
  const hubConnection = await connectWithToken(hub.url, root, hubCredential.token, "hub");
  owned.clients.push(hubConnection.client);

  const hostGrant = emptyGrant();
  hostGrant.register = [{ deviceId: hostDevice.id, deviceName: hostDevice.name, runtimes: [workerName], allocate: true }];
  hostGrant.workers = [worker];
  hostGrant.recipients = [worker];
  hostGrant.boardPost = [hostBoard];
  hostGrant.boardClaim = [hostBoard];
  hostGrant.inboxRead = [hostBoard];
  hostGrant.workRead = [hostBoard];
  hostGrant.inspect = { messages: true, receipts: true, audit: true, topology: true };
  const hostCredential = credential("east-local", hostGrant);
  const host = await createBroker(hostRoot, "host", [hostCredential.entry]);
  owned.brokers.push(host.broker);
  const hostConnection = await connectWithToken(host.url, root, hostCredential.token, "host");
  owned.clients.push(hostConnection.client);

  const enrollment = await hubConnection.client.enroll(hostDevice);
  const repeated = await hubConnection.client.enroll(hostDevice);
  assert.deepEqual({ id: repeated.id, name: repeated.name, init: repeated.init }, { id: enrollment.id, name: enrollment.name, init: enrollment.init });
  assert.equal(enrollment.repeat, false);
  assert.equal(repeated.repeat, true);

  const hubAgent = await hubConnection.client.register(workerName, { slot: "001", caps: ["inspect"] });
  const hubSession = await hubConnection.client.join(hubAgent.id);
  const hostAgent = await hostConnection.client.register(workerName, { slot: "001", caps: ["inspect"] });
  const hostSession = await hostConnection.client.join(hostAgent.id);
  assert.equal(hubAgent.id, hostAgent.id);
  assert.equal(hubSession.worker, hostSession.worker);
  assert.notEqual(hubSession.id, hostSession.id);
  assert.notEqual(hubConnection.client.authority, hostConnection.client.authority);

  const local = open({ root: hostRoot });
  owned.relays.push(local);
  return {
    root, hubRoot, hostRoot, hubDevice, hostDevice, worker, hostBoard,
    hub: hubConnection.client, hubToken: hubCredential.token, hubTokenFile: hubConnection.tokenFile, hubUrl: hub.url,
    host: hostConnection.client, hostToken: hostCredential.token, hostTokenFile: hostConnection.tokenFile, hostUrl: host.url,
    hubSid: hubSession.id, hostSid: hostSession.id, local, owned,
  };
}

async function request(url, { method = "GET", token, body, headers = {}, maxBytes = 1_048_576 } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy(new Error("Integration response exceeded its byte bound"));
          return;
        }
        chunks.push(chunk);
      });
      res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(4000, () => req.destroy(new Error("Integration request timed out")));
    req.once("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function cleanup(actions) {
  const errors = [];
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Integration cleanup failed");
}

async function createResponseDropProxy(upstream, owned) {
  let armed = false;
  let dropped = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 131_072) {
        req.destroy(new Error("Fault proxy request exceeded its bound"));
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => {
      const body = Buffer.concat(chunks);
      let drop = false;
      if (armed && req.method === "POST" && req.url === "/v1/call") {
        const call = JSON.parse(body.toString("utf8"));
        drop = call.op === "claim" && call.args?.options?.board === "bounty";
      }
      const target = new URL(upstream);
      const outgoing = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (reply) => {
        if (drop) {
          dropped++;
          reply.resume();
          reply.once("end", () => res.destroy());
          return;
        }
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      });
      outgoing.once("error", (error) => res.destroy(error));
      outgoing.end(body);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  owned.servers.push(server);
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    arm() { armed = true; },
    disarm() { armed = false; },
    get dropped() { return dropped; },
  };
}

async function waitFor(check, label, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function parseSse(text) {
  const frames = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).find((line) => line.startsWith("data: "));
    if (data) frames.push(JSON.parse(data.slice(6)));
  }
  return frames;
}

async function readFeedEvent(url, token, cursor, mid) {
  const target = new URL("/v1/events", url);
  target.searchParams.set("cursor", cursor);
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let text = "";
    const req = http.get(target, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } }, (res) => {
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 65_536) {
          req.destroy(new Error("Feed exceeded its bounded integration read"));
          return;
        }
        text += chunk.toString("utf8");
        const match = parseSse(text).find((frame) => frame.event === "delta" && frame.data?.mid === mid);
        if (match) {
          req.destroy();
          resolve(match);
        }
      });
      res.once("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("Feed event timed out")), 4000);
    req.once("close", () => clearTimeout(timer));
    req.once("error", (error) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
  });
}

test("hub enrollment, device-qualified sessions, board isolation, and explicit msg/work panes", async (t) => {
  const env = await createPair(t);
  const msgBody = "work: keep this text in Inbox";
  const localMsg = await env.host.post(env.hostSid, env.hostBoard, { msg: msgBody }, { key: "local-msg" });
  const localWork = await env.host.post(env.hostSid, env.hostBoard, { work: { task: "local-only" } }, { key: "local-work" });
  const hubMsg = await env.hub.post(env.hubSid, "bounty", { msg: "hub inbox entry" }, { key: "hub-msg" });
  const hubWork = await env.hub.post(env.hubSid, "bounty", { work: { task: "shared" } }, { key: "hub-work" });

  const localInbox = await env.host.list({ board: env.hostBoard, kind: "msg", data: true });
  const localBounties = await env.host.list({ board: env.hostBoard, kind: "work", data: true });
  const hubInbox = await env.hub.list({ board: "bounty", kind: "msg", data: true });
  const hubBounties = await env.hub.list({ board: "bounty", kind: "work", data: true });
  assert.deepEqual(localInbox.items.map((item) => item.id), [localMsg.id]);
  assert.deepEqual(localBounties.items.map((item) => item.id), [localWork.id]);
  assert.deepEqual(hubInbox.items.map((item) => item.id), [hubMsg.id]);
  assert.deepEqual(hubBounties.items.map((item) => item.id), [hubWork.id]);
  assert.deepEqual(localInbox.items[0].data, { msg: msgBody });
  assert.equal(localInbox.items[0].kind, "msg");
  assert.equal(hubBounties.items[0].kind, "work");
  assert.equal(localBounties.items.some((item) => item.id === hubWork.id), false);
  assert.equal(hubBounties.items.some((item) => item.id === localWork.id), false);

  await assert.rejects(env.hub.list({ board: env.hostBoard }), (error) => error.code === "denied");
  await assert.rejects(env.host.list({ board: "bounty" }), (error) => error.code === "denied");
  const claimed = await env.host.claim(env.hostSid, { board: env.hostBoard });
  assert.equal(claimed.kind, "work");
  assert.equal(claimed.mid, localWork.id);
  assert.equal(claimed.msg, undefined);
  await env.host.ack(env.hostSid, claimed.id, "done");
  assert.equal((await env.host.list({ board: env.hostBoard, kind: "msg" })).items[0].state, "posted");
});

test("authenticated topology and committed feed expose metadata without payload or session data", async (t) => {
  const env = await createPair(t);
  const secretText = "private-payload-should-never-enter-global-feed";
  const admitted = await env.hub.post(env.hubSid, "bounty", { msg: secretText }, { key: "feed-secret" });
  const response = await request(`${env.hubUrl}/v1/topology`, { token: env.hubToken });
  assert.equal(response.status, 200);
  assert.match(response.headers["cache-control"], /no-store/);
  const snapshot = JSON.parse(response.text);
  assert.equal(snapshot.authority, env.hub.authority);
  for (const forbidden of [secretText, env.hubToken, env.hubSid, env.hostSid, env.hostRoot]) assert.equal(response.text.includes(forbidden), false);
  assert.ok(snapshot.boards.some((board) => board.id === "bounty" && board.authority === env.hub.authority));

  const next = await env.hub.post(env.hubSid, "bounty", { work: { task: "feed-event" } }, { key: "feed-work" });
  const event = await readFeedEvent(env.hubUrl, env.hubToken, snapshot.cursor, next.id);
  assert.equal(event.event, "delta");
  assert.equal(event.data.type, "post");
  assert.equal(event.data.mid, next.id);
  assert.equal(event.data.committed, true);
  const encoded = JSON.stringify(event);
  for (const forbidden of [secretText, env.hubToken, env.hubSid, env.hostSid, env.hostRoot]) assert.equal(encoded.includes(forbidden), false);
  assert.equal(admitted.id.length > 0, true);
});

test("Pool holds cross-authority capacity through a lost hub claim reply, recovers the same lease, then serves local work", async (t) => {
  const env = await createPair(t);
  const proxy = await createResponseDropProxy(env.hubUrl, env.owned);
  const uncertainHub = await connectWithToken(proxy.url, env.root, env.hubToken, "hub-proxied");
  env.owned.clients.push(uncertainHub.client);
  const pool = createPool({
    local: env.local,
    hub: uncertainHub.client,
    maxAgents: 2,
    maxJobs: 1,
    pollMs: 100,
    minBackoffMs: 100,
    maxBackoffMs: 300,
    launch: null,
  });
  env.owned.pools.push(pool);
  const remoteWork = await env.hub.post(env.hubSid, "bounty", { work: { task: "hub-first" } }, { key: "hub-first" });
  proxy.arm();
  const uncertain = await pool.claim({ worker: env.worker, localSid: env.hostSid, hubSid: env.hubSid });
  assert.equal(uncertain.state, "uncertain");
  assert.equal(uncertain.board, "bounty");
  assert.ok(proxy.dropped >= 1);
  const reserved = listCapacity(env.local, { worker: env.worker });
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].state, "reserved");
  assert.equal(reserved[0].rid, uncertain.rid);
  assert.equal(reserved[0].authority, env.hub.authority);

  const localWork = await env.host.post(env.hostSid, env.hostBoard, { work: { task: "local-waits" } }, { key: "local-waits" });
  const blocked = await pool.claim({ worker: env.worker, localSid: env.hostSid, hubSid: env.hubSid });
  assert.equal(blocked, null);
  assert.equal((await env.host.list({ board: env.hostBoard, kind: "work" })).items[0].state, "pending");

  proxy.disarm();
  const controller = new AbortController();
  let recovered;
  const start = pool.start({
    worker: env.worker,
    localSid: env.hostSid,
    hubSid: env.hubSid,
    signal: controller.signal,
    async execute(item) {
      recovered = item;
      return "done";
    },
  });
  try {
    await waitFor(async () => {
      const page = await env.hub.list({ board: "bounty", kind: "work" });
      return page.items.find((item) => item.id === remoteWork.id)?.state === "done";
    }, "recovered hub work settlement");
  } finally {
    controller.abort();
    await start;
  }
  assert.equal(recovered.state, "claimed");
  assert.equal(recovered.lease.mid, remoteWork.id);
  assert.equal(listCapacity(env.local, { worker: env.worker }).length, 0);

  const localClaim = await pool.claim({ worker: env.worker, localSid: env.hostSid, hubSid: env.hubSid });
  assert.equal(localClaim.state, "claimed");
  assert.equal(localClaim.authority, env.local.authority);
  assert.equal(localClaim.board, env.hostBoard);
  assert.equal(localClaim.lease.mid, localWork.id);
  const settled = await pool.settle({ worker: env.worker, item: localClaim, outcome: "done" });
  assert.equal(settled.state, "settled");
  assert.equal((await env.host.list({ board: env.hostBoard, kind: "work" })).items[0].state, "done");
});

test("native prime child registers before assignment and returns a result for the exact lease", async (t) => {
  const root = await mkdtemp(path.join(scratchRoot, "relay-prime-integration-"));
  assertPrivateRoot(root);
  const hostRoot = path.join(root, "host");
  await mkdir(hostRoot, { mode: 0o700 });
  const device = setup({ root: hostRoot, device: "primebox", role: "host" });
  const local = open({ root: hostRoot });
  let pool;
  let recoveryPool;
  let recoveryRelay;
  t.after(async () => {
    await cleanup([
      async () => { if (recoveryPool) await recoveryPool.close(); },
      async () => { if (pool) await pool.close(); },
      async () => { if (recoveryRelay) recoveryRelay.close(); },
      async () => local.close(),
      async () => { assertPrivateRoot(root); await rm(root, { recursive: true, force: true }); },
    ]);
  });

  const prime = local.register("controller", { slot: "prime", caps: [] });
  const primeSession = local.join(prime.id);
  const fixture = path.join(projectRoot, "tests", "fixtures", "integration", "prime-child.mjs");
  pool = createPool({
    local,
    hub: null,
    maxAgents: 2,
    maxJobs: 1,
    pollMs: 100,
    minBackoffMs: 100,
    maxBackoffMs: 300,
    launch: {
      runtime: workerName,
      executable: process.execPath,
      args: [fixture],
      cwd: root,
      capabilities: ["inspect"],
      maxChildren: 1,
      readyTimeoutMs: 3000,
    },
  });
  const launch = await pool.ensureCapacity({ primeSid: primeSession.id, demand: 1, readySpare: 0 });
  assert.equal(launch.state, "running");
  assert.equal(launch.device, device.id);
  assert.equal(launch.runtime, workerName);
  assert.equal(launch.worker, `${device.name}:${workerName}:001`);
  assert.equal(launch.epoch, 1);
  assert.ok(launch.handle.processStart);
  assert.ok(launch.handle.nonce);

  recoveryRelay = open({ root: hostRoot });
  recoveryPool = createPool({
    local: recoveryRelay,
    hub: null,
    maxAgents: 2,
    maxJobs: 1,
    pollMs: 100,
    minBackoffMs: 100,
    maxBackoffMs: 300,
    launch: null,
  });
  const reconciled = listLaunches(recoveryRelay, { activeOnly: true }).find((row) => row.id === launch.id);
  assert.equal(reconciled.state, "running");
  assert.deepEqual(reconciled.handle, launch.handle);
  assert.equal(reconciled.worker, launch.worker);
  await recoveryPool.close();
  recoveryPool = null;
  recoveryRelay.close();
  recoveryRelay = null;

  const board = `host:${device.id}`;
  const post = local.post(primeSession.id, board, { work: { task: "native-child-result" } }, { key: "prime-job" });
  const controller = new AbortController();
  let fallbackCalled = false;
  const start = pool.start({
    worker: launch.worker,
    localSid: launch.sid,
    signal: controller.signal,
    async execute() { fallbackCalled = true; return "failed"; },
  });
  try {
    await waitFor(() => {
      const row = local.get(post.id);
      return row?.state === "done" ? row : null;
    }, "native child task result");
  } finally {
    controller.abort();
    await start;
  }
  assert.equal(fallbackCalled, false);
  assert.equal(local.list({ board, kind: "work" }).items[0].state, "done");
});

test("Client refuses an authenticated redirect without forwarding the credential", async (t) => {
  const root = await mkdtemp(path.join(scratchRoot, "relay-redirect-integration-"));
  assertPrivateRoot(root);
  let captured = 0;
  const destination = http.createServer((req, res) => {
    if (req.headers.authorization) captured++;
    res.writeHead(204);
    res.end();
  });
  const redirector = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/v1/health` });
    res.end();
  });
  t.after(async () => {
    await cleanup([
      async () => closeServer(redirector),
      async () => closeServer(destination),
      async () => { assertPrivateRoot(root); await rm(root, { recursive: true, force: true }); },
    ]);
  });
  await new Promise((resolve, reject) => { destination.once("error", reject); destination.listen(0, "127.0.0.1", resolve); });
  await new Promise((resolve, reject) => { redirector.once("error", reject); redirector.listen(0, "127.0.0.1", resolve); });
  const token = randomBytes(32).toString("base64url");
  const tokenFile = path.join(root, "synthetic.token");
  await privateWrite(tokenFile, `${token}\n`);
  await assert.rejects(connect({ url: `http://127.0.0.1:${redirector.address().port}`, tokenFile, mode: "local" }));
  assert.equal(captured, 0);
});
