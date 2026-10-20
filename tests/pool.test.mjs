import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  open,
  setup,
  dispatchLocalPool,
  reserveCapacity,
  bindCapacity,
  listCapacity,
  reserveLaunch,
  updateLaunch,
  listLaunches,
} from "../src/relay.mjs";
import { createPool } from "../src/pool.mjs";
import { Fault } from "../src/fault.mjs";
import { withTempDir } from "./network-helpers.mjs";

test("Pool reservations bound board work and settlement releases capacity", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "east" });
    const local = open({ root });
    const agent = local.register("worker");
    const session = local.join(agent.id);
    const board = `host:${local.device.id}`;
    local.post(session.id, board, { work: { task: "one" } });
    local.post(session.id, board, { work: { task: "two" } });
    const pool = createPool({
      local,
      hub: null,
      maxAgents: 1,
      maxJobs: 1,
      pollMs: 100,
      minBackoffMs: 100,
      maxBackoffMs: 1000,
      launch: null,
    });
    try {
      const input = { worker: agent.id, localSid: session.id };
      const first = await pool.claim(input);
      assert.equal(first?.state, "claimed");
      assert.equal(first?.kind, "work");
      assert.equal(await pool.claim(input), null);
      const settled = await pool.settle({ worker: agent.id, item: first, outcome: "done" });
      assert.equal(settled.state, "settled");
      assert.equal(settled.receipt.outcome, "done");
      const second = await pool.claim(input);
      assert.equal(second?.state, "claimed");
      assert.notEqual(second?.lease.id, first.lease.id);
    } finally {
      await pool.close();
      local.close();
    }
  });
});

test("Pool dispatches a recovered accepted reservation exactly once", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "east" });
    const local = open({ root });
    const agent = local.register("worker");
    const session = local.join(agent.id);
    const board = `host:${local.device.id}`;
    local.post(session.id, board, { work: { task: "recovered" } });
    const reservation = {
      worker: agent.id,
      localSid: session.id,
      remoteSid: null,
      board,
      rid: "recovered-claim",
      authority: local.authority,
      maxJobs: 1,
    };
    reserveCapacity(local, reservation);
    const lease = dispatchLocalPool(local, {
      rid: reservation.rid,
      op: "claim",
      args: { sid: session.id, options: { board } },
    }).result;
    bindCapacity(local, {
      worker: agent.id,
      rid: reservation.rid,
      authority: local.authority,
      lease,
    });
    const pool = createPool({
      local,
      hub: null,
      maxAgents: 1,
      maxJobs: 1,
      pollMs: 100,
      minBackoffMs: 100,
      maxBackoffMs: 1000,
      launch: null,
    });
    const controller = new AbortController();
    let executed = 0;
    try {
      const task = pool.start({
        worker: agent.id,
        localSid: session.id,
        signal: controller.signal,
        execute: (item) => {
          executed++;
          assert.equal(item.rid, reservation.rid);
          assert.equal(item.lease.id, lease.id);
          return "done";
        },
      });
      const until = Date.now() + 3000;
      while (local.stats().messages.done !== 1 && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await task;
      assert.equal(local.stats().messages.done, 1);
      assert.equal(executed, 1);
      assert.deepEqual(listCapacity(local), []);
    } finally {
      controller.abort();
      await pool.close();
      local.close();
    }
  });
});

test("needs mismatch remains pending and a denied launch recipe reserves no child", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "east" });
    const local = open({ root });
    const agent = local.register("worker");
    const session = local.join(agent.id);
    const prime = local.register("worker", { slot: "prime" });
    const primeSession = local.join(prime.id);
    local.post(
      session.id,
      `host:${local.device.id}`,
      { work: { task: "needs-gpu" } },
      { needs: ["gpu"] },
    );
    const pool = createPool({
      local,
      hub: null,
      maxAgents: 2,
      maxJobs: 1,
      pollMs: 100,
      minBackoffMs: 100,
      maxBackoffMs: 1000,
      launch: {
        runtime: "worker",
        executable: `${root}/missing-runtime`,
        args: [],
        cwd: root,
        capabilities: [],
        maxChildren: 1,
        readyTimeoutMs: 1000,
      },
    });
    try {
      assert.equal(await pool.claim({ worker: agent.id, localSid: session.id }), null);
      assert.equal(local.stats().messages.pending, 1);
      await assert.rejects(
        pool.ensureCapacity({ primeSid: primeSession.id, demand: 1, readySpare: 0 }),
        (error) => error instanceof Fault && error.code === "denied",
      );
      assert.deepEqual(listLaunches(local, { activeOnly: true }), []);
      assert.equal(local.stats().messages.pending, 1);
    } finally {
      await pool.close();
      local.close();
    }
  });
});

