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
        setViewerGrant: (grant) => privateFile(credentialsFile, JSON.stringify({ version: 1, credentials: [
          { ...viewer.entry, grant: { ...viewer.entry.grant, ...grant } }, writer.entry,
        ] })),
      });
    } finally {
      await client?.close();
      await broker.close();
    }
  });
}

test("quiet event streams send their HTTP handshake before the first event", async () => {
  await withSnapshotBroker(async ({ origin, token }) => {
    const headers = { Authorization: `Bearer ${token}` };
    const snapshot = await (await fetch(`${origin}/v1/topology?limit=512`, { headers })).json();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let response;
    try {
      response = await fetch(`${origin}/v1/events?cursor=${encodeURIComponent(snapshot.cursor)}`, { headers, signal: controller.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel();
      controller.abort();
    }
  });
});

test("event stream cursor refusals keep their JSON fault response", async () => {
  await withSnapshotBroker(async ({ origin, token }) => {
    const headers = { Authorization: `Bearer ${token}` };
    const snapshot = await (await fetch(`${origin}/v1/topology?limit=512`, { headers })).json();
    const cursor = JSON.parse(Buffer.from(snapshot.cursor, "base64url").toString());
    cursor.seq = Number.MAX_SAFE_INTEGER;
    const invalid = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    const response = await fetch(`${origin}/v1/events?cursor=${invalid}`, { headers, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 503);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.equal((await response.json()).fault.code, "cursor");
  });
});

test("unchanged pane refreshes retain their record and payload nodes", async () => {
  const ui = await uiRuntime(() => { throw new Error("Rendering must not request data"); });
  try {
    ui.run(`state.selectedBoard='bounty';state.connection='connected';state.inbox.page={items:[{id:'m1',state:'posted',seq:1,init:1,data:{msg:'Keep selection'}}],visible:1,total:1,complete:true,pruned:0};renderPane('inbox')`);
    const row = ui.element("inbox-rows").firstChild;
    const payload = row.children[2];
    ui.run("state.inbox.loading=true;renderPane('inbox');state.inbox.loading=false;renderPane('inbox')");
    assert.equal(ui.element("inbox-rows").firstChild, row);
    assert.equal(row.children[2], payload);
    ui.run("state.inbox.page.items[0].data.msg='Changed';renderPane('inbox')");
    assert.equal(ui.element("inbox-rows").firstChild, row);
    assert.equal(row.children[2].textContent, "Changed");
    ui.run("state.inbox.page=null;renderPane('inbox')");
    assert.equal(ui.element("inbox-rows").children.length, 0);
  } finally { await ui.close(); }
});

test("superseded pane cancellation cannot clear a newer request's loading state", async () => {
  const ui = await uiRuntime((_path, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  }));
  let newer;
  try {
    ui.run("state.token = 'a'.repeat(43); state.selectedBoard = 'bounty'; state.snapshot = { boards: [{ id: 'bounty', reported: false, authority: 'probe' }] }");
    const older = ui.run("loadPane('inbox', null)");
    newer = ui.run("loadPane('inbox', null)");
    await older;
    assert.equal(ui.run("state.inbox.loading"), true);
    assert.equal(ui.element("inbox-status").textContent, "Loading");
  } finally { await ui.close(); await newer; }
});

test("superseded pane refusal cannot deny a newer request", async () => {
  let release, newer, requests = 0;
  const held = new Promise(resolve => { release = resolve; });
  const ui = await uiRuntime(async (_path, { signal }) => {
    if (++requests === 1) {
      await held;
      return Response.json({ v: 1, fault: { code: "denied" } }, { status: 403 });
    }
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    });
  });
  try {
    ui.run("state.token = 'a'.repeat(43); state.selectedBoard = 'bounty'; state.snapshot = { boards: [{ id: 'bounty', reported: false, authority: 'probe' }] }");
    const older = ui.run("loadPane('inbox', null)");
    newer = ui.run("loadPane('inbox', null)");
    release();
    await older;
    assert.equal(ui.run("state.inbox.error"), null);
    assert.equal(ui.run("state.inbox.loading"), true);
    assert.equal(ui.element("inbox-status").textContent, "Loading");
  } finally { release(); await ui.close(); await newer; }
});

test("completed pane requests release their controller references", async () => {
  const ui = await uiRuntime(async () => Response.json({ v: 1 }));
  try {
    ui.run("state.token = 'a'.repeat(43)");
    await ui.run("requestJson('/v1/board', { pane: 'inbox' })");
    assert.equal(ui.run("requestControllers.size"), 0);
    assert.equal(ui.run("paneControllers.size"), 0);
  } finally { await ui.close(); }
});

