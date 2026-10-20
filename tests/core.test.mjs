import test from "node:test";
import assert from "node:assert/strict";
import {
  bindCapacity,
  beginCapacitySettlement,
  dispatchRpc,
  inspectAttempt,
  listCapacity,
  open,
  reserveCapacity,
  reserveLaunch,
  resolveCapacity,
  updateLaunch,
} from "../src/relay.mjs";
import { Fault } from "../src/fault.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

test("A01/A02/A03/A09 durable send, keyed replay, claim, and acknowledgement", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "core" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const first = relay.send(session.id, worker.id, { work: { b: 2, a: 1 } }, { key: "repeat" });
  const repeat = relay.send(session.id, worker.id, { work: { a: 1, b: 2 } }, { key: "repeat" });
  assert.equal(repeat.id, first.id);
  assert.equal(repeat.repeat, true);
  assert.throws(
    () => relay.send(session.id, worker.id, { msg: "changed kind" }, { key: "repeat" }),
    { code: "key_conflict" },
  );
  const lease = relay.claim(session.id);
  assert.equal(lease.mid, first.id);
  assert.deepEqual(lease.work, { a: 1, b: 2 });
  const receipt = relay.ack(session.id, lease.id, "done");
  assert.equal(receipt.mid, first.id);
  assert.deepEqual(relay.ack(session.id, lease.id, "done"), receipt);
  assert.throws(() => relay.ack(session.id, lease.id, "failed"), { code: "ack_conflict" });
  assert.equal(relay.stats().messages.done, 1);
});

test("A07/A08 fence replacement epochs and resume only the supplied session", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "fence", sessionMs: 1000, claimMs: 1000 });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const old = relay.join(worker.id);
  const newer = relay.join(worker.id, { replace: true });
  assert.equal(newer.epoch, old.epoch + 1);
  assert.throws(() => relay.renew(old.id), { code: "session" });
  assert.throws(() => relay.resume(old.id), { code: "session" });
  assert.equal(relay.resume(newer.id).id, newer.id);
});

test("A11 honest JSON rejects lossy values before insertion", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "json" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const sparse = [];
  sparse.length = 1;
  for (const value of [
    sparse,
    NaN,
    {
      get x() {
        throw new Error("must not invoke");
      },
    },
  ]) {
    assert.throws(() => relay.send(session.id, worker.id, { work: value }), { code: "data" });
  }
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => relay.send(session.id, worker.id, { work: cycle }), { code: "data" });
  assert.equal(relay.stats().messages.rows, 0);
});

test("A55 post-lock RPC gate rolls back application and journal writes", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "rpc" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const authorization = {
    operation: "send",
    scopeKey: "scope",
    principal: {
      id: "p",
      grant: {
        workers: [worker.id],
        recipients: [worker.id],
        register: [],
        enroll: [],
        boardPost: [],
        boardClaim: [],
        inboxRead: [],
        workRead: [],
        inspect: { messages: true, receipts: false, audit: false, topology: false },
        reportDevice: null,
      },
    },
  };
  assert.throws(
    () =>
      dispatchRpc(relay, {
        authorization,
        rid: "gate",
        op: "send",
        args: { sid: session.id, to: worker.id, envelope: { msg: "held" } },
        beforeCommit() {
          throw new Fault("auth", "revoked");
        },
      }),
    { code: "auth" },
  );
  assert.equal(relay.stats().messages.rows, 0);
  assert.equal(relay._store.db.prepare("SELECT COUNT(*) AS n FROM rpc").get().n, 0);
});

