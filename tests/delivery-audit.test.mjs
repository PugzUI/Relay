import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimDeliveryOwner,
  deliveryStatus,
  listDeliveryAttempts,
  openForBroker,
} from "../src/relay.mjs";
import { createDeliverySupervisor } from "../src/delivery.mjs";
import { formatDeliveryNotice } from "../src/delivery-notice.mjs";
import { setup } from "../src/index.mjs";
import { Fault } from "../src/fault.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

function isolatedRoot(t) {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "relay-delivery-audit-home-"));
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const root = temporaryRoot(t);
  setup({ root, device: "audit", role: "host" });
  const relay = openForBroker({ root, role: "host", ownerToken: "A".repeat(32) });
  t.after(() => relay.close());
  const owner = claimDeliveryOwner(relay);
  return { root, relay, owner };
}

function localBinding(relay, target, consumer, pending = true) {
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  if (pending) relay.send(session.id, worker.id, { msg: "pending" });
  return {
    authority: relay.authority,
    worker: worker.id,
    sid: session.id,
    epoch: session.epoch,
    client: "hermes",
    target,
    capabilities: { context: true, idle: true, launch: false },
    consumer,
  };
}

function waitFor(predicate, ms = 2000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("delivery audit assertion timed out"));
      setTimeout(check, 5);
    };
    check();
  });
}

test("notice formatting reports only scopes that fit the byte limit", () => {
  const scopes = Array.from({ length: 16 }, (_, index) => ({
    binding: { id: `binding-${index}` },
    summary: {
      pending: { msg: 1, work: 0 },
      recoverable: { msg: 0, work: 0 },
      revision: "a".repeat(64),
    },
  }));
  const formatted = formatDeliveryNotice(scopes);
  assert.ok(Buffer.byteLength(formatted.text, "utf8") <= 2048);
  assert.equal(formatted.scopes.length, 14);
  assert.equal((formatted.text.match(/^scope /gm) ?? []).length, formatted.scopes.length);
  assert.deepEqual(formatted.scopes, scopes.slice(0, 14));
});

test("byte-limited notice scopes omitted from one attempt remain eligible", async (t) => {
  const { relay, owner } = isolatedRoot(t);
  const submitted = [];
  const observations = new Map();
  const consumer = {
    status: async () => ({ state: "idle" }),
    submit: ({ attemptId, notice }) => {
      submitted.push({ attemptId, notice });
      return Promise.resolve({ accepted: true, nativeRequestId: `native-${attemptId}` });
    },
    observe: ({ attemptId, nativeRequestId }) => {
      const step = (observations.get(attemptId) ?? 0) + 1;
      observations.set(attemptId, step);
      return Promise.resolve({
        state: ["context_observed", "turn_started", "safe_idle"][Math.min(step - 1, 2)],
        nativeRequestId,
      });
    },
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
  const target = {
    runtimeInstance: "overflow",
    profile: "default",
    nativeSession: "overflow",
    lifecycleGeneration: "1",
  };
  for (let index = 0; index < 16; index++)
    await supervisor.bind(localBinding(relay, target, consumer));

  await waitFor(() => submitted.length >= 2, 5000);
  const attempts = listDeliveryAttempts(relay, owner.generation);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].state, "safe_idle");
  assert.equal(attempts[0].scopes.length, 14);
  assert.equal(attempts[1].scopes.length, 2);
  assert.equal((submitted[0].notice.match(/^scope /gm) ?? []).length, 14);
  assert.equal((submitted[1].notice.match(/^scope /gm) ?? []).length, 2);
  await supervisor.close();
});

