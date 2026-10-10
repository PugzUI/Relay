import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, connect } from "../src/client.mjs";
import { serve } from "../src/broker.mjs";
import { Fault } from "../src/fault.mjs";
import { readConfig, parseJsonStrict } from "../src/config.mjs";
import { setup } from "../src/relay.mjs";
import { credential, emptyGrant, privateFile, withTempDir } from "./network-helpers.mjs";

test("Client public calls are authenticated and reject lossy envelopes before sending", async () => {
  assert.throws(() => new Client(), /Use connect\(\)/);
  await withTempDir(async (root) => {
    const auth = credential();
    const tokenFile = await privateFile(join(root, "token"), auth.token);
    const requests = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      requests.push({ method: req.method, authorization: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/health") {
        res.end(JSON.stringify({ v: 1, authority: "fixture-authority", time: 1 }));
      } else {
        const result = body.op === "stats"
          ? { authority: "fixture-authority", time: 2, messages: { pending: 0, claimed: 0, posted: 0, done: 0, failed: 0, rejected: 0, rows: 0, bytes: 0 }, sessions: { live: 0, ended: 0 }, leases: { live: 0, total: 0 }, receipts: 0, devices: 0, agents: 0, boards: 0, audit: { rows: 0, pruned: 0 } }
          : { id: "message-1", repeat: false, init: 3 };
        res.end(JSON.stringify({ v: 1, rid: body.rid, ok: true, result, time: 3, replayed: false, remainingMs: null }));
      }
    });
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const client = await connect({ url: `http://127.0.0.1:${server.address().port}`, tokenFile, mode: "local" });
    try {
      assert.equal(client.authority, "fixture-authority");
      assert.equal((await client.stats()).authority, "fixture-authority");
      const sent = await client.send("east:worker:001", "west:worker:001", { work: { items: [1, null, "ok"] } });
      assert.equal(sent.id, "message-1");
      assert.deepEqual(requests.map(({ method, authorization }) => [method, authorization]), [
        ["GET", `Bearer ${auth.token}`],
        ["POST", `Bearer ${auth.token}`],
        ["POST", `Bearer ${auth.token}`],
      ]);
      assert.deepEqual(requests[2].body.args.envelope, { work: { items: [1, null, "ok"] } });

      const sparse = []; sparse.length = 1;
      const invalid = [
        { work: sparse },
        { work: { value: Number.NaN } },
        { work: { value: new Date(0) } },
        { work: { value: undefined } },
        new Proxy({ work: {} }, { ownKeys() { throw new Error("unsupported proxy"); } }),
      ];
      const sentCount = requests.length;
      for (const envelope of invalid) {
        await assert.rejects(client.send("east:worker:001", "west:worker:001", envelope), (error) => error instanceof Fault && error.code === "data");
      }
      assert.equal(requests.length, sentCount);
      await client.close();
      assert.equal(client.authority, "fixture-authority");
      await assert.rejects(client.stats(), (error) => error instanceof Fault && error.code === "unavailable");
    } finally {
      await client.close();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test("strict config parser rejects duplicate fields and trailing JSON", () => {
  assert.throws(() => parseJsonStrict('{"mode":"local","mode":"lan"}'), (error) => error.code === "input");
  assert.throws(() => parseJsonStrict('{"mode":"local"} false'), (error) => error.code === "input");
  assert.throws(() => parseJsonStrict('{"__proto__":{},"__proto__":{}}'), (error) => error.code === "input");
});

test("config accepts an explicit local profile and rejects ambiguous bindings", async () => {
  await withTempDir(async (root) => {
    const credentialsFile = join(root, "credentials.json");
    const configFile = join(root, "relay.json");
    await privateFile(credentialsFile, JSON.stringify({ version: 1, credentials: [] }));
    const base = { version: 1, role: "host", mode: "local", listen: { host: "127.0.0.1", port: 4200 }, tls: null, allowedPeers: [], credentialsFile: "./credentials.json", hub: null, pool: null, views: [] };
    await privateFile(configFile, JSON.stringify(base));
    const config = await readConfig(configFile);
    assert.equal(config.listen.host, "127.0.0.1");
    assert.equal(config.credentialsFile, credentialsFile);
    base.listen.host = "0.0.0.0";
    await privateFile(configFile, JSON.stringify(base));
    await assert.rejects(readConfig(configFile), (error) => error instanceof Fault && error.code === "input");
    base.listen.host = "127.0.0.1"; base.views = [{ deviceId: "d", url: "https://host.example", tokenFile: "./token", boards: ["host:d"] }, { deviceId: "d", url: "https://other.example", tokenFile: "./token2", boards: ["host:d"] }];
    await privateFile(configFile, JSON.stringify(base));
    await assert.rejects(readConfig(configFile), (error) => error instanceof Fault && error.code === "input");
  });
});

test("HTTP clients require an explicit literal loopback mode", async () => {
  await assert.rejects(connect({ url: "http://relay.example", tokenFile: "/missing" }), (error) => error instanceof Fault && error.code === "tls");
  await assert.rejects(connect({ url: "http://user@127.0.0.1", tokenFile: "/missing", mode: "local" }), (error) => error instanceof Fault && error.code === "input");
  await assert.rejects(connect({ url: "http://127.0.0.1", tokenFile: "/missing", mode: "local" }), (error) => error instanceof Fault && error.code === "unavailable");
});

test("broker serves the page module at its exact UI path and protects its API", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "page" });
    const auth = credential({ grant: emptyGrant() });
    await privateFile(join(root, "credentials.json"), JSON.stringify({ version: 1, credentials: [auth.entry] }));
    const probe = createNetServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const configFile = join(root, "relay.json");
    await privateFile(configFile, JSON.stringify({ version: 1, role: "host", mode: "local", listen: { host: "127.0.0.1", port }, tls: null, allowedPeers: [], credentialsFile: "./credentials.json", hub: null, pool: null, views: [] }));
    const broker = await serve({ root, configFile });
    try {
      const origin = `http://127.0.0.1:${port}`;
      const page = await fetch(origin);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /src="\/main\.mjs"/);
      const module = await fetch(`${origin}/main.mjs`);
      assert.equal(module.status, 200);
      assert.equal(module.headers.get("content-type"), "text/javascript; charset=utf-8");
      assert.equal(await module.text(), await readFile(new URL("../ui/main.mjs", import.meta.url), "utf8"));
      assert.equal((await fetch(`${origin}/app.mjs`)).status, 404);
      assert.equal((await fetch(`${origin}/v1/health`)).status, 401);
      const health = await fetch(`${origin}/v1/health`, { headers: { Authorization: `Bearer ${auth.token}` } });
      assert.equal(health.status, 200);
    } finally { await broker.close(); }
  });
});