test("A56 reservation retries retain exact authority, request, and attempt proof", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "reserve" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const board = `host:${relay.device.id}`;
  const admission = relay.post(session.id, board, { work: { task: 1 } });
  const reservation = reserveCapacity(relay, {
    worker: worker.id,
    localSid: session.id,
    remoteSid: null,
    board,
    rid: "claim-1",
    authority: relay.authority,
    maxJobs: 1,
  });
  assert.equal(
    reserveCapacity(relay, {
      worker: worker.id,
      localSid: session.id,
      remoteSid: null,
      board,
      rid: "claim-1",
      authority: relay.authority,
      maxJobs: 1,
    }).rid,
    reservation.rid,
  );
  const lease = relay.claim(session.id, { board });
  assert.equal(lease.mid, admission.id);
  bindCapacity(relay, { worker: worker.id, rid: "claim-1", authority: relay.authority, lease });
  assert.throws(
    () =>
      resolveCapacity(relay, {
        worker: worker.id,
        rid: "claim-1",
        proof: {
          kind: "attempt",
          rid: "wrong",
          authority: relay.authority,
          mid: lease.mid,
          lease: lease.id,
          epoch: lease.epoch,
          state: "done",
        },
      }),
    { code: "lease" },
  );
  beginCapacitySettlement(relay, {
    worker: worker.id,
    rid: "claim-1",
    authority: relay.authority,
    settleRid: "settle-1",
    outcome: "done",
  });
  assert.equal(
    beginCapacitySettlement(relay, {
      worker: worker.id,
      rid: "claim-1",
      authority: relay.authority,
      settleRid: "settle-1",
      outcome: "done",
    }).settleRid,
    "settle-1",
  );
  const receipt = relay.ack(session.id, lease.id, "done");
  assert.equal(inspectAttempt(relay, { sid: session.id, lease: lease.id }).state, "done");
  assert.equal(
    resolveCapacity(relay, {
      worker: worker.id,
      rid: "claim-1",
      proof: {
        kind: "attempt",
        rid: "claim-1",
        authority: relay.authority,
        mid: receipt.mid,
        lease: lease.id,
        epoch: lease.epoch,
        state: "done",
      },
    }),
    null,
  );
  assert.deepEqual(listCapacity(relay), []);
});

test("addressed work capacity uses the shared budget and binds only its exact local claim", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "addressed-capacity" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const other = relay.register("worker");
  const otherSession = relay.join(other.id);
  const board = `host:${relay.device.id}`;
  const addressed = relay.send(session.id, worker.id, { work: { task: "addressed" } });
  relay.post(session.id, board, { work: { task: "board" } });
  const reservationInput = {
    worker: worker.id,
    localSid: session.id,
    remoteSid: null,
    board: null,
    rid: "addressed-claim",
    authority: relay.authority,
    maxJobs: 1,
  };
  const reserved = reserveCapacity(relay, reservationInput);
  assert.equal(reserved.board, null);
  assert.equal(
    relay._store.db.prepare("SELECT board FROM reservations WHERE worker=?").get(worker.id).board,
    "@addressed",
  );
  assert.equal(reserveCapacity(relay, reservationInput).board, null);
  assert.throws(
    () =>
      reserveCapacity(relay, {
        ...reservationInput,
        worker: other.id,
        localSid: otherSession.id,
        rid: "other-claim",
      }),
    { code: "full" },
  );
  assert.throws(
    () =>
      reserveCapacity(relay, { ...reservationInput, rid: "sentinel-claim", board: "@addressed" }),
    { code: "input" },
  );

  const wrongTarget = relay.claim(session.id, { board });
  assert.throws(
    () =>
      bindCapacity(relay, {
        worker: worker.id,
        rid: reserved.rid,
        authority: relay.authority,
        lease: wrongTarget,
      }),
    { code: "lease" },
  );
  const lease = relay.claim(session.id, { kind: "work" });
  assert.equal(lease.mid, addressed.id);
  const held = bindCapacity(relay, {
    worker: worker.id,
    rid: reserved.rid,
    authority: relay.authority,
    lease,
  });
  assert.equal(held.board, null);
  assert.equal(listCapacity(relay, { worker: worker.id })[0].board, null);
  beginCapacitySettlement(relay, {
    worker: worker.id,
    rid: reserved.rid,
    authority: relay.authority,
    settleRid: "addressed-settle",
    outcome: "done",
  });
  const receipt = relay.ack(session.id, lease.id, "done");
  assert.equal(
    resolveCapacity(relay, {
      worker: worker.id,
      rid: reserved.rid,
      proof: {
        kind: "attempt",
        rid: reserved.rid,
        authority: relay.authority,
        mid: receipt.mid,
        lease: lease.id,
        epoch: lease.epoch,
        state: "done",
      },
    }),
    null,
  );
  assert.deepEqual(listCapacity(relay), []);
});