test("unchanged connection status preserves already rendered board rows", async () => {
  const ui = await uiRuntime(() => { throw new Error("No request expected"); });
  try {
    ui.run("state.selectedBoard = 'bounty'; state.inbox.page = { items: [{ id: 'message', state: 'posted', seq: 1, init: 0, data: { msg: 'retained text' } }], visible: 1, total: 1, complete: true, pruned: 0 }; setConnection('connected', 'Connected')");
    const row = ui.element("inbox-rows").children[0];
    assert.ok(row);
    ui.run("setConnection('connected', 'Connected')");
    assert.equal(ui.element("inbox-rows").children[0], row);
    ui.run("setConnection('disconnected', 'Reconnecting')");
    assert.equal(ui.element("inbox-status").textContent, "Reconnecting · cached");
    ui.run("selectBoard(state, null); setConnection('disconnected', 'Reconnecting')");
    assert.equal(ui.element("inbox-rows").children.length, 0);
  } finally { await ui.close(); }
});

test("hiding the page cancels pending body reads and clears their loading state", async () => {
  let signal, pending;
  const ui = await uiRuntime((_path, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  });
  try {
    ui.run("state.token = 'a'.repeat(43); state.selectedBoard = 'bounty'; state.snapshot = { authority: 'probe', time: 0, boards: [{ id: 'bounty', reported: false, authority: 'probe' }], devices: [], agents: [], links: [], totals: { devices: 0, agents: 0, boards: 1, links: 0 }, visible: { devices: 0, agents: 0, boards: 1, links: 0 } }");
    pending = ui.run("loadPane('inbox', null)");
    ui.document.hidden = true;
    ui.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(signal.aborted, true);
    await pending;
    assert.equal(ui.run("state.inbox.loading"), false);
    assert.equal(ui.element("connection").textContent, "Paused");
    assert.equal(ui.run("paneControllers.size"), 0);
  } finally { await ui.close(); await pending; }
});

test("a refused feed cancels its unread response body before clearing credentials", async () => {
  let cancelled = false, task;
  const ui = await uiRuntime(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 }));
  try {
    task = ui.run("state.token = 'a'.repeat(43); state.snapshot = { cursor: 'probe', boards: [], agents: [], devices: [], links: [] }; connectStream(); streamTask");
    await task;
    assert.equal(cancelled, true);
    assert.equal(ui.element("connection").textContent, "Authentication required");
    assert.equal(ui.run("state.token"), null);
  } finally { await ui.close(); await task; }
});

test("a stopped feed cannot restore Connected from a late response", async () => {
  let release, task, cancelled = false;
  const held = new Promise((resolve) => { release = resolve; });
  const ui = await uiRuntime(() => held);
  try {
    ui.run("state.token = 'a'.repeat(43); state.snapshot = { cursor: 'probe', boards: [], agents: [], devices: [], links: [] }; connectStream()");
    task = ui.run("streamTask");
    ui.run("clearPrivateState(); setConnection('disconnected', 'Disconnected')");
    release(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }));
    await task;
    assert.equal(ui.element("connection").textContent, "Disconnected");
    assert.equal(ui.run("state.snapshot"), null);
    assert.equal(cancelled, true);
  } finally { release(new Response(null)); await ui.close(); await task; }
});

test("Disconnect cancels feed backoff without waiting for the retry timer", async () => {
  let closed, settled = false;
  const ui = await uiRuntime(async () => new Response(null, { status: 503 }));
  try {
    await ui.run("state.token = 'a'.repeat(43); state.snapshot = { cursor: 'probe', boards: [], agents: [], devices: [], links: [] }; connectStream()");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.element("connection").textContent, "Reconnecting");
    closed = ui.close().then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true);
  } finally { await (closed ?? ui.close()); }
});

test("a stalled feed handshake times out without skipping reconnect backoff", async () => {
  let feeds = 0;
  const ui = await uiRuntime((_path, { signal }) => {
    feeds += 1;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  });
  try {
    ui.run("const nativeTimeout = setTimeout; setTimeout = (callback, ms) => nativeTimeout(callback, ms === REQUEST_DEADLINE_MS ? 0 : ms)");
    await ui.run("state.token = 'a'.repeat(43); state.snapshot = { cursor: 'probe', boards: [], agents: [], devices: [], links: [] }; connectStream()");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(ui.element("connection").textContent, "Timed out · reconnecting");
    assert.equal(feeds, 1);
    assert.equal(ui.run("streamController.signal.aborted"), false);
  } finally { await ui.close(); }
});

