import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../src/index.mjs";
import { openForBroker, claimDeliveryOwner, deliveryStatus } from "../src/relay.mjs";
import { createDeliverySupervisor } from "../src/delivery.mjs";
import { createOpenCodePlugin } from "../src/adapters/opencode-plugin-core.mjs";

function events() {
  const queue = [], readers = [];
  const end = Symbol("end");
  return {
    emit(value) { const reader = readers.shift(); if (reader) reader(value); else queue.push(value); },
    async *subscribe({ signal }) {
      const abort = () => { while (readers.length) readers.shift()(end); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (!signal.aborted) {
          const value = queue.length ? queue.shift() : await new Promise((resolve) => readers.push(resolve));
          if (value === end) return;
          yield value;
        }
      } finally { signal.removeEventListener("abort", abort); }
    },
  };
}

const soak = process.env.RELAY_IDLE_SOAK === "1";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Idle-consumer integration deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("idle plugin connects durable admission, scoped tools, reply and explicit completion", { timeout: soak ? 200000 : 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-idle-integration-"));
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  let relay, supervisor, disposePlugin;
  const nativeSession = "ses_idle_integration";
  const hooks = new Map(), tools = new Map([["existing_tool", { id: "existing_tool" }]]);
  const stream = events(), prompts = [], idleWaiters = [];
  let idle = true;
  try {
    const root = join(home, "store");
    setup({ root, device: "idle-integration" });
    relay = openForBroker({ root, role: "host", ownerToken: "I".repeat(32) });
    const sender = relay.register("sender"), worker = relay.register("opencode");
    const senderSession = relay.join(sender.id), recipientSession = relay.join(worker.id);
    let first = soak ? null : relay.send(senderSession.id, worker.id, { msg: "private incoming question" });
    supervisor = createDeliverySupervisor({ local: relay, hub: null, pool: null,
      launchConfigured: false, ownerGeneration: claimDeliveryOwner(relay).generation,
      clients: ["opencode"], pollMs: 250 });
    await supervisor.start();
    disposePlugin = await createOpenCodePlugin().setup({
      app: { version: "2.0.27" },
      options: { relayRoot: root, profile: "integration", nativeSession, consume: true,
        bindings: [{ authority: relay.authority, worker: worker.id, sid: recipientSession.id, epoch: recipientSession.epoch }] },
      session: {
        get: async ({ sessionID }) => ({ id: sessionID }),
        wait: async () => { if (!idle) await new Promise((resolve) => idleWaiters.push(resolve)); },
        prompt: async (input) => { prompts.push(input); idle = false; return { id: input.id }; },
        hook: async (name, callback) => { hooks.set(name, callback); return () => hooks.delete(name); },
      },
      event: { subscribe: stream.subscribe },
      tool: {
        transform: async (transform) => {
          const added = [];
          transform({ list: () => [...tools.values()], add: (tool) => {
            tools.set(tool.name, { ...tool, id: tool.name }); added.push(tool.name);
          } });
          return { dispose: () => { for (const name of added) tools.delete(name); } };
        },
        list: async () => [...tools.values()],
      },
    });
    assert.equal(typeof disposePlugin, "function");
    assert.ok(tools.has("existing_tool"));
    const invoke = async (name, input) => {
      const result = await tools.get(name).execute(input, { sessionID: nativeSession,
        signal: new AbortController().signal, id: "fixture-call", messageID: "fixture-message", agent: "build" });
      return JSON.parse(result.content);
    };
    const beginTurn = () => {
      const notice = prompts.at(-1);
      hooks.get("context")({ sessionID: nativeSession, messages: [{ id: notice.id }] });
      hooks.get("model.request")({ sessionID: nativeSession, kind: "primary" });
    };
    const endTurn = async () => {
      idle = true;
      while (idleWaiters.length) idleWaiters.shift()();
      stream.emit({ type: "session.execution.succeeded", data: { sessionID: nativeSession } });
      await until(() => deliveryStatus(relay).targets.locked === 0);
    };
    if (soak) {
      console.log("Soak: checking 125 seconds of real idle session renewal without inference");
      await delay(125000);
      assert.equal(prompts.length, 0);
      assert.equal(relay.pending(recipientSession.id).worker, worker.id);
      relay.resume(senderSession.id);
      first = relay.send(senderSession.id, worker.id, { msg: "private incoming question" });
    }
    await supervisor.refresh();
    await until(() => prompts.length === 1);
    assert.equal(prompts[0].text.includes("private incoming question"), false);
    beginTurn();
    await assert.rejects(tools.get("relay_claim").execute({ kind: "msg" }, {
      sessionID: "ses_foreign", signal: new AbortController().signal,
    }));
    const message = await invoke("relay_claim", { kind: "msg" });
    assert.equal(message.message.msg, "private incoming question");
    await invoke("relay_reply", { lease: message.lease, msg: "scoped answer" });
    await invoke("relay_ack", { lease: message.lease, outcome: "done" });
    assert.equal(relay.get(first.id).state, "done");
    const replies = relay.list({ to: sender.id, data: true });
    assert.equal(replies.items.length, 1);
    assert.equal(replies.items[0].data.msg, "scoped answer");
    await endTurn();
    const work = relay.send(senderSession.id, worker.id, { work: { task: "x".repeat(60000), nested: [1, true, null] } });
    await supervisor.refresh();
    await until(() => prompts.length === 2);
    beginTurn();
    const claimedWork = await invoke("relay_claim", { kind: "work" });
    assert.equal(claimedWork.message.work.task.length, 60000);
    assert.deepEqual(claimedWork.message.work.nested, [1, true, null]);
    if (soak) {
      console.log("Soak: checking 35 seconds of real active-claim renewal without model calls");
      await delay(35000);
      assert.equal(relay.get(work.id).state, "claimed");
    }
    await endTurn();
    assert.equal(relay.get(work.id).state, "claimed", "native turn completion must not acknowledge work");
    await invoke("relay_ack", { lease: claimedWork.lease, outcome: "done" });
    assert.equal(relay.get(work.id).state, "done");
    await supervisor.refresh();
    assert.equal(prompts.length, 2);
  } finally {
    await disposePlugin?.();
    await supervisor?.close();
    relay?.close();
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  }
});
