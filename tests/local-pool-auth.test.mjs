import test from "node:test";
import assert from "node:assert/strict";
import { dispatchLocalPool, dispatchRpc, open } from "../src/relay.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

test("A56 trusted local Pool can settle a network-owned current session without a forgeable signer name", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "local-pool" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const authorization = {
    operation: "join",
    scopeKey: "a".repeat(64),
    principal: { id: "network-owner", grant: { workers: [worker.id] } },
  };
  const session = dispatchRpc(relay, {
    authorization, rid: "join-network-owner", op: "join", args: { worker: worker.id }, beforeCommit() {},
  }).result;
  const board = `host:${relay.device.id}`;
  const admission = relay.post(session.id, board, { work: { task: "local-controller" } });
  const args = { sid: session.id, options: { board } };
  assert.throws(() => dispatchRpc(relay, {
    authorization: {
      operation: "claim", scopeKey: "b".repeat(64),
      principal: { id: `local:${relay.authority}`, grant: { workers: [worker.id], boardClaim: [board] } },
    },
    rid: "forged-local-name", op: "claim", args, beforeCommit() {},
  }), { code: "denied" });
  const claim = dispatchLocalPool(relay, { rid: "local-claim", op: "claim", args });
  assert.equal(claim.result.mid, admission.id);
  const replay = dispatchLocalPool(relay, { rid: "local-claim", op: "claim", args });
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.id, claim.result.id);
  const settlement = { sid: session.id, lease: claim.result.id, outcome: "done" };
  const ack = dispatchLocalPool(relay, { rid: "local-ack", op: "ack", args: settlement });
  assert.equal(ack.result.outcome, "done");
  assert.deepEqual(dispatchLocalPool(relay, { rid: "local-ack", op: "ack", args: settlement }).result, ack.result);
});
