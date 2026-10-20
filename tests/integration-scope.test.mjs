import assert from "node:assert/strict";
import test from "node:test";
import { open, setup } from "../src/index.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

test("message inspection does not grant board metadata or body access", (t) => {
  const root = temporaryRoot(t);
  setup({ root, device: "scope-review", role: "hub" });
  const relay = open({ root });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const addressed = relay.send(session.id, worker.id, { msg: "addressed" });
  relay.post(session.id, "bounty", { msg: "private board notice" });
  relay.post(session.id, "bounty", { work: { task: "private board work" } });
  const authorization = {
    scopeKey: "a".repeat(64),
    principal: {
      id: "message-inspector",
      grant: {
        workers: [],
        inboxRead: [],
        workRead: [],
        inspect: { messages: true },
      },
    },
  };
  for (const data of [false, true]) {
    const page = relay.list({ data }, authorization);
    assert.equal(page.total, 1);
    assert.deepEqual(
      page.items.map((item) => item.id),
      [addressed.id],
    );
    for (const kind of ["msg", "work"]) {
      const board = relay.list({ board: "bounty", kind, data }, authorization);
      assert.equal(board.total, 0);
      assert.deepEqual(board.items, []);
      assert.equal(board.firstSeq, null);
      assert.equal(board.pruned, 0);
    }
  }
});
