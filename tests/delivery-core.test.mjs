import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { open } from "../src/index.mjs";
import { bindDeliverySession, claimDeliveryOwner, deliveryStatus, dispatchRpc, openForBroker, reconcileDeliveryAttempt, releaseDeliveryOwner, reserveDeliveryAttempt, transitionDeliveryAttempt } from "../src/relay.mjs";
import { migrateDatabase } from "../src/sqlite.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

function rows(db, table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

test("pending is a payload-free, exact-recipient read and reports expiry without mutating leases", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "pending" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const message = relay.send(session.id, worker.id, { msg: "private message body" });
  relay.send(session.id, worker.id, { work: { secret: "private work body" } });
  const board = `host:${relay.device.id}`;
  relay.post(session.id, board, { msg: "board history" });
  relay.post(session.id, board, { work: { queued: true } });
  const initial = relay.pending(session.id);
  assert.deepEqual(Object.keys(initial), ["v", "authority", "worker", "epoch", "revision", "pending", "recoverable"]);
  assert.equal(initial.v, 1);
  assert.equal(initial.worker, worker.id);
  assert.equal(initial.epoch, session.epoch);
  assert.match(initial.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual(initial.pending, { msg: 1, work: 1 });
  assert.deepEqual(initial.recoverable, { msg: 0, work: 0 });
  assert.equal(JSON.stringify(initial).includes("private"), false);
  assert.equal(JSON.stringify(initial).includes(message.id), false);

  const before = Object.fromEntries(["messages", "leases", "receipts", "audit", "rpc", "meta", "sessions"].map((name) => [name, rows(relay._store.db, name)]));
  assert.deepEqual(relay.pending(session.id), initial);
  const after = Object.fromEntries(Object.keys(before).map((name) => [name, rows(relay._store.db, name)]));
  assert.deepEqual(after, before);

  const lease = relay.claim(session.id, { kind: "msg" });
  const claimed = relay.pending(session.id);
  assert.deepEqual(claimed.pending, { msg: 0, work: 1 });
  assert.deepEqual(claimed.recoverable, { msg: 0, work: 0 });
  assert.notEqual(claimed.revision, initial.revision);
  const realNow = Date.now;
  try {
    Date.now = () => lease.until;
    const expired = relay.pending(session.id);
    assert.deepEqual(expired.pending, { msg: 0, work: 1 });
    assert.deepEqual(expired.recoverable, { msg: 1, work: 0 });
    assert.notEqual(expired.revision, claimed.revision);
    assert.equal(relay._store.db.prepare("SELECT state FROM messages WHERE id=?").get(message.id).state, "claimed");
    assert.equal(relay._store.db.prepare("SELECT state FROM leases WHERE id=?").get(lease.id).state, "live");
    const retried = relay.claim(session.id, { kind: "msg" });
    assert.equal(retried.mid, message.id);
    assert.equal(retried.attempt, lease.attempt + 1);
    assert.notEqual(relay.pending(session.id).revision, expired.revision);
  } finally { Date.now = realNow; }
});

test("explicit schema migration backs up and preserves v2 state, and rollback is explicit", async (t) => {
  const root = temporaryRoot(t);
  const relay = open({ root, device: "migrate" });
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  relay.send(session.id, worker.id, { msg: "preserve me" });
  const completed = relay.send(session.id, worker.id, { work: { preserve: "receipt" } });
  const lease = relay.claim(session.id, { kind: "work" });
  assert.equal(lease.mid, completed.id);
  relay.ack(session.id, lease.id, "done");
  dispatchRpc(relay, {
    authorization: { operation: "send", principal: { id: "migration-principal", grant: { workers: [worker.id], recipients: [worker.id] } }, scopeKey: "migration-scope" },
    rid: "migration-rpc-1", op: "send", args: { sid: session.id, to: worker.id, envelope: { msg: "rpc history" } }, beforeCommit() {},
  });
  const init = relay.device.init;
  const summary = relay.pending(session.id);
  const preserved = Object.fromEntries(["devices", "agents", "sessions", "messages", "leases", "receipts", "audit", "rpc"].map((table) => [table, rows(relay._store.db, table)]));
  relay.close();

  const legacy = new DatabaseSync(join(root, "relay.sqlite"));
  legacy.exec("DROP TABLE delivery_attempt_scopes; DROP TABLE delivery_attempts; DROP TABLE delivery_bindings; DROP TABLE delivery_targets; DROP TABLE delivery_owners; UPDATE meta SET value='2' WHERE key='schema'; PRAGMA user_version=2;");
  legacy.close();

  const backup2 = join(root, "before-v3.sqlite");
  assert.deepEqual(await migrateDatabase({ root, to: 3, backup: backup2 }), { from: 2, to: 3, backup: backup2 });
  assert.equal(existsSync(backup2), true);
  const upgraded = open({ root, readOnly: true });
  assert.equal(upgraded.device.init, init);
  assert.deepEqual(upgraded.pending(session.id), summary);
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((table) => [table, rows(upgraded._store.db, table)])), preserved);
  upgraded.close();
  const oldBackup = new DatabaseSync(backup2, { readOnly: true });
  assert.equal(oldBackup.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(Number(oldBackup.prepare("SELECT COUNT(*) AS n FROM messages").get().n), 3);
  assert.equal(Number(oldBackup.prepare("SELECT COUNT(*) AS n FROM receipts").get().n), 1);
  assert.equal(Number(oldBackup.prepare("SELECT COUNT(*) AS n FROM rpc").get().n), 1);
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((table) => [table, rows(oldBackup, table)])), preserved);
  oldBackup.close();

  await assert.rejects(migrateDatabase({ root, to: 2, backup: join(root, "bad-rollback.sqlite"), deliveryEnabled: true }), { code: "input" });
  const deliveryOwner = openForBroker({ root, role: "host", ownerToken: "D".repeat(32) });
  const ownerGeneration = claimDeliveryOwner(deliveryOwner).generation;
  bindDeliverySession(deliveryOwner, {
    authority: deliveryOwner.authority, worker: worker.id, sid: session.id, epoch: session.epoch,
    target: { runtimeInstance: "migration-runtime", profile: "default", nativeSession: "migration-session", lifecycleGeneration: "lifecycle-1" },
    capabilities: { context: true, idle: false, launch: false }, ownerGeneration,
  });
  await assert.rejects(migrateDatabase({ root, to: 2, backup: join(root, "active-owner.sqlite"), deliveryEnabled: false }), { code: "active" });
  releaseDeliveryOwner(deliveryOwner, ownerGeneration);
  deliveryOwner.close();
  const backup3 = join(root, "before-v2.sqlite");
  assert.deepEqual(await migrateDatabase({ root, to: 2, backup: backup3, deliveryEnabled: false }), { from: 3, to: 2, backup: backup3 });
  const downgraded = open({ root, readOnly: true });
  assert.equal(downgraded.device.init, init);
  assert.deepEqual(downgraded.pending(session.id), summary);
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((table) => [table, rows(downgraded._store.db, table)])), preserved);
  downgraded.close();
  const v3Backup = new DatabaseSync(backup3, { readOnly: true });
  assert.equal(v3Backup.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(Number(v3Backup.prepare("SELECT COUNT(*) AS n FROM delivery_owners").get().n), 1);
  assert.equal(Number(v3Backup.prepare("SELECT COUNT(*) AS n FROM delivery_bindings WHERE state='stale'").get().n), 1);
  assert.deepEqual(Object.fromEntries(Object.keys(preserved).map((table) => [table, rows(v3Backup, table)])), preserved);
  v3Backup.close();
});