test("A57 launch readiness binds the nonce, worker identity, session, and capability set", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "launcher" });
  t.after(() => relay.close());
  const prime = relay.register("worker", { slot: "prime" });
  const primeSession = relay.join(prime.id);
  const recipeHash = "a".repeat(64);
  const launch = reserveLaunch(relay, {
    primeSid: primeSession.id,
    runtime: "worker",
    requestId: "launch-1",
    recipeHash,
    capabilities: ["cpu"],
    demand: 1,
    readySpare: 0,
    maxChildren: 2,
  });
  assert.equal(
    reserveLaunch(relay, {
      primeSid: primeSession.id,
      runtime: "worker",
      requestId: "launch-1",
      recipeHash,
      capabilities: ["cpu"],
      demand: 1,
      readySpare: 0,
      maxChildren: 2,
    }).id,
    launch.id,
  );
  const handle = {
    platform: process.platform,
    pid: process.pid,
    processStart: "test-start",
    nonce: "abcdefghijklmnop",
  };
  const worker = relay.register("worker", { caps: ["cpu"] });
  const session = relay.join(worker.id);
  const ready = {
    worker: worker.id,
    sid: session.id,
    epoch: session.epoch,
    nonce: handle.nonce,
    caps: ["cpu"],
  };
  assert.throws(
    () =>
      updateLaunch(relay, {
        id: launch.id,
        from: "starting",
        to: "running",
        handle,
        ready: { ...ready, worker: "elsewhere:worker:001" },
      }),
    { code: "protocol" },
  );
  const running = updateLaunch(relay, {
    id: launch.id,
    from: "starting",
    to: "running",
    handle,
    ready,
  });
  assert.equal(running.state, "running");
  assert.equal(running.worker, worker.id);
  assert.equal(
    updateLaunch(relay, {
      id: launch.id,
      from: "running",
      to: "exited",
      handle,
      exitCode: 0,
      signal: null,
    }).state,
    "exited",
  );
});

test("A10 expiry at until commits reclaim before returning the fault", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "expiry", sessionMs: 10000, claimMs: 1000 });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const admission = relay.send(session.id, worker.id, { msg: "expires" });
  const first = relay.claim(session.id);
  const wall = Date.now;
  try {
    Date.now = () => first.until;
    assert.throws(() => relay.ack(session.id, first.id, "done"), { code: "expired" });
    assert.equal(inspectAttempt(relay, { sid: session.id, lease: first.id }).state, "expired");
    const second = relay.claim(session.id);
    assert.equal(second.mid, admission.id);
    assert.notEqual(second.id, first.id);
    assert.equal(second.attempt, 2);
    assert.throws(() => relay.ack(session.id, first.id, "done"), { code: "lease" });
    assert.equal(inspectAttempt(relay, { sid: session.id, lease: second.id }).state, "live");
  } finally {
    Date.now = wall;
  }
});

test("A05/A52 an abandoned claim is requeued by the authority, not only by its owner", (t) => {
  const relay = open({
    root: temporaryRoot(t),
    device: "requeue",
    sessionMs: 60000,
    claimMs: 1000,
  });
  t.after(() => relay.close());
  const owner = relay.register("worker", { slot: "001" });
  const other = relay.register("worker", { slot: "002" });
  const ownerSession = relay.join(owner.id);
  const otherSession = relay.join(other.id);
  const board = `host:${relay.device.id}`;
  const addressed = relay.send(ownerSession.id, owner.id, { work: { task: "addressed" } });
  const posted = relay.post(ownerSession.id, board, { work: { task: "board" } });
  const addressedLease = relay.claim(ownerSession.id);
  const boardLease = relay.claim(ownerSession.id, { board });
  assert.equal(addressedLease.mid, addressed.id);
  assert.equal(boardLease.mid, posted.id);
  assert.equal(relay.stats().messages.claimed, 2);
  const wall = Date.now;
  try {
    Date.now = () => boardLease.until;
    // The other worker owns no claim here; its mutation is what returns both
    // abandoned rows to the queue instead of leaving them charged as claimed.
    assert.equal(relay.claim(otherSession.id), null);
    assert.equal(relay.stats().messages.claimed, 0);
    assert.equal(relay.stats().messages.pending, 2);
    assert.equal(relay.list({ to: owner.id }).items[0].state, "pending");
    assert.equal(relay.list({ board, kind: "work" }).items[0].state, "pending");
  } finally {
    Date.now = wall;
  }
});

test("A15/A52 purge protects retained replay references and removes eligible terminal history", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "purge" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const admission = relay.send(session.id, worker.id, { work: { task: 1 } }, { key: "retained" });
  const lease = relay.claim(session.id);
  relay.ack(session.id, lease.id, "done");
  const db = relay._store.db;
  const now = Date.now();
  db.prepare("UPDATE messages SET acked=0 WHERE id=?").run(admission.id);
  db.prepare("UPDATE send_keys SET until=? WHERE mid=?").run(now, admission.id);
  db.prepare(
    "INSERT INTO rpc(principal,rid,op,hash,committed,until,worker,sid,epoch,mid,lease,result,bytes) VALUES('p','r','ack','h',?,?,?, ?,?,?,?,'{}',2)",
  ).run(now - 1, now + 10000, worker.id, session.id, session.epoch, admission.id, lease.id);
  assert.equal(relay.purge({ before: now, dry: true }).eligible, 0);
  db.prepare("DELETE FROM rpc WHERE principal='p' AND rid='r'").run();
  const preview = relay.purge({ before: now, dry: true });
  assert.equal(preview.eligible, 1);
  assert.equal(preview.removed, 0);
  assert.equal(relay.purge({ before: now }).removed, preview.eligible);
  assert.equal(relay.get(admission.id), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE mid=?").get(admission.id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leases WHERE mid=?").get(admission.id).n, 0);
});

