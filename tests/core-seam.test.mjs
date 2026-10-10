import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { Relay, open, relayRoot } from "../src/relay.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

test("relayRoot returns the canonical open store root and rejects invalid or closed handles", (t) => {
  const root = temporaryRoot(t);
  const relay = open({ root: `${root}/.`, device: "root-seam" });
  t.after(() => relay.close());
  assert.equal(relayRoot(relay), realpathSync(root));
  assert.equal(Object.getOwnPropertyDescriptor(relay._store, "root").writable, false);
  assert.throws(() => relayRoot(null), { code: "input" });
  assert.throws(() => relayRoot(Object.create(Relay.prototype)), { code: "input" });
  assert.throws(() => relayRoot(new Relay({ root: realpathSync(root), db: {}, closed: false })), { code: "input" });
  relay.close();
  assert.throws(() => relayRoot(relay), { code: "storage" });
});

test("relayRoot stays internal to src/relay.mjs", () => {
  const entry = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(entry, /\brelayRoot\b/);
});

test("snapshot boards and list pages match their declared wire fields", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "wire-seam" }); t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const board = `host:${relay.device.id}`;
  relay.post(session.id, board, { msg: "wire fields" });

  const snapshot = relay.snapshot();
  assert.deepEqual(Object.keys(snapshot.boards[0]).sort(), [
    "authority", "claimed", "device", "id", "inbox", "kind", "pending", "receivedAt", "reported", "terminal",
  ]);

  const page = relay.list({ board, data: true });
  assert.deepEqual(Object.keys(page).sort(), ["complete", "cursor", "firstSeq", "items", "next", "pruned", "total", "visible"]);
  assert.deepEqual(Object.keys(page.items[0]).sort(), [
    "acked", "board", "data", "from", "id", "init", "kind", "needs", "seq", "series", "state", "to",
  ]);
});