test("migration refuses to overwrite even a symlink backup target", async (t) => {
  const root = temporaryRoot(t);
  const relay = open({ root, device: "backup" });
  relay.close();
  const destination = join(root, "existing.sqlite");
  const target = join(root, "relay.sqlite");
  symlinkSync(target, destination);
  await assert.rejects(migrateDatabase({ root, to: 2, backup: destination, deliveryEnabled: false }), { code: "active" });
  assert.equal(existsSync(destination), true);
  const untouched = new DatabaseSync(target, { readOnly: true });
  try { assert.equal(untouched.prepare("PRAGMA user_version").get().user_version, 3); }
  finally { untouched.close(); }
});

test("same-store owner fences native attempts and retains target exclusion until reconciliation", (t) => {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "relay-delivery-home-"));
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const root = temporaryRoot(t);
  const initialized = open({ root, device: "delivery" });
  initialized.close();
  const relay = openForBroker({ root, role: "host", ownerToken: "A".repeat(32) });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const ownerGeneration = claimDeliveryOwner(relay).generation;
  const target = { runtimeInstance: "test-runtime", profile: "default", nativeSession: "session-1", lifecycleGeneration: "life-1" };
  const binding = bindDeliverySession(relay, {
    authority: relay.authority, worker: worker.id, sid: session.id, epoch: session.epoch,
    target, capabilities: { context: true, idle: false, launch: false }, ownerGeneration,
  });
  const remoteBinding = bindDeliverySession(relay, {
    authority: "remote-authority", worker: "remote:worker:001", sid: "remote-session-1", epoch: 4,
    target, capabilities: { context: false, idle: true, launch: false }, ownerGeneration,
  });
  const bindings = [
    { binding: binding.id, generation: binding.generation },
    { binding: remoteBinding.id, generation: remoteBinding.generation },
  ];
  const remoteSummary = { ...relay.pending(session.id), authority: "remote-authority", worker: "remote:worker:001", epoch: 4, revision: "a".repeat(64) };
  const attempt = reserveDeliveryAttempt(relay, { id: "attempt-1", ownerGeneration, bindings: [
    { ...bindings[0], summary: relay.pending(session.id) },
    { ...bindings[1], summary: remoteSummary },
  ] });
  assert.equal(attempt.state, "reserved");
  assert.equal(deliveryStatus(relay).targets.locked, 1);
  assert.deepEqual(relay._store.db.prepare("SELECT authority,worker,sid,epoch FROM delivery_attempt_scopes WHERE attempt=? ORDER BY authority").all(attempt.id).map((row) => ({ ...row })), [
    { authority: relay.authority, worker: worker.id, sid: session.id, epoch: session.epoch },
    { authority: "remote-authority", worker: "remote:worker:001", sid: "remote-session-1", epoch: 4 },
  ]);

  const otherRoot = temporaryRoot(t);
  const otherStore = open({ root: otherRoot, device: "other" });
  otherStore.close();
  const competing = openForBroker({ root: otherRoot, role: "host", ownerToken: "C".repeat(32) });
  try {
    const otherWorker = competing.register("worker");
    const otherSession = competing.join(otherWorker.id);
    const otherGeneration = claimDeliveryOwner(competing).generation;
    const otherBinding = bindDeliverySession(competing, {
      authority: competing.authority, worker: otherWorker.id, sid: otherSession.id, epoch: otherSession.epoch,
      target, capabilities: { context: true, idle: false, launch: false }, ownerGeneration: otherGeneration,
    });
    assert.throws(() => reserveDeliveryAttempt(competing, {
      id: "attempt-competing", ownerGeneration: otherGeneration,
      bindings: [{ binding: otherBinding.id, generation: otherBinding.generation, summary: competing.pending(otherSession.id) }],
    }), { code: "active" });
    assert.equal(competing._store.db.prepare("SELECT reason_code FROM delivery_attempts WHERE id='attempt-competing'").get().reason_code, "target-owned");
    assert.equal(deliveryStatus(relay).targets.locked, 1);
  } finally { competing.close(); }

  const update = (from, to, fields = {}) => transitionDeliveryAttempt(relay, { id: attempt.id, ownerGeneration, bindings, from, to, ...fields });
  update("reserved", "submitting", { nativeRequestId: "native-1" });
  update("submitting", "admitted");
  update("admitted", "context_observed");
  update("context_observed", "turn_started");
  assert.equal(deliveryStatus(relay).targets.locked, 1);
  assert.throws(() => releaseDeliveryOwner(relay, ownerGeneration) && update("turn_started", "safe_idle"), { code: "owner" });
  relay.close();

  const recovered = openForBroker({ root, role: "host", ownerToken: "B".repeat(32), reconciliation: true });
  t.after(() => recovered.close());
  const nextGeneration = claimDeliveryOwner(recovered).generation;
  assert.equal(nextGeneration, ownerGeneration + 1);
  assert.equal(deliveryStatus(recovered).targets.locked, 1);
  const nextBinding = bindDeliverySession(recovered, {
    authority: recovered.authority, worker: worker.id, sid: session.id, epoch: session.epoch,
    target, capabilities: { context: true, idle: false, launch: false }, ownerGeneration: nextGeneration,
  });
  assert.throws(() => reserveDeliveryAttempt(recovered, {
    id: "attempt-2", ownerGeneration: nextGeneration,
    bindings: [{ binding: nextBinding.id, generation: nextBinding.generation, summary: recovered.pending(session.id) }],
  }), { code: "active" });

  assert.deepEqual(reconcileDeliveryAttempt(recovered, {
    confirm: true, id: attempt.id, outcome: "observed", ownerGeneration: nextGeneration, reasonCode: "operator-confirmed",
  }), { id: attempt.id, state: "reconciled", outcome: "observed" });
  assert.equal(deliveryStatus(recovered).targets.locked, 0);
  assert.equal(recovered._store.db.prepare("SELECT native_request_id FROM delivery_attempts WHERE id=?").get(attempt.id).native_request_id, "native-1");
});

