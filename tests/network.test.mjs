import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "../src/client.mjs";
import { serve } from "../src/broker.mjs";
import { Fault } from "../src/fault.mjs";
import { readConfig, parseJsonStrict } from "../src/config.mjs";
import { setup } from "../src/relay.mjs";
import { credential, emptyGrant, privateFile, withTempDir } from "./network-helpers.mjs";

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
    const probe = createServer();
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
