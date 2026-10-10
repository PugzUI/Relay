import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { open, setup } from "../src/index.mjs";

const parent = await mkdtemp(resolve(tmpdir(), "relay-demo-"));
const root = resolve(parent, "relay demo");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("demo time limit reached")), 15_000);
let relay;
const sessions = [];
let failure;
const signal = () => controller.abort(new Error("demo interrupted"));
process.once("SIGINT", signal);
process.once("SIGTERM", signal);

try {
  const device = setup({ root, device: "demo-local" });
  relay = open({ root });
  const workers = ["inspect", "verify"].map((cap) => relay.register("worker", { caps: [cap] }));
  for (const worker of workers) sessions.push(relay.join(worker.id).id);
  const board = `host:${device.id}`;
  const inboxAdmission = relay.post(sessions[0], board, { msg: "demo workers are ready" });
  const admissions = [
    relay.post(sessions[0], board, { work: { task: "inspect", workspace: "demo" } }, { needs: ["inspect"] }),
    relay.post(sessions[0], board, { work: { task: "verify", workspace: "demo" } }, { needs: ["verify"] }),
  ];
  const consumed = await Promise.all(sessions.map((sid) => consume(sid, board)));
  if (controller.signal.aborted) throw controller.signal.reason;
  const inbox = relay.list({ board, kind: "msg" });
  const work = relay.list({ board, kind: "work" });
  const snapshot = relay.snapshot();
  const audit = relay.audit();
  process.stdout.write(`${JSON.stringify({
    device: { id: device.id, name: device.name },
    workers: workers.map((worker) => worker.id),
    consumed,
    inboxAdmission,
    workAdmissions: admissions,
    inbox: { total: inbox.total, visible: inbox.visible, rows: inbox.items.map(({ id, seq, from, board: target, kind, state, init }) => ({ id, seq, from, board: target, kind, state, init })) },
    work: { total: work.total, visible: work.visible, rows: work.items.map(({ id, seq, from, board: target, kind, state, init, acked }) => ({ id, seq, from, board: target, kind, state, init, acked })) },
    topology: { authority: snapshot.authority, totals: snapshot.totals, visible: snapshot.visible, cursor: snapshot.cursor },
    events: audit.items.map(({ seq, time, type, worker, mid, lease, code }) => ({ seq, time, type, worker, mid, lease, code })),
  }, null, 2)}\n`);
} catch (error) {
  failure = error;
  throw error;
} finally {
  clearTimeout(timeout);
  process.removeListener("SIGINT", signal);
  process.removeListener("SIGTERM", signal);
  const cleanup = [];
  if (relay) {
    for (const sid of sessions) {
      try { relay.leave(sid); }
      catch (error) { if (!new Set(["session", "expired"]).has(error.code)) cleanup.push(error); }
    }
    try { relay.close(); } catch (error) { cleanup.push(error); }
  }
  if (!resolve(root).startsWith(resolve(parent) + sep)) cleanup.push(new Error("refusing to remove unowned demo state"));
  else try { await rm(parent, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
  if (cleanup.length) {
    const message = cleanup.map((error) => error.message).join("; ");
    if (failure) process.stderr.write(`cleanup after primary failure: ${message}\n`);
    else throw new AggregateError(cleanup, "demo cleanup failed");
  }
}

async function consume(sid, board) {
  const receipts = [];
  while (!controller.signal.aborted) {
    const lease = relay.claim(sid, { board });
    if (!lease) return receipts;
    if (controller.signal.aborted) {
      relay.release(sid, lease.id);
      throw controller.signal.reason;
    }
    const receipt = relay.ack(sid, lease.id, "done");
    receipts.push({ mid: receipt.mid, lease: receipt.lease, outcome: receipt.outcome });
  }
  throw controller.signal.reason;
}
