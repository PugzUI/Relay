import test from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/relay.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

test("A48/A49/A50 board Inbox and work remain separate projections", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "boards" }); t.after(() => relay.close());
  const worker = relay.register("worker", { caps: ["read"] }); const session = relay.join(worker.id);
  const board = `host:${relay.device.id}`;
  const inbox = relay.post(session.id, board, { msg: "work: stays text" });
  const job = relay.post(session.id, board, { work: { task: "inspect" } }, { needs: ["read"], series: "serial" });
  assert.equal(relay.get(inbox.id, { data: true }).kind, "msg");
  assert.equal(relay.get(job.id).kind, "work");
  assert.equal(relay.list({ board, kind: "msg" }).total, 1);
  assert.equal(relay.list({ board, kind: "work" }).total, 1);
  assert.equal(relay.list({ board, kind: "msg" }).items[0].state, "posted");
  assert.throws(() => relay.post(session.id, board, { msg: "bad" }, { needs: ["read"] }), { code: "input" });
  const lease = relay.claim(session.id, { board }); assert.equal(lease.mid, job.id);
});

test("A38 earlier ineligible series member blocks later work", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "series" }); t.after(() => relay.close());
  const worker = relay.register("worker"); const session = relay.join(worker.id); const board = `host:${relay.device.id}`;
  relay.post(session.id, board, { work: { step: 1 } }, { needs: ["missing"], series: "s" });
  relay.post(session.id, board, { work: { step: 2 } }, { series: "s" });
  assert.equal(relay.claim(session.id, { board }), null);
});
