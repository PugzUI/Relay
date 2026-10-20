import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { open, setup } from "../src/index.mjs";

const parent = await mkdtemp(resolve(tmpdir(), "relay-boards-"));
const root = resolve(parent, "boards");
let relay;
let sid;
let failure;
try {
  const device = setup({ root, device: "demo-boards" });
  relay = open({ root });
  const worker = relay.register("worker", { caps: ["inspect"] });
  sid = relay.join(worker.id).id;
  const board = `host:${device.id}`;
  const inboxReceipt = relay.post(sid, board, { msg: "ready for a bounded inspection" });
  const workReceipt = relay.post(
    sid,
    board,
    { work: { task: "inspect", workspace: "demo" } },
    { needs: ["inspect"], series: "demo-sequence" },
  );
  const inbox = relay.list({ board, kind: "msg" });
  const bounties = relay.list({ board, kind: "work" });
  const lease = relay.claim(sid, { board });
  if (!lease) throw new Error("expected the demo board job to be claimable");
  const receipt = relay.ack(sid, lease.id, "done");
  const snapshot = relay.snapshot();
  const audit = relay.audit();
  process.stdout.write(
    `${JSON.stringify({ inboxReceipt, workReceipt, inbox, bounties, lease: { id: lease.id, mid: lease.mid }, receipt: { mid: receipt.mid, lease: receipt.lease, epoch: receipt.epoch, outcome: receipt.outcome, time: receipt.time }, snapshot, audit: { total: audit.total, visible: audit.visible, items: audit.items.map(({ seq, time, type, worker, mid, lease: attempt, code }) => ({ seq, time, type, worker, mid, lease: attempt, code })) } }, null, 2)}\n`,
  );
} catch (error) {
  failure = error;
}

const cleanup = [];
if (relay && sid) {
  try {
    relay.leave(sid);
  } catch (error) {
    if (!new Set(["session", "expired"]).has(error.code)) cleanup.push(error);
  }
}
try {
  relay?.close();
} catch (error) {
  cleanup.push(error);
}
if (!resolve(root).startsWith(resolve(parent) + sep)) {
  cleanup.push(new Error("refusing to remove an unowned temporary root"));
} else {
  try {
    await rm(parent, { recursive: true, force: true });
  } catch (error) {
    cleanup.push(error);
  }
}
if (failure) {
  if (cleanup.length) {
    process.stderr.write(
      `cleanup after primary failure: ${cleanup.map((error) => error.message).join("; ")}\n`,
    );
  }
  throw failure;
}
if (cleanup.length) throw new AggregateError(cleanup, "example cleanup failed");
