import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Fault } from "../src/fault.mjs";
import { createRecipientHandle } from "../src/recipient.mjs";
import { setup } from "../src/index.mjs";
import { claimDeliveryOwner, openForBroker } from "../src/relay.mjs";
import { createDeliverySupervisor } from "../src/delivery.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

const binding = Object.freeze({
  authority: "authority-1",
  worker: "device:runtime:001",
  sid: "session-1",
  epoch: 7,
});
const sender = "device:runtime:002";

function fixture(overrides = {}) {
  let current = true;
  let next = 0;
  const calls = [];
  const api = {
    authority: binding.authority,
    pending: (sid) => {
      calls.push(["pending", sid]);
      return {
        v: 1,
        authority: binding.authority,
        worker: binding.worker,
        epoch: binding.epoch,
        revision: "a".repeat(64),
        pending: { msg: 1, work: 0 },
        recoverable: { msg: 0, work: 0 },
      };
    },
    renew: (sid) => {
      calls.push(["renew", sid]);
      return {
        id: sid,
        worker: binding.worker,
        epoch: binding.epoch,
        until: Date.now() + 60_000,
        ended: null,
      };
    },
    claim: (sid, options) => {
      calls.push(["claim", sid, options]);
      const index = ++next;
      return {
        id: `lease-${index}`,
        mid: `message-${index}`,
        sid,
        epoch: binding.epoch,
        until: Date.now() + 30_000,
        attempt: 1,
        kind: options.kind,
        ...(options.kind === "msg" ? { msg: "question" } : { work: { task: "run" } }),
      };
    },
    touch: (sid, leaseId) => {
      calls.push(["touch", sid, leaseId]);
      return {
        id: leaseId,
        mid: leaseId.replace("lease", "message"),
        sid,
        epoch: binding.epoch,
        until: Date.now() + 30_000,
        attempt: 1,
        kind: "msg",
        msg: "question",
      };
    },
    get: (id, options) => {
      calls.push(["get", id, options]);
      return {
        id,
        seq: 1,
        from: sender,
        to: binding.worker,
        board: null,
        kind: "msg",
        needs: [],
        series: null,
        state: "claimed",
        init: 10,
        acked: null,
      };
    },
    send: (sid, to, envelope, options) => {
      calls.push(["send", sid, to, envelope, options]);
      return { id: "reply-message", repeat: false, init: 20 };
    },
    ack: (sid, leaseId, outcome) => {
      calls.push(["ack", sid, leaseId, outcome]);
      return {
        mid: leaseId.replace("lease", "message"),
        lease: leaseId,
        sid,
        epoch: binding.epoch,
        outcome,
        time: 30,
      };
    },
    release: (sid, leaseId) => {
      calls.push(["release", sid, leaseId]);
      return {
        mid: leaseId.replace("lease", "message"),
        lease: leaseId,
        sid,
        epoch: binding.epoch,
        outcome: "released",
        time: 31,
      };
    },
    ...overrides.api,
  };
  const handle = createRecipientHandle({
    binding,
    api,
    isCurrent: () => current,
    readPending: () => api.pending(binding.sid),
  });
  return {
    api,
    calls,
    handle,
    stale: () => {
      current = false;
    },
  };
}

test("recipient claim, correlated reply, idempotency, and acknowledgement stay on the bound session", async () => {
  const { calls, handle } = fixture();
  const lease = await handle.recipient("claim", { kind: "msg" });
  assert.equal(lease.sid, binding.sid);
  assert.equal(lease.epoch, binding.epoch);
  const admission = await handle.recipient("reply", {
    lease: lease.id,
    msg: "answer",
    key: "reply-key",
  });
  assert.deepEqual(admission, { id: "reply-message", repeat: false, init: 20 });
  assert.deepEqual(calls.filter(([op]) => op === "send")[0], [
    "send",
    binding.sid,
    sender,
    { msg: "answer" },
    { key: "reply-key" },
  ]);
  assert.deepEqual(
    await handle.recipient("reply", { lease: lease.id, msg: "answer", key: "reply-key" }),
    admission,
  );
  assert.equal(calls.filter(([op]) => op === "send").length, 1);
  await assert.rejects(
    handle.recipient("reply", { lease: lease.id, msg: "different", key: "reply-key" }),
    { code: "key_conflict" },
  );
  const receipt = await handle.recipient("ack", { lease: lease.id, outcome: "done" });
  assert.equal(receipt.outcome, "done");
  assert.equal(
    calls.some(([op, sid]) => op === "claim" && sid !== binding.sid),
    false,
  );
});

