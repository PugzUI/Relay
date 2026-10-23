import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { MultiHostClient } from "@microsoft/agent-host-protocol/hosts";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { isolatedFleet } from "./fixtures/isolated-hosts.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForConnected(multi, id) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const host = multi.host(id);
    if (host?.state.status === "connected" &&
        host.agents.some((agent) => agent.provider === "relayFixture")) return;
    if (host?.state.status === "failed") throw Error(`${id}: ${host.lastError?.message}`);
    await sleep(100);
  }
  throw Error(`${id}: AHP connection or ACP advertisement timed out`);
}

test("two real ahpd hosts keep equal session URIs and turns isolated", { timeout: 90000 }, async (t) => {
  const { hosts } = await isolatedFleet(t, { hostCount: 2 });
  const multi = new MultiHostClient();
  const channel = `relayFixture:/${crypto.randomUUID()}`;
  const created = [];

  try {
    for (const [index, host] of hosts.entries()) {
      const id = `host-${index + 1}`;
      await multi.addHost({
        id,
        label: id,
        transportFactory: () => WebSocketTransport.connect(
          `${host.origin}/?tkn=${encodeURIComponent(host.token)}`),
      });
      await waitForConnected(multi, id);
      await multi.client(id).request("createSession", {
        channel,
        provider: "relayFixture",
        workingDirectories: [pathToFileURL(host.workspace).href],
      });
      created.push(id);
    }

    const chats = [];
    for (const id of created) {
      const session = await multi.subscribe(id, channel);
      const chat = session.snapshot?.state?.defaultChat;
      assert.ok(chat?.startsWith("ahp-chat:"), `${id} supplied a default chat`);
      assert.equal(session.snapshot.state.provider, "relayFixture");
      chats.push(chat);
      await multi.subscribe(id, chat);
      const catalog = await multi.client(id).request("listSessions", { channel: "ahp-root://" });
      assert.ok(catalog.items.some((item) => item.resource === channel),
        `${id} must advertise its own canonical ACP session`);
    }

    const events = multi.events();
    const observed = [];
    const completion = (async () => {
      for await (const event of events) {
        if (event.event.type !== "action" ||
            event.channel !== chats[0] || event.hostId !== created[0]) continue;
        const kind = event.event.params.action.type;
        observed.push(kind);
        if (["chat/turnComplete", "chat/turnCancelled", "chat/error"].includes(kind)) {
          return kind;
        }
      }
      return "stream-closed";
    })();

    multi.dispatch(created[0], chats[0], {
      type: "chat/pendingMessageSet",
      kind: "queued",
      id: crypto.randomUUID(),
      message: { text: "Finish the first host's turn.", origin: { kind: "user" } },
    });
    let timer;
    const outcome = await Promise.race([
      completion,
      new Promise((resolve) => { timer = setTimeout(() => resolve("timed-out"), 20000); }),
    ]).finally(() => clearTimeout(timer));
    await events.return();
    assert.equal(outcome, "chat/turnComplete", `First host: ${observed.join(", ")}`);
    assert.ok(observed.includes("chat/turnStarted"));

    // A matching URI on another host is still a different authoritative chat.
    await multi.unsubscribe(created[1], chats[1]);
    const other = await multi.subscribe(created[1], chats[1]);
    assert.equal(other.snapshot?.state?.turns?.length, 0);
    assert.equal(other.snapshot?.state?.activeTurn, undefined);
  } finally {
    for (const id of created) {
      try {
        await multi.client(id).request("disposeSession", { channel });
      } catch {
        // Cleanup continues if a fixture's connection has already closed.
      }
    }
    await multi.shutdown();
  }
});
