import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, open } from "../src/index.mjs";
import { claimDeliveryOwner, openForBroker } from "../src/relay.mjs";
import { createDeliverySupervisor } from "../src/delivery.mjs";

async function withRecipient(run) {
  const root = await mkdtemp(join(tmpdir(), "relay-review-recipient-"));
  let local, hub, supervisor;
  try {
    setup({ root: join(root, "local"), device: "local" });
    local = openForBroker({ root: join(root, "local"), role: "host", ownerToken: "R".repeat(32) });
    hub = open({ root: join(root, "hub"), device: "hub", role: "hub" });
    const sender = hub.register("sender"), worker = hub.register("worker");
    const senderSession = hub.join(sender.id), session = hub.join(worker.id);
    const message = hub.send(senderSession.id, worker.id, { msg: "addressed question" });
    let reads = 0;
    const pending = hub.pending.bind(hub);
    hub.pending = (sid) => { reads++; return pending(sid); };
    supervisor = createDeliverySupervisor({ local, hub, pool: null, launchConfigured: false,
      ownerGeneration: claimDeliveryOwner(local).generation, clients: ["hermes"], pollMs: 30000 });
    await supervisor.start();
    const handle = await supervisor.bind({
      authority: hub.authority, worker: worker.id, sid: session.id, epoch: session.epoch,
      client: "hermes", capabilities: { context: true, idle: true, launch: false },
      target: { runtimeInstance: "review", profile: "review", nativeSession: "review", lifecycleGeneration: "1" },
      consumer: { status: async () => ({ state: "busy" }),
        submit: async () => { throw new Error("No native submission is expected"); },
        observe: async () => ({ state: "unknown" }) },
    });
    await supervisor.refresh();
    assert.equal(reads, 1, "the background poll uses one scheduled hub read");
    await run({ handle, hub, session, message, reads: () => reads });
  } finally {
    await supervisor?.close();
    local?.close(); hub?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("scheduled hub polling does not block an explicit recipient pending read", async () => {
  await withRecipient(async ({ handle, reads }) => {
    const summary = await handle.recipient("pending", {});
    assert.equal(summary.pending.msg, 1);
    assert.equal(reads(), 2, "explicit reads use fresh authority state rather than cached hints");
  });
});

test("a hub recipient can claim and settle immediately after a scheduled hint", async () => {
  await withRecipient(async ({ handle, hub, session, message }) => {
    const lease = await handle.recipient("claim", { kind: "msg" });
    assert.equal(lease.mid, message.id);
    assert.equal(lease.sid, session.id);
    const receipt = await handle.recipient("ack", { lease: lease.id, outcome: "done" });
    assert.equal(receipt.mid, message.id);
    assert.equal(hub.get(message.id).state, "done");
  });
});
