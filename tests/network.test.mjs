import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, connect, createFixedClient, invokeClient } from "../src/client.mjs";
import { serve, healthyModePeer } from "../src/broker.mjs";
import { Fault } from "../src/fault.mjs";
import { readConfig, parseJsonStrict } from "../src/config.mjs";
import { setup } from "../src/relay.mjs";
import { credential, emptyGrant, privateFile, withTempDir } from "./network-helpers.mjs";
import { performance } from "node:perf_hooks";

const fixtureAuthority = "fixture-authority";

function statsResult() {
  return {
    authority: fixtureAuthority,
    time: 2,
    messages: {
      pending: 0,
      claimed: 0,
      posted: 0,
      done: 0,
      failed: 0,
      rejected: 0,
      rows: 0,
      bytes: 0,
    },
    sessions: { live: 0, ended: 0 },
    leases: { live: 0, total: 0 },
    receipts: 0,
    devices: 0,
    agents: 0,
    boards: 0,
    audit: { rows: 0, pruned: 0 },
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}

async function handleFixtureRequest(req, res, requests) {
  const body = await readJsonBody(req);
  requests.push({ method: req.method, authorization: req.headers.authorization, body });
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/v1/health") {
    res.end(JSON.stringify({ v: 1, authority: fixtureAuthority, time: 1 }));
    return;
  }
  const result = body.op === "stats" ? statsResult() : { id: "message-1", repeat: false, init: 3 };
  res.end(
    JSON.stringify({
      v: 1,
      rid: body.rid,
      ok: true,
      result,
      time: 3,
      replayed: false,
      remainingMs: null,
    }),
  );
}

test("Client cancels an individual owned RPC request", async (t) => {
  await withTempDir(async (root) => {
    const auth = credential();
    const tokenFile = await privateFile(join(root, "token"), auth.token);
    const client = await createFixedClient({ url: "http://127.0.0.1:1", tokenFile, mode: "local" });
    const request = new EventEmitter();
    let destroyed = 0;
    request.destroy = () => {
      destroyed++;
      return request;
    };
    request.end = () => {};
    t.mock.method(http, "request", () => request);
    const controller = new AbortController();
    try {
      const pending = invokeClient(client, {
        rid: "cancelled-request",
        op: "stats",
        args: {},
        deadline: performance.now() + 1000,
        signal: controller.signal,
      });
      controller.abort();
      await assert.rejects(
        pending,
        (error) => error instanceof Fault && error.code === "unavailable",
      );
      assert.equal(destroyed, 1);
    } finally {
      await client.close();
    }
  });
});