test("full launch budget blocks another spawn", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "east" });
    const local = open({ root });
    const prime = local.register("worker", { slot: "prime" });
    const primeSession = local.join(prime.id);
    reserveLaunch(local, {
      primeSid: primeSession.id,
      runtime: "worker",
      requestId: "budget-full",
      recipeHash: "b".repeat(64),
      capabilities: [],
      demand: 1,
      readySpare: 0,
      maxChildren: 1,
    });
    const pool = createPool({
      local,
      hub: null,
      maxAgents: 2,
      maxJobs: 1,
      pollMs: 100,
      minBackoffMs: 100,
      maxBackoffMs: 1000,
      launch: {
        runtime: "worker",
        executable: process.execPath,
        args: [],
        cwd: root,
        capabilities: [],
        maxChildren: 1,
        readyTimeoutMs: 1000,
      },
    });
    try {
      assert.equal(
        await pool.ensureCapacity({ primeSid: primeSession.id, demand: 1, readySpare: 0 }),
        null,
      );
      assert.equal(listLaunches(local, { activeOnly: true }).length, 1);
    } finally {
      await pool.close();
      local.close();
    }
  });
});

test("native launch keeps stdin open for bootstrap and exact lease execution", async (t) => {
  if (process.platform !== "linux") return t.skip("native process identity is Linux-only");
  await withTempDir(async (root) => {
    setup({ root, device: "east" });
    const local = open({ root });
    const prime = local.register("worker", { slot: "prime" });
    const session = local.join(prime.id);
    local.post(session.id, `host:${local.device.id}`, { work: { task: "harmless" } });
    const moduleUrl = JSON.stringify(new URL("../src/relay.mjs", import.meta.url).href);
    const childCode = `import { createInterface } from "node:readline"; const { open } = await import(${moduleUrl}); const input=createInterface({input:process.stdin}); let relay, ready=false; input.on("line",line=>{const frame=JSON.parse(line); if(!ready){if(frame.event!=="bootstrap")process.exit(2); relay=open({root:frame.storeRoot}); const worker=relay.register(frame.runtime,{caps:frame.capabilities}); const session=relay.join(worker.id); ready=true; process.stdout.write(JSON.stringify({v:1,event:"ready",id:frame.id,nonce:frame.nonce,worker:worker.id,sid:session.id,epoch:session.epoch,caps:worker.caps})+"\\n"); return;} if(frame.event!=="execute"||frame.authority!==relay.authority||frame.lease.sid===undefined)process.exit(3); relay.ack(frame.lease.sid,frame.lease.id,"done"); process.stdout.write(JSON.stringify({v:1,event:"result",id:frame.id,nonce:frame.nonce,lease:frame.lease.id,outcome:"done"})+"\\n");});`;
    const pool = createPool({
      local,
      hub: null,
      maxAgents: 2,
      maxJobs: 1,
      pollMs: 100,
      minBackoffMs: 100,
      maxBackoffMs: 1000,
      launch: {
        runtime: "worker",
        executable: process.execPath,
        args: ["--input-type=module", "-e", childCode],
        cwd: root,
        capabilities: [],
        maxChildren: 1,
        readyTimeoutMs: 3000,
      },
    });
    try {
      const launch = await pool.ensureCapacity({ primeSid: session.id, demand: 1, readySpare: 0 });
      assert.equal(launch.state, "running");
      assert.match(launch.worker, /^east:worker:\d{3,32}$/);
      const controller = new AbortController();
      const task = pool.start({
        worker: launch.worker,
        localSid: launch.sid,
        signal: controller.signal,
        execute: async () => "failed",
      });
      const until = Date.now() + 5000;
      while (local.stats().messages.done !== 1 && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await task;
      assert.equal(local.stats().messages.done, 1);
    } finally {
      await pool.close();
      local.close();
    }
  });
});

test("launch reconciliation retains budget when the PID exists without its nonce", async (t) => {
  if (process.platform !== "linux") return t.skip("native process identity is Linux-only");
  await withTempDir(async (root) => {
    setup({ root, device: "east" });
    const local = open({ root });
    const prime = local.register("worker", { slot: "prime" });
    const primeSession = local.join(prime.id);
    const launch = reserveLaunch(local, {
      primeSid: primeSession.id,
      runtime: "worker",
      requestId: "ambiguous-launch",
      recipeHash: "a".repeat(64),
      capabilities: [],
      demand: 1,
      readySpare: 0,
      maxChildren: 1,
    });
    const worker = local.register("worker");
    const session = local.join(worker.id);
    const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const handle = {
      platform: "linux",
      pid: process.pid,
      processStart: `${boot}:${fields[19]}`,
      nonce: "not-the-live-process-nonce",
    };
    updateLaunch(local, {
      id: launch.id,
      from: "starting",
      to: "running",
      handle,
      ready: {
        worker: worker.id,
        sid: session.id,
        epoch: session.epoch,
        nonce: handle.nonce,
        caps: [],
      },
    });
    const pool = createPool({
      local,
      hub: null,
      maxAgents: 2,
      maxJobs: 1,
      pollMs: 100,
      minBackoffMs: 100,
      maxBackoffMs: 1000,
      launch: null,
    });
    try {
      assert.equal(
        await pool.ensureCapacity({ primeSid: primeSession.id, demand: 1, readySpare: 0 }),
        null,
      );
      assert.equal(
        listLaunches(local, { activeOnly: true }).find((row) => row.id === launch.id).state,
        "unknown",
      );
    } finally {
      await pool.close();
      local.close();
    }
  });
});
