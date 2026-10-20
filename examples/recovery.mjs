import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { open } from "../src/index.mjs";

const parent = await mkdtemp(resolve(tmpdir(), "relay-recovery-"));
const root = resolve(parent, "interrupted run");
let relay;
let sid;
let failure;
try {
  relay = open({ root, device: "demo-recovery", sessionMs: 5_000, claimMs: 1_000 });
  const worker = relay.register("worker", { caps: ["inspect"] });
  sid = relay.join(worker.id).id;
  const board = `host:${relay.device.id}`;
  relay.post(sid, board, { work: { task: "recover", workspace: "demo" } });
  const interrupted = relay.claim(sid, { board });
  if (!interrupted) throw new Error("expected the demo job to be claimed");
  relay.close();
  relay = undefined;
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_050));
  relay = open({ root, sessionMs: 5_000, claimMs: 1_000 });
  const recovered = relay.claim(sid, { board });
  if (!recovered) throw new Error("expired work did not become claimable");
  const receipt = relay.ack(sid, recovered.id, "done");
  process.stdout.write(
    `${JSON.stringify({ interruptedAttempt: interrupted.id, recoveredAttempt: recovered.id, attempt: recovered.attempt, receipt: { mid: receipt.mid, lease: receipt.lease, epoch: receipt.epoch, outcome: receipt.outcome, time: receipt.time } }, null, 2)}\n`,
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
