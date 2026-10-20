import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { open, setup } from "../src/index.mjs";

const parent = await mkdtemp(resolve(tmpdir(), "relay-basic-"));
const root = resolve(parent, "relay data with spaces");
let relay;
let sid;
let failure;
try {
  const device = setup({ root, device: "demo-local" });
  relay = open({ root });
  const agent = relay.register("worker", { caps: ["inspect"] });
  const session = relay.join(agent.id);
  sid = session.id;
  const board = `host:${device.id}`;
  const inbox = relay.post(sid, board, { msg: "demo worker ready" });
  const job = relay.post(
    sid,
    board,
    { work: { task: "inspect", workspace: "demo" } },
    { needs: ["inspect"] },
  );
  const inboxPage = relay.list({ board, kind: "msg" });
  const workPage = relay.list({ board, kind: "work" });
  const lease = relay.claim(sid, { board });
  if (!lease) throw new Error("expected the posted demo job to be claimable");
  const receipt = relay.ack(sid, lease.id, "done");
  process.stdout.write(
    `${JSON.stringify({ device, worker: agent.id, inbox, job, inboxPage, workPage, lease: { id: lease.id, mid: lease.mid }, receipt: { mid: receipt.mid, lease: receipt.lease, epoch: receipt.epoch, outcome: receipt.outcome, time: receipt.time } }, null, 2)}\n`,
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
const base = resolve(parent) + sep;
if (!resolve(root).startsWith(base)) {
  cleanup.push(new Error("refusing to remove a root outside the owned temporary directory"));
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