test("recipient rejects stale bindings and foreign or expired leases", async () => {
  const stale = fixture();
  stale.stale();
  await assert.rejects(stale.handle.recipient("pending", {}), { code: "owner" });
  assert.equal(stale.calls.length, 0);

  const foreign = fixture();
  await assert.rejects(foreign.handle.recipient("touch", { lease: "foreign-lease" }), {
    code: "lease",
  });
  assert.equal(
    foreign.calls.some(([op]) => op === "touch"),
    false,
  );
  await assert.rejects(
    foreign.handle.recipient("ack", { lease: "foreign-lease", outcome: "done" }),
    { code: "lease" },
  );

  const expired = fixture({
    api: {
      touch: () => {
        throw new Fault("expired", "Lease expired");
      },
    },
  });
  const lease = await expired.handle.recipient("claim", { kind: "msg" });
  await assert.rejects(expired.handle.recipient("touch", { lease: lease.id }), { code: "expired" });
  const next = await expired.handle.recipient("claim", { kind: "work" });
  assert.equal(next.kind, "work");

  const staleSettlement = fixture();
  const owned = await staleSettlement.handle.recipient("claim", { kind: "msg" });
  staleSettlement.stale();
  await assert.rejects(
    staleSettlement.handle.recipient("ack", { lease: owned.id, outcome: "done" }),
    { code: "owner" },
  );
  assert.equal(
    staleSettlement.calls.some(([op]) => op === "ack"),
    false,
  );
});

test("reply idempotency keys cannot be reused across claimed messages", async () => {
  const { calls, handle } = fixture();
  const first = await handle.recipient("claim", { kind: "msg" });
  const second = await handle.recipient("claim", { kind: "msg" });
  await handle.recipient("reply", { lease: first.id, msg: "answer", key: "shared-key" });
  await assert.rejects(
    handle.recipient("reply", { lease: second.id, msg: "answer", key: "shared-key" }),
    { code: "key_conflict" },
  );
  assert.equal(calls.filter(([op]) => op === "send").length, 1);
});

test("uncertain claim or settlement blocks a new claim without allocating another lease", async () => {
  let claims = 0;
  const uncertainClaim = fixture({
    api: {
      claim: () => {
        claims++;
        throw new Fault("uncertain", "Claim outcome unknown");
      },
    },
  });
  await assert.rejects(uncertainClaim.handle.recipient("claim", { kind: "msg" }), {
    code: "uncertain",
  });
  await assert.rejects(uncertainClaim.handle.recipient("claim", { kind: "msg" }), {
    code: "uncertain",
  });
  assert.equal(claims, 1);

  let acknowledgements = 0;
  const uncertainAck = fixture({
    api: {
      ack: () => {
        acknowledgements++;
        throw new Fault("timeout", "Settlement response lost");
      },
    },
  });
  const lease = await uncertainAck.handle.recipient("claim", { kind: "msg" });
  await assert.rejects(uncertainAck.handle.recipient("ack", { lease: lease.id, outcome: "done" }), {
    code: "timeout",
  });
  await assert.rejects(uncertainAck.handle.recipient("claim", { kind: "msg" }), {
    code: "uncertain",
  });
  assert.equal(acknowledgements, 1);
});

