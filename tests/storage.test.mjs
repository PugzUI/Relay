import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, statSync } from "node:fs";
import { open, openForBroker, setup } from "../src/relay.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

test("A53 setup role is immutable and missing read-only open creates no files", (t) => {
  const root = temporaryRoot(t);
  const empty = temporaryRoot(t);
  mkdirSync(empty);
  assert.throws(() => open({ root: empty, readOnly: true }), { code: "missing" });
  assert.equal(existsSync(`${empty}/relay.sqlite`), false);
  assert.throws(() => open({ root, readOnly: true }), { code: "missing" });
  assert.equal(existsSync(root), false);
  const hub = setup({ root, device: "hub", role: "hub" });
  assert.equal(hub.name, "hub");
  const relay = open({ root });
  t.after(() => relay.close());
  assert.throws(() => setup({ root, device: "hub", role: "host" }), { code: "input" });
  assert.equal(relay.stats().boards, 2);
  const readOnly = open({ root, readOnly: true });
  t.after(() => readOnly.close());
  assert.throws(() => readOnly.register("worker"), { code: "denied" });
});

test("A13 unknown or corrupt databases are refused without reset", (t) => {
  const root = temporaryRoot(t);
  mkdirSync(root);
  writeFileSync(`${root}/relay.sqlite`, "not sqlite");
  assert.throws(() => open({ root, device: "must-not-reset" }), { code: "schema" });
});

test("A14 backward clock blocks mutation while reads remain available", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "clock" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const original = Date.now;
  const forward = original();
  try {
    Date.now = () => forward - 10000;
    assert.throws(() => relay.renew(session.id), { code: "clock" });
    assert.equal(relay.get("missing"), null);
  } finally {
    Date.now = original;
  }
});

test("A13 symlink targets and SQLite writer contention fail without changing ownership", (t) => {
  const root = temporaryRoot(t);
  const relay = open({ root, device: "locked" });
  t.after(() => relay.close());
  const other = openForBroker({ root, role: "host" });
  t.after(() => other.close());
  relay._store.db.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => other.register("worker"), { code: "busy" });
  } finally {
    relay._store.db.exec("ROLLBACK");
  }
  assert.equal(relay.stats().agents, 0);
  if (process.platform !== "win32") {
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(`${root}/relay.sqlite`).mode & 0o777, 0o600);
  }
  const alias = `${root}-alias`;
  symlinkSync(root, alias);
  assert.throws(() => open({ root: alias }), { code: "schema" });
});

test("A13 database symlinks are refused without following their destination", (t) => {
  const root = temporaryRoot(t);
  mkdirSync(root);
  const target = `${root}-target`;
  writeFileSync(target, "preserve me");
  symlinkSync(target, `${root}/relay.sqlite`);
  assert.throws(() => open({ root, device: "symlink" }), { code: "schema" });
  assert.equal(readFileSync(target, "utf8"), "preserve me");
});

test("A14 persisted policy corruption is a schema fault and message bytes count UTF-8", (t) => {
  const root = temporaryRoot(t);
  const relay = open({ root, device: "policy" });
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  relay.send(session.id, worker.id, { msg: "💩" });
  assert.equal(relay.stats().messages.bytes, Buffer.byteLength(JSON.stringify({ msg: "💩" })));
  const policy = { ...relay._store.policy, pendingBytes: 1 };
  relay._store.db.prepare("UPDATE meta SET value=? WHERE key='policy'").run(JSON.stringify(policy));
  relay.close();
  assert.throws(() => open({ root }), { code: "schema" });
});
