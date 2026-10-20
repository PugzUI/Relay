import assert from "node:assert/strict";
import readline from "node:readline";
import { open } from "../../../src/index.mjs";

const expected = (value, keys) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let relay;
let identity;

try {
  const first = await new Promise((resolve, reject) => {
    input.once("line", resolve);
    input.once("close", () =>
      reject(new Error("parent closed the launch protocol before readiness")),
    );
  });
  const bootstrap = JSON.parse(first);
  expected(bootstrap, [
    "v",
    "event",
    "id",
    "nonce",
    "device",
    "runtime",
    "capabilities",
    "storeRoot",
  ]);
  assert.equal(bootstrap.v, 1);
  assert.equal(bootstrap.event, "bootstrap");
  assert.ok(typeof bootstrap.id === "string" && bootstrap.id.length > 0);
  assert.ok(typeof bootstrap.nonce === "string" && bootstrap.nonce.length >= 16);
  assert.equal(typeof bootstrap.storeRoot, "string");

  relay = open({ root: bootstrap.storeRoot });
  assert.equal(relay.device.id, bootstrap.device.id);
  assert.equal(relay.device.name, bootstrap.device.name);
  const agent = relay.register(bootstrap.runtime, { caps: bootstrap.capabilities });
  const session = relay.join(agent.id);
  identity = { worker: agent.id, sid: session.id, epoch: session.epoch };
  process.stdout.write(
    `${JSON.stringify({
      v: 1,
      event: "ready",
      id: bootstrap.id,
      nonce: bootstrap.nonce,
      worker: agent.id,
      sid: session.id,
      epoch: session.epoch,
      caps: agent.caps,
    })}\n`,
  );

  for await (const line of input) {
    const frame = JSON.parse(line);
    expected(frame, ["v", "event", "id", "nonce", "authority", "board", "lease"]);
    assert.equal(frame.v, 1);
    assert.equal(frame.event, "execute");
    assert.equal(frame.id, bootstrap.id);
    assert.equal(frame.nonce, bootstrap.nonce);
    assert.ok(typeof frame.authority === "string" && frame.authority.length > 0);
    assert.ok(frame.board === null || typeof frame.board === "string");
    expected(frame.lease, ["id", "mid", "sid", "epoch", "until", "attempt", "kind", "work"]);
    assert.equal(frame.lease.sid, identity.sid);
    assert.equal(frame.lease.kind, "work");
    process.stdout.write(
      `${JSON.stringify({
        v: 1,
        event: "result",
        id: bootstrap.id,
        nonce: bootstrap.nonce,
        lease: frame.lease.id,
        outcome: "done",
      })}\n`,
    );
  }
} finally {
  input.close();
  relay?.close();
}
