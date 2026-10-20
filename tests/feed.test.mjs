import test from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/relay.mjs";
import { createFeed } from "../src/feed.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

test("A43/A44 snapshot cursor and committed audit feed observe another handle", async (t) => {
  const root = temporaryRoot(t);
  const relay = open({ root, device: "feed" });
  t.after(() => relay.close());
  const feed = createFeed(relay);
  t.after(() => feed.close());
  const snapshot = feed.snapshot();
  const writer = open({ root });
  t.after(() => writer.close());
  const worker = writer.register("worker");
  const session = writer.join(worker.id);
  writer.post(session.id, `host:${writer.device.id}`, { msg: "body is not in audit" });
  const controller = new AbortController();
  const iterator = feed
    .subscribe({
      cursor: snapshot.cursor,
      authorization: { scopeKey: "local" },
      signal: controller.signal,
    })
    [Symbol.asyncIterator]();
  const frame = await Promise.race([
    iterator.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("feed timeout")), 2000)),
  ]);
  assert.equal(frame.value.event, "delta");
  assert.equal(frame.value.data.type, "post");
  assert.equal(JSON.stringify(frame.value).includes("body is not in audit"), false);
  controller.abort();
  await iterator.return();
});

test("A42/A44 topology links use stable live assignment IDs and reject a changed watermark", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "topology", claimMs: 1000 });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const board = `host:${relay.device.id}`;
  relay.register("idle");
  relay.post(session.id, board, { work: { task: 1 } });
  relay.post(session.id, board, { work: { task: 2 } });
  const lease = relay.claim(session.id, { board });
  const first = relay.snapshot({ limit: 1 });
  assert.equal(first.complete, false);
  assert.deepEqual(
    first.links.map((link) => link.id),
    [`assignment:${lease.mid}`],
  );
  assert.equal(first.links[0].from, board);
  assert.equal(first.links[0].to, worker.id);
  relay.register("another");
  assert.throws(() => relay.snapshot({ limit: 1, after: first.next }), { code: "reset" });
});