test("refresh and safe-boundary requests share one pass and close stops its only timer", async (t) => {
  const { relay, owner } = isolatedRoot(t);
  let statusCalls = 0;
  const consumer = {
    status: () => {
      statusCalls++;
      return Promise.resolve({ state: "idle" });
    },
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
  const handle = await supervisor.bind(
    localBinding(
      relay,
      {
        runtimeInstance: "timer",
        profile: "default",
        nativeSession: "timer",
        lifecycleGeneration: "1",
      },
      consumer,
      false,
    ),
  );

  const originalPending = relay.pending.bind(relay);
  let reads = 0;
  let releaseFirst;
  let enteredFirst;
  const entered = new Promise((resolve) => {
    enteredFirst = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  relay.pending = async (sid) => {
    reads++;
    if (reads === 1) {
      enteredFirst();
      await blocked;
    }
    return originalPending(sid);
  };

  await entered;
  const first = supervisor.refresh();
  const second = supervisor.refresh();
  assert.equal(first, second);
  handle.safeBoundary();
  releaseFirst();
  await first;
  await waitFor(() => reads >= 2);
  assert.equal(reads, 2, "coalesced triggers schedule one follow-up pass");
  assert.equal(statusCalls, 0, "empty pending state skips native status");

  await supervisor.close();
  const stoppedAt = reads;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(reads, stoppedAt, "close clears the single polling timer");
  assert.equal(deliveryStatus(relay).owner.active, false);
});

test("direct refresh cancels the pending poll timer while its pass is in flight", async (t) => {
  const { relay, owner } = isolatedRoot(t);
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
  await supervisor.bind(
    localBinding(
      relay,
      {
        runtimeInstance: "refresh-timer",
        profile: "default",
        nativeSession: "refresh-timer",
        lifecycleGeneration: "1",
      },
      consumer,
      false,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  await supervisor.refresh();

  const originalPending = relay.pending.bind(relay);
  let reads = 0;
  let release;
  let entered;
  const readStarted = new Promise((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  relay.pending = async (sid) => {
    reads++;
    if (reads === 1) {
      entered();
      await blocked;
    }
    return originalPending(sid);
  };

  const pass = supervisor.refresh();
  await readStarted;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(reads, 1, "the previous poll timer was cleared when refresh began");
  release();
  await pass;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads, 1, "refresh does not queue a second pass from the old poll timer");
  await supervisor.close();
});

test("explicit native refusal permits bounded same-revision progress", async (t) => {
  const { relay, owner } = isolatedRoot(t);
  let submissions = 0;
  const consumer = {
    status: async () => ({ state: "idle" }),
    submit: async () => ({
      accepted: ++submissions > 1,
      ...(submissions > 1 ? {} : { state: "refused" }),
    }),
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
  await supervisor.bind(
    localBinding(
      relay,
      {
        runtimeInstance: "refusal",
        profile: "default",
        nativeSession: "refusal",
        lifecycleGeneration: "1",
      },
      consumer,
    ),
  );
  await waitFor(() => submissions >= 2);
  const attempts = listDeliveryAttempts(relay, owner.generation);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].state, "refused");
  assert.equal(attempts[1].state, "admitted");
  assert.notEqual(attempts[0].id, attempts[1].id);
  await supervisor.close();
});

test("a refusal observation cannot erase an already accepted attempt", async (t) => {
  const { relay, owner } = isolatedRoot(t);
  let submissions = 0;
  const consumer = {
    status: async () => ({ state: "idle" }),
    submit: () => {
      submissions++;
      return Promise.resolve({ accepted: true, nativeRequestId: "accepted-1" });
    },
    observe: async () => ({ state: "refused", nativeRequestId: "accepted-1" }),
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
  await supervisor.bind(
    localBinding(
      relay,
      {
        runtimeInstance: "accepted-refusal",
        profile: "default",
        nativeSession: "accepted-refusal",
        lifecycleGeneration: "1",
      },
      consumer,
    ),
  );
  await waitFor(() =>
    listDeliveryAttempts(relay, owner.generation).some((attempt) => attempt.state === "uncertain"),
  );
  assert.equal(listDeliveryAttempts(relay, owner.generation)[0].state, "uncertain");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(submissions, 1);
  assert.equal(deliveryStatus(relay).targets.locked, 1);
  await supervisor.close();
});

test("hub reads rotate fairly, stay below budget, and stale cache never triggers status", async (t) => {
  const { relay, owner } = isolatedRoot(t);
  const authority = "hub-audit";
  const rows = new Map();
  const reads = [];
  const hub = {
    authority,
    pending(sid) {
      reads.push(sid);
      const row = rows.get(sid);
      return Promise.resolve({
        v: 1,
        authority,
        worker: row.worker,
        epoch: row.epoch,
        revision: row.revision,
        pending: row.pending,
        recoverable: { msg: 0, work: 0 },
      });
    },
  };
  const ids = ["hub:worker:001", "hub:worker:002", "hub:worker:003"].map((worker, index) => {
    const sid = `remote-session-${index + 1}`;
    rows.set(sid, {
      worker,
      epoch: 1,
      revision: String(index + 1).repeat(64),
      pending: { msg: index === 0 ? 1 : 0, work: 0 },
    });
    return sid;
  });
  let statusCalls = 0;
  const consumer = {
    status: () => {
      statusCalls++;
      return Promise.resolve({ state: "busy" });
    },
    submit: async () => ({ accepted: true }),
    observe: async () => ({ state: "unknown" }),
  };
  const target = {
    runtimeInstance: "hub-fair",
    profile: "default",
    nativeSession: "hub-fair",
    lifecycleGeneration: "1",
  };
  const supervisor = createDeliverySupervisor({
    local: relay,
    hub,
    pool: null,
    launchConfigured: false,
    ownerGeneration: owner.generation,
    clients: ["hermes"],
    pollMs: 250,
  });
  t.after(() => supervisor.close());
  await supervisor.start();
  const handles = [];
  for (let index = 0; index < ids.length; index++) {
    const worker = [...rows.values()][index].worker;
    handles.push(
      await supervisor.bind({
        authority,
        worker,
        sid: ids[index],
        epoch: 1,
        client: "hermes",
        target,
        capabilities: { context: true, idle: true, launch: false },
        consumer,
      }),
    );
  }
  await waitFor(() => reads.length === 1);
  assert.deepEqual(reads, [ids[0]]);
  await waitFor(() => statusCalls === 1);
  await supervisor.refresh();
  assert.equal(
    statusCalls,
    1,
    "a stale cached pending summary cannot authorize another status or dispatch",
  );
  const explicit = await handles[1].recipient("pending", {});
  assert.equal(explicit.worker, rows.get(ids[1]).worker);
  assert.deepEqual(
    reads,
    [ids[0], ids[1]],
    "foreground reads do not compete for the background budget",
  );
  await waitFor(() => reads.length === 3, 4000);
  assert.deepEqual(
    reads,
    [ids[0], ids[1], ids[1]],
    "foreground reads do not advance the background cursor",
  );
  await waitFor(() => reads.length === 4, 4000);
  assert.deepEqual(
    reads,
    [ids[0], ids[1], ids[1], ids[2]],
    "scheduled reads still rotate across every binding",
  );
  assert.equal(statusCalls, 1, "fresh empty state also skips native status");
  await supervisor.close();
});

test("offline hub reads back off instead of retrying each polling tick", async (t) => {
  const { relay, owner } = isolatedRoot(t);
  let reads = 0;
  const hub = {
    authority: "offline-hub",
    pending() {
      reads++;
      return Promise.reject(new Fault("unavailable", "Hub is offline"));
    },
  };
  const consumer = {
    status: async () => ({ state: "busy" }),
    submit: async () => ({ accepted: true }),
    observe: async () => ({ state: "unknown" }),
  };
  const supervisor = createDeliverySupervisor({
    local: relay,
    hub,
    pool: null,
    launchConfigured: false,
    ownerGeneration: owner.generation,
    clients: ["hermes"],
    pollMs: 250,
  });
  t.after(() => supervisor.close());
  await supervisor.start();
  const handle = await supervisor.bind({
    authority: hub.authority,
    worker: "hub:worker:001",
    sid: "offline-session",
    epoch: 1,
    client: "hermes",
    target: {
      runtimeInstance: "offline",
      profile: "default",
      nativeSession: "offline",
      lifecycleGeneration: "1",
    },
    capabilities: { context: true, idle: true, launch: false },
    consumer,
  });
  await waitFor(() => reads === 1);
  assert.equal(supervisor.status().lastErrorCode, "unavailable");
  await assert.rejects(handle.recipient("pending", {}), { code: "unavailable" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    reads,
    2,
    "the explicit read reaches the authority without restarting background polling",
  );
  await supervisor.close();
});
