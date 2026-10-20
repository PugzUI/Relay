import test from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../src/pool.mjs";
import {
  bindCapacity,
  dispatchLocalPool,
  listCapacity,
  open,
  reserveCapacity,
  setup,
} from "../src/relay.mjs";
import { withTempDir } from "./network-helpers.mjs";

const options = (local, maxJobs = 1) => ({
  local,
  hub: null,
  maxAgents: 1,
  maxJobs,
  pollMs: 100,
  minBackoffMs: 100,
  maxBackoffMs: 500,
  launch: null,
});

test("Pool consumes addressed work under shared capacity and explicitly settles it", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "east" });
    const local = open({ root });
    const agent = local.register("worker");
    const session = local.join(agent.id);
    const other = local.register("worker");
    const otherSession = local.join(other.id);
    const board = `host:${local.device.id}`;
    const addressed = local.send(session.id, agent.id, { work: { task: "direct" } });
    local.post(session.id, board, { work: { task: "board" } });
    const pool = createPool(options(local));
    try {
      const input = { worker: agent.id, localSid: session.id };
      const direct = await pool.claim(input);
      assert.equal(direct.kind, "work");
      assert.equal(direct.board, null);
      assert.equal(direct.lease.mid, addressed.id);
      assert.equal(listCapacity(local, { worker: agent.id })[0].board, null);
      assert.equal(await pool.claim(input), null);
      assert.equal(await pool.claim({ worker: other.id, localSid: otherSession.id }), null);
      const receipt = await pool.settle({ worker: agent.id, item: direct, outcome: "done" });
      assert.equal(receipt.state, "settled");
      assert.equal(receipt.receipt.outcome, "done");
      const boardWork = await pool.claim(input);
      assert.equal(boardWork.kind, "work");
      assert.equal(boardWork.board, board);
      assert.equal(
        (await pool.settle({ worker: agent.id, item: boardWork, outcome: "done" })).state,
        "settled",
      );
      assert.deepEqual(listCapacity(local), []);
    } finally {
      await pool.close();
      local.close();
    }
  });
});

test("public concurrent claims are excluded per worker", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "east" });
    const local = open({ root });
    const agent = local.register("worker");
    const session = local.join(agent.id);
    local.send(session.id, agent.id, { work: { task: "one" } });
    const pool = createPool(options(local));
    try {
      const results = await Promise.all([
        pool.claim({ worker: agent.id, localSid: session.id }),
        pool.claim({ worker: agent.id, localSid: session.id }),
      ]);
      assert.equal(results.filter((item) => item?.state === "claimed").length, 1);
      assert.equal(results.filter((item) => item === null).length, 1);
      assert.equal(listCapacity(local, { worker: agent.id }).length, 1);
    } finally {
      await pool.close();
      local.close();
    }
  });
});

test("fresh Pool recovers an accepted addressed claim with its original RID", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "east" });
    const local = open({ root });
    const agent = local.register("worker");
    const session = local.join(agent.id);
    const admission = local.send(session.id, agent.id, { work: { task: "recover" } });
    const reservation = {
      worker: agent.id,
      localSid: session.id,
      remoteSid: null,
      board: null,
      rid: "direct-recovery",
      authority: local.authority,
      maxJobs: 1,
    };
    reserveCapacity(local, reservation);
    const lease = dispatchLocalPool(local, {
      rid: reservation.rid,
      op: "claim",
      args: { sid: session.id, options: { kind: "work" } },
    }).result;
    assert.equal(lease.mid, admission.id);
    bindCapacity(local, {
      worker: agent.id,
      rid: reservation.rid,
      authority: local.authority,
      lease,
    });
    const firstPool = createPool(options(local));
    await firstPool.close();
    const pool = createPool(options(local));
    const controller = new AbortController();
    let called = 0;
    try {
      const task = pool.start({
        worker: agent.id,
        localSid: session.id,
        signal: controller.signal,
        execute: (item) => {
          called++;
          assert.equal(item.rid, reservation.rid);
          return "done";
        },
      });
      const until = Date.now() + 3000;
      while (local.stats().messages.done !== 1 && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await task;
      assert.equal(called, 1);
      assert.deepEqual(listCapacity(local), []);
    } finally {
      controller.abort();
      await pool.close();
      local.close();
    }
  });
});

test("empty addressed claim replay clears its retained reservation", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "east" });
    const local = open({ root });
    const agent = local.register("worker");
    const session = local.join(agent.id);
    const reservation = {
      worker: agent.id,
      localSid: session.id,
      remoteSid: null,
      board: null,
      rid: "empty-direct",
      authority: local.authority,
      maxJobs: 1,
    };
    reserveCapacity(local, reservation);
    assert.equal(
      dispatchLocalPool(local, {
        rid: reservation.rid,
        op: "claim",
        args: { sid: session.id, options: { kind: "work" } },
      }).result,
      null,
    );
    const pool = createPool(options(local));
    const controller = new AbortController();
    try {
      const task = pool.start({
        worker: agent.id,
        localSid: session.id,
        signal: controller.signal,
        execute: async () => "done",
      });
      const until = Date.now() + 1000;
      while (listCapacity(local).length && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await task;
      assert.deepEqual(listCapacity(local), []);
    } finally {
      controller.abort();
      await pool.close();
      local.close();
    }
  });
});

test("cancellation during addressed work releases capacity and never calls back again", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "east" });
    const local = open({ root });
    const agent = local.register("worker");
    const session = local.join(agent.id);
    local.send(session.id, agent.id, { work: { task: "cancel" } });
    const pool = createPool(options(local));
    const controller = new AbortController();
    let called = 0;
    try {
      const task = pool.start({
        worker: agent.id,
        localSid: session.id,
        signal: controller.signal,
        execute: async (_item, signal) => {
          called++;
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          throw new Error("cancelled callback");
        },
      });
      const until = Date.now() + 2000;
      while (!called && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await task;
      assert.equal(called, 1);
      assert.deepEqual(listCapacity(local), []);
      assert.equal(local.stats().messages.pending, 1);
    } finally {
      controller.abort();
      await pool.close();
      local.close();
    }
  });
});
