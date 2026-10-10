import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { open, setup } from "../src/relay.mjs";
import { serve } from "../src/broker.mjs";
import { connect } from "../src/client.mjs";
import { credential, emptyGrant, privateFile, withTempDir } from "./network-helpers.mjs";
import { uiRuntime } from "./fixtures/ui/runtime.mjs";

async function withSnapshotBroker(run) {
  return withTempDir(async (root) => {
    setup({ root, device: "snapshot-probe", role: "hub" });
    const relay = open({ root });
    let worker;
    try {
      for (let slot = 1; slot <= 513; slot++) {
        const registered = relay.register("worker", { slot: String(slot).padStart(3, "0") });
        if (slot === 1) worker = registered.id;
      }
    } finally { relay.close(); }
    const viewer = credential({ principal: "viewer", grant: {
      ...emptyGrant(), inboxRead: ["bounty"], workRead: ["bounty"],
      inspect: { messages: false, receipts: false, audit: false, topology: true },
    } });
    const writer = credential({ principal: "writer", grant: {
      ...emptyGrant(), workers: [worker], boardPost: ["bounty"],
    } });
    const credentialsFile = await privateFile(join(root, "credentials.json"), JSON.stringify({ version: 1, credentials: [viewer.entry, writer.entry] }));
    const tokenFile = await privateFile(join(root, "writer-token"), writer.token);
    const listener = createServer();
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    const configFile = await privateFile(join(root, "relay.json"), JSON.stringify({
      version: 1, role: "hub", mode: "local", listen: { host: "127.0.0.1", port },
      tls: null, allowedPeers: [], credentialsFile, hub: null, pool: null, views: [],
    }));
    const broker = await serve({ root, configFile });
    let client;
    try {
      const origin = `http://127.0.0.1:${port}`;
      client = await connect({ url: origin, tokenFile, mode: "local" });
      const session = await client.join(worker);
      await run({ origin, token: viewer.token, client, session,
        revokeViewer: () => privateFile(credentialsFile, JSON.stringify({ version: 1, credentials: [writer.entry] })),
      });
    } finally {
      await client?.close();
      await broker.close();
    }
  });
}

test("native topology continuations with no links satisfy the authenticated cursor contract", async () => {
  await withSnapshotBroker(async ({ origin, token }) => {
    const headers = { Authorization: `Bearer ${token}` };
    const first = await (await fetch(`${origin}/v1/topology?limit=512`, { headers })).json();
    assert.equal(first.complete, false);
    const response = await fetch(`${origin}/v1/topology?limit=512&after=${first.next}`, { headers });
    const second = await response.json();
    assert.equal(response.status, 200, second.fault?.message);
    assert.equal(second.agents.length, 1);
    assert.equal(second.complete, true);
  });
});

test("initial UI snapshot restarts after a native pagination reset and connects without user action", async () => {
  await withSnapshotBroker(async ({ origin, token, client, session }) => {
    const requests = [];
    let mutation = false;
    const ui = await uiRuntime(async (path, options) => {
      const url = new URL(path, origin);
      if (url.pathname === "/v1/topology" && url.searchParams.has("after") && !mutation) {
        mutation = true;
        await client.post(session.id, "bounty", { msg: "committed between snapshot pages" });
      }
      const response = await fetch(url, options);
      if (url.pathname === "/v1/topology") {
        const value = await response.clone().json();
        requests.push({ continuation: url.searchParams.has("after"), status: response.status, fault: value.fault?.code });
      }
      return response;
    });
    try {
      ui.element("token").value = token;
      await ui.run("connect()");
      assert.equal(mutation, true);
      assert.deepEqual(requests.slice(0, 2), [
        { continuation: false, status: 200, fault: undefined },
        { continuation: true, status: 503, fault: "reset" },
      ]);
      assert.equal(ui.element("connection").textContent, "Connected");
      assert.equal(ui.run("state.snapshot.agents.length"), 513);
      assert.equal(ui.run("state.snapshot.boards.find(board => board.id === 'bounty').inbox"), 1);
      assert.deepEqual(requests.map(request => request.continuation), [false, true, false, true]);
      assert.ok(ui.run("streamTask"));
    } finally { await ui.close(); }
  });
});