test("closing a recipient cancels its caller and keeps a late claim from being reused", async () => {
  let finishClaim;
  let started;
  const startedClaim = new Promise((resolve) => {
    started = resolve;
  });
  const pendingClaim = new Promise((resolve) => {
    finishClaim = resolve;
  });
  const { handle } = fixture({
    api: {
      claim: () => {
        started();
        return pendingClaim;
      },
    },
  });
  const claim = handle.recipient("claim", { kind: "msg" });
  await startedClaim;
  handle.close();
  await assert.rejects(claim, { code: "owner" });
  finishClaim({
    id: "late-lease",
    mid: "late-message",
    sid: binding.sid,
    epoch: binding.epoch,
    until: Date.now() + 30_000,
    attempt: 1,
    kind: "msg",
    msg: "question",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(handle.recipient("claim", { kind: "msg" }), { code: "owner" });
});

test("supervisor recipient seam uses Relay leases and replies only to the claimed sender", async (t) => {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "relay-recipient-home-"));
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const root = temporaryRoot(t);
  setup({ root, device: "recipient", role: "host" });
  const relay = openForBroker({ root, role: "host", ownerToken: "R".repeat(32) });
  t.after(() => relay.close());
  const owner = claimDeliveryOwner(relay);
  const senderWorker = relay.register("worker");
  const recipientWorker = relay.register("worker");
  const senderSession = relay.join(senderWorker.id);
  const recipientSession = relay.join(recipientWorker.id);
  const original = relay.send(senderSession.id, recipientWorker.id, { msg: "question" });
  const secondOriginal = relay.send(senderSession.id, recipientWorker.id, {
    msg: "another question",
  });
  let replySubmissions = 0;
  const send = relay.send.bind(relay);
  relay.send = (...args) => {
    replySubmissions++;
    return send(...args);
  };
  const consumer = {
    status: async () => ({ state: "busy" }),
    submit: async () => ({ accepted: true }),
    observe: async () => ({ state: "unknown" }),
  };
  const supervisor = createDeliverySupervisor({
    local: relay,
    hub: null,
    pool: null,
    launchConfigured: false,
    ownerGeneration: owner.generation,
    clients: ["hermes"],
    pollMs: 250,
  });
  t.after(() => supervisor.close());
  await supervisor.start();
  const handle = await supervisor.bind({
    authority: relay.authority,
    worker: recipientWorker.id,
    sid: recipientSession.id,
    epoch: recipientSession.epoch,
    client: "hermes",
    target: {
      runtimeInstance: "recipient",
      profile: "default",
      nativeSession: "recipient",
      lifecycleGeneration: "1",
    },
    capabilities: { context: true, idle: true, launch: false },
    consumer,
  });
  const secondHandle = await supervisor.bind({
    authority: relay.authority,
    worker: recipientWorker.id,
    sid: recipientSession.id,
    epoch: recipientSession.epoch,
    client: "hermes",
    target: {
      runtimeInstance: "recipient",
      profile: "default",
      nativeSession: "recipient-2",
      lifecycleGeneration: "1",
    },
    capabilities: { context: true, idle: true, launch: false },
    consumer,
  });
  const lease = await handle.recipient("claim", { kind: "msg" });
  assert.equal(lease.mid, original.id);
  const reply = await handle.recipient("reply", { lease: lease.id, msg: "answer", key: "reply-1" });
  const sent = relay.get(reply.id, {});
  assert.equal(sent.from, recipientWorker.id);
  assert.equal(sent.to, senderWorker.id);
  assert.equal(sent.state, "pending");
  const secondLease = await secondHandle.recipient("claim", { kind: "msg" });
  assert.equal(secondLease.mid, secondOriginal.id);
  await assert.rejects(
    secondHandle.recipient("reply", { lease: secondLease.id, msg: "answer", key: "reply-1" }),
    { code: "key_conflict" },
  );
  assert.equal(replySubmissions, 1);
  await secondHandle.recipient("release", { lease: secondLease.id });
  const receipt = await handle.recipient("ack", { lease: lease.id, outcome: "done" });
  assert.equal(receipt.mid, original.id);
  assert.equal(relay.get(original.id, {}).state, "done");

  await supervisor.close();
  await assert.rejects(handle.recipient("pending", {}), { code: "owner" });
});
