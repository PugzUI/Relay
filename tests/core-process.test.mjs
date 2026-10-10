import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { open } from "../src/relay.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

function runNode(fixture, env) {
  return new Promise((resolve, reject) => {
    const child = fork(fixture.pathname, [], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; let result;
    child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
    child.on("message", (value) => { result = value; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 || !result) return reject(new Error(`child failed (${code}): result=${JSON.stringify(result)} stderr=${stderr}`));
      resolve(result);
    });
  });
}

test("A02/A03/A05/A08 independent processes serialize allocation, claims, and dead-claim recovery", async (t) => {
  const root = temporaryRoot(t);
  const relay = open({ root, device: "multiproc" });
  const worker = relay.register("worker"); const session = relay.join(worker.id);
  relay.send(session.id, worker.id, { msg: "one claim" });
  const { NODE_TEST_CONTEXT, ...childEnv } = process.env;
  const env = { ...childEnv, RELAY_ROOT: root, RELAY_SID: session.id };
  const fixture = new URL("./core-process-worker.mjs", import.meta.url);
  const [left, right] = await Promise.all([runNode(fixture, env), runNode(fixture, env)]);
  assert.deepEqual(new Set([left.slot, right.slot]), new Set(["001", "002"]));
  const winners = [left, right].filter((entry) => entry.lease);
  assert.equal(winners.length, 1);
  assert.equal(relay.stats().messages.claimed, 1);
  const wall = Date.now;
  try {
    Date.now = () => winners[0].lease.until;
    const reclaimed = relay.claim(session.id);
    assert.equal(reclaimed.mid, winners[0].lease.mid);
    assert.notEqual(reclaimed.id, winners[0].lease.id);
    assert.equal(reclaimed.attempt, 2);
  } finally { Date.now = wall; }
  relay.close();
});