test("Client public calls are authenticated and reject lossy envelopes before sending", async () => {
  assert.throws(() => new Client(), /Use connect\(\)/);
  await withTempDir(async (root) => {
    const auth = credential();
    const tokenFile = await privateFile(join(root, "token"), auth.token);
    const requests = [];
    const server = createServer((req, res) => handleFixtureRequest(req, res, requests));
    await new Promise((resolve, reject) =>
      server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())),
    );
    const client = await connect({
      url: `http://127.0.0.1:${server.address().port}`,
      tokenFile,
      mode: "local",
    });
    try {
      assert.equal(client.authority, "fixture-authority");
      assert.equal((await client.stats()).authority, "fixture-authority");
      const sent = await client.send("east:worker:001", "west:worker:001", {
        work: { items: [1, null, "ok"] },
      });
      assert.equal(sent.id, "message-1");
      assert.deepEqual(
        requests.map(({ method, authorization }) => [method, authorization]),
        [
          ["GET", `Bearer ${auth.token}`],
          ["POST", `Bearer ${auth.token}`],
          ["POST", `Bearer ${auth.token}`],
        ],
      );
      assert.deepEqual(requests[2].body.args.envelope, { work: { items: [1, null, "ok"] } });

      const sparse = [];
      sparse.length = 1;
      const invalid = [
        { work: sparse },
        { work: { value: Number.NaN } },
        { work: { value: new Date(0) } },
        { work: { value: undefined } },
        new Proxy(
          { work: {} },
          {
            ownKeys() {
              throw new Error("unsupported proxy");
            },
          },
        ),
      ];
      const sentCount = requests.length;
      for (const envelope of invalid) {
        await assert.rejects(
          client.send("east:worker:001", "west:worker:001", envelope),
          (error) => error instanceof Fault && error.code === "data",
        );
      }
      assert.equal(requests.length, sentCount);
      await client.close();
      assert.equal(client.authority, "fixture-authority");
      await assert.rejects(
        client.stats(),
        (error) => error instanceof Fault && error.code === "unavailable",
      );
    } finally {
      await client.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

test("transport fixture preserves mutation uncertainty when a retry is refused", async () => {
  await withTempDir(async (root) => {
    const auth = credential();
    const tokenFile = await privateFile(join(root, "token"), auth.token);
    const calls = [];
    const server = createServer(async (req, res) => {
      if (req.url === "/v1/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ v: 1, authority: "fixture-authority", time: 1 }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push(body);
      if (calls.length === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          v: 1,
          rid: body.rid,
          ok: false,
          fault: { code: "rate", message: "Request rate limit exceeded" },
          time: 2,
        }),
      );
    });
    await new Promise((resolve, reject) =>
      server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())),
    );
    const client = await connect({
      url: `http://127.0.0.1:${server.address().port}`,
      tokenFile,
      mode: "local",
    });
    try {
      await assert.rejects(
        client.send("east:worker:001", "west:worker:001", { msg: "one mutation" }),
        (error) => {
          assert.ok(error instanceof Fault);
          assert.equal(error.code, "uncertain");
          assert.equal(error.context.id, calls[0]?.rid);
          return true;
        },
      );
      assert.equal(calls.length, 2);
      assert.equal(calls[1].rid, calls[0].rid);
      assert.deepEqual(calls[1], calls[0]);
    } finally {
      await client.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

test("strict config parser rejects duplicate fields and trailing JSON", () => {
  assert.throws(
    () => parseJsonStrict('{"mode":"local","mode":"lan"}'),
    (error) => error.code === "input",
  );
  assert.throws(
    () => parseJsonStrict('{"mode":"local"} false'),
    (error) => error.code === "input",
  );
  assert.throws(
    () => parseJsonStrict('{"__proto__":{},"__proto__":{}}'),
    (error) => error.code === "input",
  );
});

test("config accepts an explicit local profile and rejects ambiguous bindings", async () => {
  await withTempDir(async (root) => {
    const credentialsFile = join(root, "credentials.json");
    const configFile = join(root, "relay.json");
    await privateFile(credentialsFile, JSON.stringify({ version: 1, credentials: [] }));
    const base = {
      version: 1,
      role: "host",
      mode: "local",
      listen: { host: "127.0.0.1", port: 4200 },
      tls: null,
      allowedPeers: [],
      credentialsFile: "./credentials.json",
      hub: null,
      pool: null,
      views: [],
    };
    await privateFile(configFile, JSON.stringify(base));
    const config = await readConfig(configFile);
    assert.equal(config.listen.host, "127.0.0.1");
    assert.equal(config.credentialsFile, credentialsFile);
    base.listen.host = "0.0.0.0";
    await privateFile(configFile, JSON.stringify(base));
    await assert.rejects(
      readConfig(configFile),
      (error) => error instanceof Fault && error.code === "input",
    );
    base.listen.host = "127.0.0.1";
    base.views = [
      { deviceId: "d", url: "https://host.example", tokenFile: "./token", boards: ["host:d"] },
      { deviceId: "d", url: "https://other.example", tokenFile: "./token2", boards: ["host:d"] },
    ];
    await privateFile(configFile, JSON.stringify(base));
    await assert.rejects(
      readConfig(configFile),
      (error) => error instanceof Fault && error.code === "input",
    );
  });
});

test("direct tailnet listener binds wildcard but rejects LAN peers", async () => {
  await withTempDir(async (root) => {
    const credentialsFile = join(root, "credentials.json");
    const configFile = join(root, "relay.json");
    await privateFile(credentialsFile, JSON.stringify({ version: 1, credentials: [] }));
    const base = {
      version: 1,
      role: "host",
      mode: "tailnet",
      listen: { host: "0.0.0.0", port: 4200 },
      tls: null,
      allowedPeers: [],
      credentialsFile: "./credentials.json",
      hub: null,
      pool: null,
      views: [],
    };
    await privateFile(configFile, JSON.stringify(base));
    assert.equal((await readConfig(configFile)).listen.host, "0.0.0.0");
    await privateFile(
      configFile,
      JSON.stringify({ ...base, listen: { ...base.listen, host: "127.0.0.1" } }),
    );
    await assert.rejects(readConfig(configFile), { code: "input" });
    await privateFile(configFile, JSON.stringify({ ...base, role: "hub" }));
    await assert.rejects(readConfig(configFile), { code: "input" });
  });
  assert.equal(healthyModePeer("tailnet", [], "127.0.0.1", "127.0.0.1"), true);
  assert.equal(healthyModePeer("tailnet", [], "100.64.0.1", "100.127.255.254"), true);
  assert.equal(healthyModePeer("tailnet", [], "::ffff:100.67.69.100", "100.67.69.100"), true);
  for (const peer of [
    "192.168.1.2",
    "10.0.0.4",
    "172.16.1.4",
    "8.8.8.8",
    "100.63.255.255",
    "100.128.0.1",
    "::1",
    undefined,
  ]) {
    assert.equal(healthyModePeer("tailnet", [], peer, "100.67.69.100"), false, String(peer));
  }
  assert.equal(healthyModePeer("tailnet", [], "100.67.69.101", "192.168.1.5"), false);
  assert.equal(healthyModePeer("lan", ["192.168.1.2"], "192.168.1.2", "192.168.1.5"), true);
});

test("config v2 freezes delivery selection and leaves v1 delivery disabled", async () => {
  await withTempDir(async (root) => {
    const credentialsFile = join(root, "credentials.json");
    const configFile = join(root, "relay.json");
    await privateFile(credentialsFile, JSON.stringify({ version: 1, credentials: [] }));
    const base = {
      version: 1,
      role: "host",
      mode: "local",
      listen: { host: "127.0.0.1", port: 4200 },
      tls: null,
      allowedPeers: [],
      credentialsFile: "./credentials.json",
      hub: null,
      pool: null,
      views: [],
    };
    await privateFile(configFile, JSON.stringify(base));
    assert.deepEqual((await readConfig(configFile)).delivery, {
      enabled: false,
      clients: [],
      pollMs: 1000,
    });
    const v2 = { ...base, version: 2, delivery: { enabled: false, clients: [], pollMs: 1000 } };
    await privateFile(configFile, JSON.stringify(v2));
    assert.deepEqual((await readConfig(configFile)).delivery, v2.delivery);
    v2.delivery.clients = ["hermes"];
    await privateFile(configFile, JSON.stringify(v2));
    await assert.rejects(
      readConfig(configFile),
      (error) => error instanceof Fault && error.code === "input",
    );
    v2.delivery = { enabled: true, clients: ["hermes"], pollMs: 250 };
    await privateFile(configFile, JSON.stringify(v2));
    assert.equal((await readConfig(configFile)).delivery.enabled, true);
    v2.role = "hub";
    await privateFile(configFile, JSON.stringify(v2));
    await assert.rejects(
      readConfig(configFile),
      (error) => error instanceof Fault && error.code === "input",
    );
  });
});

test("HTTP clients require an explicit literal loopback mode", async () => {
  await assert.rejects(
    connect({ url: "http://relay.example", tokenFile: "/missing" }),
    (error) => error instanceof Fault && error.code === "tls",
  );
  await assert.rejects(
    connect({ url: "http://user@127.0.0.1", tokenFile: "/missing", mode: "local" }),
    (error) => error instanceof Fault && error.code === "input",
  );
  await assert.rejects(
    connect({ url: "http://127.0.0.1", tokenFile: "/missing", mode: "local" }),
    (error) => error instanceof Fault && error.code === "unavailable",
  );
});

test("broker serves the page module at its exact UI path and protects its API", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "page" });
    const auth = credential({ grant: emptyGrant() });
    await privateFile(
      join(root, "credentials.json"),
      JSON.stringify({ version: 1, credentials: [auth.entry] }),
    );
    const probe = createNetServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    const configFile = join(root, "relay.json");
    await privateFile(
      configFile,
      JSON.stringify({
        version: 1,
        role: "host",
        mode: "local",
        listen: { host: "127.0.0.1", port },
        tls: null,
        allowedPeers: [],
        credentialsFile: "./credentials.json",
        hub: null,
        pool: null,
        views: [],
      }),
    );
    const broker = await serve({ root, configFile });
    try {
      const origin = `http://127.0.0.1:${port}`;
      const page = await fetch(origin);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /src="\/main\.mjs"/);
      const module = await fetch(`${origin}/main.mjs`);
      assert.equal(module.status, 200);
      assert.equal(module.headers.get("content-type"), "text/javascript; charset=utf-8");
      assert.equal(
        await module.text(),
        await readFile(new URL("../ui/main.mjs", import.meta.url), "utf8"),
      );
      assert.equal((await fetch(`${origin}/app.mjs`)).status, 404);
      assert.equal((await fetch(`${origin}/v1/health`)).status, 401);
      const health = await fetch(`${origin}/v1/health`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      assert.equal(health.status, 200);
    } finally {
      await broker.close();
    }
  });
});
