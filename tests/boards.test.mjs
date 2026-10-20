import test from "node:test";
import assert from "node:assert/strict";
import { inspectAttempt, open } from "../src/relay.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

test("A48/A49/A50 board Inbox and work remain separate projections", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "boards" });
  t.after(() => relay.close());
  const worker = relay.register("worker", { caps: ["read"] });
  const session = relay.join(worker.id);
  const board = `host:${relay.device.id}`;
  const inbox = relay.post(session.id, board, { msg: "work: stays text" });
  const job = relay.post(
    session.id,
    board,
    { work: { task: "inspect" } },
    { needs: ["read"], series: "serial" },
  );
  assert.equal(relay.get(inbox.id, { data: true }).kind, "msg");
  assert.equal(relay.get(job.id).kind, "work");
  assert.equal(relay.list({ board, kind: "msg" }).total, 1);
  assert.equal(relay.list({ board, kind: "work" }).total, 1);
  assert.equal(relay.list({ board, kind: "msg" }).items[0].state, "posted");
  assert.throws(() => relay.post(session.id, board, { msg: "bad" }, { needs: ["read"] }), {
    code: "input",
  });
  const lease = relay.claim(session.id, { board });
  assert.equal(lease.mid, job.id);
});

test("A38 earlier ineligible series member blocks later work", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "series" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const board = `host:${relay.device.id}`;
  relay.post(session.id, board, { work: { step: 1 } }, { needs: ["missing"], series: "s" });
  relay.post(session.id, board, { work: { step: 2 } }, { series: "s" });
  assert.equal(relay.claim(session.id, { board }), null);
});

test("A38 blocked series does not starve independent eligible work", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "series-independent" });
  t.after(() => relay.close());
  const worker = relay.register("worker", { caps: ["inspect"] });
  const session = relay.join(worker.id);
  const board = `host:${relay.device.id}`;
  relay.post(session.id, board, { work: { step: 1 } }, { needs: ["missing"], series: "s" });
  relay.post(session.id, board, { work: { step: 2 } }, { needs: ["inspect"], series: "s" });
  const independent = relay.post(
    session.id,
    board,
    { work: { task: "independent" } },
    { needs: ["inspect"] },
  );
  const lease = relay.claim(session.id, { board });
  assert.equal(lease.mid, independent.id);
  relay.ack(session.id, lease.id, "done");
  assert.equal(relay.claim(session.id, { board }), null);
});

test("A05/A06 an expired board claim is requeued by the authority for another worker", (t) => {
  const relay = open({
    root: temporaryRoot(t),
    device: "hub",
    role: "hub",
    sessionMs: 60000,
    claimMs: 1000,
  });
  t.after(() => relay.close());
  const owner = relay.register("worker", { slot: "001" });
  const claimant = relay.register("worker", { slot: "002" });
  const ownerSession = relay.join(owner.id);
  const claimantSession = relay.join(claimant.id);
  const job = relay.post(ownerSession.id, "bounty", { work: { task: "abandoned" } });
  const abandoned = relay.claim(ownerSession.id, { board: "bounty" });
  assert.equal(abandoned.mid, job.id);
  // A claim inside its lifetime stays exclusive: only expiry hands the job over.
  assert.equal(relay.claim(claimantSession.id, { board: "bounty" }), null);
  const wall = Date.now;
  try {
    Date.now = () => abandoned.until;
    const reclaimed = relay.claim(claimantSession.id, { board: "bounty" });
    assert.equal(reclaimed.mid, job.id);
    assert.equal(reclaimed.attempt, 2);
    assert.notEqual(reclaimed.id, abandoned.id);
    assert.equal(
      inspectAttempt(relay, { sid: ownerSession.id, lease: abandoned.id }).state,
      "expired",
    );
    assert.throws(() => relay.ack(ownerSession.id, abandoned.id, "done"), { code: "lease" });
    assert.equal(relay.ack(claimantSession.id, reclaimed.id, "done").mid, job.id);
    assert.equal(relay.stats().messages.done, 1);
    assert.equal(relay.stats().messages.claimed, 0);
  } finally {
    Date.now = wall;
  }
});