test("continuous native pagination resets stop after three snapshot attempts", async () => {
  await withSnapshotBroker(async ({ origin, token, client, session }) => {
    const requests = [];
    const ui = await uiRuntime(async (path, options) => {
      const url = new URL(path, origin);
      if (url.searchParams.has("after")) await client.post(session.id, "bounty", { msg: "snapshot changed again" });
      const response = await fetch(url, options);
      requests.push(url.searchParams.has("after"));
      return response;
    });
    try {
      ui.element("token").value = token;
      await ui.run("connect()");
      assert.deepEqual(requests, [false, true, false, true, false, true]);
      assert.equal(ui.element("connection").textContent, "Topology changed");
      assert.equal(ui.run("state.snapshot"), null);
      assert.equal(ui.run("streamTask"), null);
      assert.equal(ui.run("requestControllers.size"), 0);
    } finally { await ui.close(); }
  });
});

test("credential revocation during reset recovery stops retries and clears private state", async () => {
  await withSnapshotBroker(async ({ origin, token, client, session, revokeViewer }) => {
    const statuses = [];
    const ui = await uiRuntime(async (path, options) => {
      const url = new URL(path, origin);
      if (url.searchParams.has("after")) await client.post(session.id, "bounty", { msg: "reset before revocation" });
      const response = await fetch(url, options);
      statuses.push(response.status);
      if (response.status === 503) await revokeViewer();
      return response;
    });
    try {
      ui.element("token").value = token;
      await ui.run("connect()");
      assert.deepEqual(statuses, [200, 503, 401]);
      assert.equal(ui.element("connection").textContent, "Authentication required");
      assert.equal(ui.run("state.token"), null);
      assert.equal(ui.run("state.snapshot"), null);
      assert.equal(ui.run("state.selectedBoard"), null);
      assert.equal(ui.run("streamTask"), null);
    } finally { await ui.close(); }
  });
});

for (const [status, code, label] of [[503, "unavailable", "Unavailable"], [403, "denied", "Denied"]]) {
  test(`initial snapshot does not retry a ${code} response`, async () => {
    let requests = 0;
    const ui = await uiRuntime(async () => {
      requests++;
      return Response.json({ v: 1, fault: { code, message: label }, time: Date.now() }, { status });
    });
    try {
      ui.element("token").value = "a".repeat(43);
      await ui.run("connect()");
      assert.equal(requests, 1);
      assert.equal(ui.element("connection").textContent, label);
      assert.equal(ui.run("state.token"), status === 403 ? null : "a".repeat(43));
      assert.equal(ui.run("state.snapshot"), null);
      assert.equal(ui.run("streamTask"), null);
    } finally { await ui.close(); }
  });
}

test("hiding the page cancels snapshot recovery before another request", async () => {
  await withSnapshotBroker(async ({ origin, token, client, session }) => {
    let requests = 0;
    const ui = await uiRuntime(async (path, options) => {
      const url = new URL(path, origin);
      requests++;
      if (url.searchParams.has("after")) await client.post(session.id, "bounty", { msg: "reset before hiding" });
      const response = await fetch(url, options);
      if (response.status === 503) {
        ui.document.hidden = true;
        ui.document.dispatchEvent(new Event("visibilitychange"));
      }
      return response;
    });
    try {
      ui.element("token").value = token;
      await ui.run("connect()");
      assert.equal(requests, 2);
      assert.equal(ui.element("connection").textContent, "Paused");
      assert.equal(ui.run("state.snapshot"), null);
      assert.equal(ui.run("streamTask"), null);
      assert.equal(ui.run("requestControllers.size"), 0);
    } finally { await ui.close(); }
  });
});

for (const [status, code] of [[503, "unavailable"], [401, "auth"]]) {
  test(`an obsolete ${code} snapshot failure cannot overwrite a newer connected generation`, async () => {
    await withSnapshotBroker(async ({ origin, token }) => {
      let release;
      let requests = 0;
      const held = new Promise(resolve => { release = resolve; });
      const ui = await uiRuntime(async (path, options) => {
        if (++requests === 1) {
          await held;
          return Response.json({ v: 1, fault: { code, message: "late failure" }, time: Date.now() }, { status });
        }
        return fetch(new URL(path, origin), options);
      });
      try {
        ui.element("token").value = token;
        const old = ui.run("connect()");
        await ui.run("refreshSnapshot()");
        assert.equal(ui.element("connection").textContent, "Connected");
        release();
        await old;
        assert.equal(ui.element("connection").textContent, "Connected");
        assert.equal(ui.run("state.snapshot.agents.length"), 513);
      } finally { release(); await ui.close(); }
    });
  });
}
