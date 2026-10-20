import test from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/relay.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

test("A42/A45 unknown reported assignment capacity stays unknown, not zero", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "capacity-report" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const board = { id: `host:${relay.device.id}`, inbox: 0, pending: 0, claimed: 0, terminal: 0 };
  relay.report(session.id, {
    seq: 1,
    agents: [{ worker: worker.id, state: "unknown", free: null, assignmentCount: 0 }],
    board,
  });
  const unknown = relay.snapshot();
  assert.equal(unknown.devices[0].stale, false);
  assert.equal(unknown.devices[0].free, null);
  relay.report(session.id, {
    seq: 2,
    agents: [{ worker: worker.id, state: "ready", free: 1, assignmentCount: 0 }],
    board,
  });
  assert.equal(relay.snapshot().devices[0].free, 1);
});