test("native target gate remains stable across authority and lifecycle rotation", (t) => {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "relay-delivery-rotation-home-"));
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const root = temporaryRoot(t);
  const initialized = open({ root, device: "rotation" });
  initialized.close();
  const relay = openForBroker({ root, role: "host", ownerToken: "R".repeat(32) });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const ownerGeneration = claimDeliveryOwner(relay).generation;
  const target = { runtimeInstance: "opencode-process-1", profile: "default", nativeSession: "native-session-1", lifecycleGeneration: "life-1" };
  const binding = bindDeliverySession(relay, {
    authority: relay.authority, worker: worker.id, sid: session.id, epoch: session.epoch,
    target, capabilities: { context: true, idle: true, launch: false }, ownerGeneration,
  });
  const hubBinding = bindDeliverySession(relay, {
    authority: "hub-authority", worker: "remote:worker:prime", sid: "remote-session", epoch: 7,
    target, capabilities: { context: true, idle: true, launch: false }, ownerGeneration,
  });
  assert.equal(binding.targetDigest, hubBinding.targetDigest);

  const attempt = reserveDeliveryAttempt(relay, {
    id: "rotation-attempt-1", ownerGeneration,
    bindings: [
      { binding: binding.id, generation: binding.generation, summary: relay.pending(session.id) },
      { binding: hubBinding.id, generation: hubBinding.generation, summary: { ...relay.pending(session.id), authority: "hub-authority", worker: "remote:worker:prime", epoch: 7 } },
    ],
  });
  const scopes = [
    { binding: binding.id, generation: binding.generation },
    { binding: hubBinding.id, generation: hubBinding.generation },
  ];
  transitionDeliveryAttempt(relay, { id: attempt.id, ownerGeneration, bindings: scopes, from: "reserved", to: "submitting" });

  const rotated = bindDeliverySession(relay, {
    authority: relay.authority, worker: worker.id, sid: session.id, epoch: session.epoch,
    target: { ...target, runtimeInstance: "opencode-process-2", lifecycleGeneration: "life-2" },
    capabilities: { context: true, idle: true, launch: false }, ownerGeneration,
  });
  assert.equal(rotated.id, binding.id);
  assert.equal(rotated.targetDigest, binding.targetDigest);
  assert.equal(rotated.generation, binding.generation + 1);
  assert.equal(relay._store.db.prepare("SELECT lifecycle_generation FROM delivery_bindings WHERE id=?").get(rotated.id).lifecycle_generation, "life-2");
  const rotatedHub = bindDeliverySession(relay, {
    authority: "hub-authority", worker: "remote:worker:prime", sid: "remote-session", epoch: 7,
    target: { ...target, runtimeInstance: "opencode-process-2", lifecycleGeneration: "life-2" },
    capabilities: { context: true, idle: true, launch: false }, ownerGeneration,
  });
  assert.equal(rotatedHub.id, hubBinding.id);
  assert.equal(rotatedHub.targetDigest, rotated.targetDigest);
  assert.equal(rotatedHub.generation, hubBinding.generation + 1);
  assert.throws(() => reserveDeliveryAttempt(relay, {
    id: "rotation-attempt-2", ownerGeneration,
    bindings: [{ binding: rotated.id, generation: rotated.generation, summary: relay.pending(session.id) }],
  }), { code: "active" });

  const otherScope = bindDeliverySession(relay, {
    authority: "other-authority", worker: "other:worker:prime", sid: "other-session", epoch: 1,
    target: { ...target, runtimeInstance: "opencode-process-2", lifecycleGeneration: "life-2" },
    capabilities: { context: true, idle: false, launch: false }, ownerGeneration,
  });
  assert.equal(otherScope.targetDigest, rotated.targetDigest);
  assert.equal(deliveryStatus(relay).targets.total, 1);
  assert.equal(deliveryStatus(relay).targets.locked, 1);
});