test("A52 board history reports scoped cumulative pruning and dry run has no effects", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "history" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const board = `host:${relay.device.id}`;
  relay.post(session.id, board, { msg: "inbox" });
  relay.post(session.id, board, { work: { task: 1 } });
  relay.ack(session.id, relay.claim(session.id, { board }).id, "done");
  relay._store.db.prepare("UPDATE messages SET init=0,acked=0").run();
  const before = relay._store.db.prepare("SELECT key,value FROM meta ORDER BY key").all();
  assert.equal(relay.purge({ before: Date.now(), dry: true }).eligible, 2);
  assert.deepEqual(
    relay._store.db.prepare("SELECT key,value FROM meta ORDER BY key").all(),
    before,
  );
  assert.equal(relay.purge({ before: Date.now() }).removed, 2);
  assert.equal(relay.purge({ before: Date.now() }).removed, 0);
  assert.equal(relay.list({ board, kind: "msg" }).pruned, 1);
  assert.equal(relay.list({ board, kind: "work" }).pruned, 1);
  assert.equal(relay.list({ board }).pruned, 2);
});

test("A49 firstSeq follows the permitted board view", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "firstseq" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const board = `host:${relay.device.id}`;
  const hiddenInbox = relay.post(session.id, board, { msg: "private inbox" });
  const visibleWork = relay.post(session.id, board, { work: { task: 1 } });
  const hiddenSeq = relay.get(hiddenInbox.id).seq;
  const visibleSeq = relay.get(visibleWork.id).seq;
  const authorization = {
    scopeKey: "work-only",
    principal: { grant: { inboxRead: [], workRead: [board], workers: [], inspect: {} } },
  };
  for (const options of [{ board }, { board, kind: "work" }]) {
    const page = relay.list(options, authorization);
    assert.equal(page.total, 1);
    assert.equal(page.firstSeq, visibleSeq);
    assert.notEqual(page.firstSeq, hiddenSeq);
  }
  relay._store.db
    .prepare("INSERT INTO meta(key,value) VALUES('messagePruned',?)")
    .run(JSON.stringify({ [`${board}|msg`]: 4, [`${board}|work`]: 2 }));
  assert.equal(relay.list({ board }, authorization).pruned, 2);
});

test("A45 reports accept native endpoints and reject private or foreign event metadata", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "report" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const boardId = `host:${relay.device.id}`;
  const base = {
    agents: [{ worker: worker.id, state: "ready", free: 1, assignmentCount: 0 }],
    board: { id: boardId, inbox: 0, pending: 0, claimed: 0, terminal: 0 },
  };
  const nativeEvent = {
    seq: 1,
    type: "post",
    from: worker.id,
    to: boardId,
    mid: "4f31b817-9d91-4d27-9ba1-54e66373a133",
    state: "posted",
    code: null,
  };
  const receipt = relay.report(session.id, { ...base, seq: 1, events: [nativeEvent] });
  assert.deepEqual(Object.keys(receipt).sort(), ["accepted", "receivedAt", "seq", "staleAfter"]);
  const auditCount = () => relay._store.db.prepare("SELECT COUNT(*) AS n FROM audit").get().n;
  const before = auditCount();
  assert.throws(
    () =>
      relay.report(session.id, {
        ...base,
        seq: 2,
        events: [{ ...nativeEvent, seq: 2, code: "bearer-secret" }],
      }),
    { code: "input" },
  );
  assert.throws(
    () =>
      relay.report(session.id, {
        ...base,
        seq: 2,
        events: [{ ...nativeEvent, seq: 2, mid: "private body" }],
      }),
    { code: "input" },
  );
  assert.throws(
    () =>
      relay.report(session.id, {
        ...base,
        seq: 2,
        events: [{ ...nativeEvent, seq: 2, to: "foreign:worker:001" }],
      }),
    { code: "denied" },
  );
  assert.equal(auditCount(), before);
  assert.equal(
    relay._store.db.prepare("SELECT seq FROM reports WHERE device=?").get(relay.device.id).seq,
    1,
  );
});