test("a failed manual refresh does not open a feed from cached topology", async () => {
  const requests = [];
  const ui = await uiRuntime(async (path) => {
    requests.push(new URL(path, "http://127.0.0.1").pathname);
    return Response.json({ v: 1, fault: { code: "unavailable" } }, { status: 503 });
  });
  try {
    ui.run("state.token = 'a'.repeat(43); state.snapshot = { cursor: 'probe', boards: [], agents: [], devices: [], links: [] }");
    ui.element("refresh").dispatchEvent(new Event("click"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, ["/v1/topology"]);
    assert.equal(ui.element("connection").textContent, "Unavailable");
    assert.notEqual(ui.run("state.snapshot"), null);
    assert.equal(ui.run("streamTask"), null);
  } finally { await ui.close(); }
});

test("feed reconnect waits for a successful topology refresh instead of reusing cached authority", async () => {
  let checked, feeds = 0;
  const topologyRead = new Promise((resolve) => { checked = resolve; });
  const ui = await uiRuntime(async (path) => {
    if (new URL(path, "http://127.0.0.1").pathname === "/v1/topology") {
      checked();
      return new Response(null, { status: 503 });
    }
    feeds += 1;
    return new Response(new ReadableStream({ start(stream) { stream.close(); } }), { headers: { "content-type": "text/event-stream" } });
  });
  try {
    await ui.run("state.token = 'a'.repeat(43); state.snapshot = { cursor: 'probe', boards: [], agents: [], devices: [], links: [] }; connectStream()");
    await topologyRead;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(feeds, 1);
    assert.equal(ui.element("connection").textContent, "Unavailable");
  } finally { await ui.close(); }
});

test("a replacement snapshot authority retires a feed that has not closed yet", async () => {
  await withSnapshotBroker(async ({ origin, token }) => {
    const feeds = [];
    let old;
    const ui = await uiRuntime(async (path, options) => {
      if (new URL(path, origin).pathname === "/v1/events") {
        feeds.push(options.signal);
        return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
      }
      return fetch(new URL(path, origin), options);
    });
    try {
      ui.element("token").value = token;
      ui.run(`state.token = ${JSON.stringify(token)}; state.snapshot = { authority: 'previous', cursor: 'probe', boards: [], agents: [], devices: [], links: [] }; connectStream()`);
      old = ui.run("streamTask");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(feeds.length, 1);
      assert.equal(await ui.run("refreshSnapshot()"), true);
      assert.equal(feeds[0].aborted, true);
      assert.equal(feeds.length, 2);
      assert.equal(feeds[1].aborted, false);
      await old;
    } finally { await ui.close(); await old; }
  });
});

test("a changed credential scope retires the old feed and clears previously permitted bodies", async () => {
  await withSnapshotBroker(async ({ origin, token, client, session, setViewerGrant }) => {
    const feeds = [];
    const ui = await uiRuntime(async (path, options) => {
      if (new URL(path, origin).pathname === "/v1/events") {
        feeds.push(options.signal);
        return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
      }
      return fetch(new URL(path, origin), options);
    });
    try {
      await client.post(session.id, "bounty", { msg: "previously permitted body" });
      ui.element("token").value = token;
      await ui.run("connect()");
      await ui.run("loadPane('inbox', null)");
      assert.equal(ui.run("state.inbox.page.items.length"), 1);
      assert.equal(feeds.length, 1);
      await setViewerGrant({ inboxRead: [], workRead: [] });
      assert.equal(await ui.run("refreshSnapshot()"), true);
      assert.equal(feeds[0].aborted, true);
      assert.equal(feeds.length, 2);
      assert.equal(ui.run("state.inbox.page"), null);
      assert.equal(ui.run("state.bounties.page"), null);
      assert.equal(ui.run("state.token"), token);
    } finally { await ui.close(); }
  });
});

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

test("successful snapshot recovery starts the native feed without another Connect", async () => {
  await withSnapshotBroker(async ({ origin, token }) => {
    let unavailable = true, feeds = 0;
    const ui = await uiRuntime(async (path, options) => {
      const url = new URL(path, origin);
      if (url.pathname === "/v1/topology" && unavailable) return new Response(null, { status: 503 });
      if (url.pathname === "/v1/events") feeds += 1;
      return fetch(url, options);
    });
    try {
      ui.element("token").value = token;
      await ui.run("connect()");
      assert.equal(ui.run("streamTask"), null);
      unavailable = false;
      assert.equal(await ui.run("refreshSnapshot()"), true);
      assert.equal(ui.element("connection").textContent, "Connected");
      assert.equal(feeds, 1);
      assert.notEqual(ui.run("streamTask"), null);
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
