import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { open, setup, connect } from "../src/index.mjs";
import { claimDeliveryOwner, deliveryStatus, listDeliveryAttempts, openForBroker } from "../src/relay.mjs";
import { createDeliverySupervisor } from "../src/delivery.mjs";
import { serve } from "../src/broker.mjs";
import { credential, emptyGrant, privateFile, withTempDir } from "./network-helpers.mjs";
import { parseArgs, main } from "../src/cli.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

function ownedRoots(t) {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "relay-delivery-home-"));
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  return { localRoot: temporaryRoot(t), hubRoot: temporaryRoot(t) };
}

function openPair(t, { localRoot, hubRoot }) {
  setup({ root: localRoot, device: "local", role: "host" });
  setup({ root: hubRoot, device: "hub", role: "hub" });
  const local = openForBroker({ root: localRoot, role: "host", ownerToken: "L".repeat(32) });
  const hub = openForBroker({ root: hubRoot, role: "hub", ownerToken: "H".repeat(32) });
  t.after(() => { local.close(); hub.close(); });
  return { local, hub };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function bindingInput(api, target, consumer, client = "hermes") {
  const worker = api.register("worker");
  const session = api.join(worker.id);
  api.send(session.id, worker.id, { msg: "private body must not reach the native notice" });
  return {
    input: {
      authority: api.authority,
      worker: worker.id,
      sid: session.id,
      epoch: session.epoch,
      client,
      target,
      capabilities: { context: true, idle: true, launch: false },
      consumer,
    },
    session,
  };
}

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const stop = setTimeout(() => reject(new Error("delivery assertion timed out")), 1000);
    const check = () => {
      if (predicate()) { clearTimeout(stop); resolve(); }
      else setTimeout(check, 5);
    };
    check();
  });
}

function cliCapture() {
  const out = [];
  const err = [];
  return {
    io: { stdin: [], stdout: { write: (value) => out.push(value) }, stderr: { write: (value) => err.push(value) }, exitCode: 0 },
    output: () => out.join(""),
    error: () => err.join(""),
  };
}

test("supervisor coalesces local and hub scopes into one target-gated activation", async (t) => {
  const roots = ownedRoots(t);
  const { local, hub } = openPair(t, roots);
  const localGeneration = claimDeliveryOwner(local);
  let nativeCalls = 0;
  const consumer = {
    status: async () => ({ state: "idle" }),
    submit: async ({ attemptId, notice }) => {
      nativeCalls++;
      assert.ok(attemptId.startsWith("delivery-"));
      assert.match(notice, /msg=1/);
      assert.equal(notice.includes("private body"), false);
      return { accepted: true, nativeRequestId: "native-request-1" };
    },
    observe: async () => ({ state: "unknown" }),
  };
  const target = { runtimeInstance: "runtime-1", profile: "default", nativeSession: "native-1", lifecycleGeneration: "life-1" };
  const localBinding = bindingInput(local, target, consumer, "hermes");
  const hubBinding = bindingInput(hub, target, consumer, "opencode");
  assert.equal(local.pending(localBinding.session.id).pending.msg, 1);
  assert.equal(hub.pending(hubBinding.session.id).pending.msg, 1);
  const supervisorOptions = {
    local,
    hub,
    pool: null,
    launchConfigured: false,
    ownerGeneration: localGeneration.generation,
    clients: ["hermes", "opencode"],
    pollMs: 250,
  };
  const supervisor = createDeliverySupervisor(supervisorOptions);
  t.after(() => supervisor.close());
  assert.throws(() => createDeliverySupervisor(supervisorOptions), { code: "active" });
  await supervisor.start();
  const localHandle = await supervisor.bind(localBinding.input);
  await supervisor.bind(hubBinding.input);
  await supervisor.refresh();

  assert.equal(nativeCalls, 1, JSON.stringify({ status: supervisor.status(), delivery: deliveryStatus(local) }));
  const [attempt] = listDeliveryAttempts(local, localGeneration.generation);
  assert.ok(attempt);
  assert.equal(attempt.state, "admitted");
  assert.equal(attempt.scopes.length, 2);
  assert.equal(deliveryStatus(local).targets.locked, 1);
  await Promise.all([supervisor.refresh(), supervisor.refresh()]);
  assert.equal(nativeCalls, 1);

  assert.equal(localHandle.observe(attempt.id, { state: "safe_idle", nativeRequestId: "native-request-1" }), false);
  assert.equal(localHandle.observe(attempt.id, { state: "context_observed", nativeRequestId: "native-request-1" }), true);
  assert.equal(localHandle.observe(attempt.id, { state: "turn_started", nativeRequestId: "native-request-1" }), true);
  assert.equal(localHandle.observe(attempt.id, { state: "safe_idle", nativeRequestId: "native-request-1" }), true);
  await supervisor.refresh();
  assert.equal(nativeCalls, 1);
  assert.equal(deliveryStatus(local).targets.locked, 0);
  assert.equal(local.pending(localBinding.session.id).pending.msg, 1);
  assert.equal(hub.pending(hubBinding.session.id).pending.msg, 1);
  const pendingCli = cliCapture();
  assert.equal(await main(["pending", "--sid", localBinding.session.id, "--root", roots.localRoot, "--json"], pendingCli.io), 0);
  assert.deepEqual(Object.keys(JSON.parse(pendingCli.output())), ["v", "authority", "worker", "epoch", "revision", "pending", "recoverable"]);
  await supervisor.close();
});

test("native hold keeps the target gate while refusal releases it without consuming pending state", async (t) => {
  for (const response of [{ state: "held", reasonCode: "native-held", locked: 1 }, { state: "refused", reasonCode: "native-refused", locked: 0 }]) {
    const { localRoot } = ownedRoots(t);
    setup({ root: localRoot, device: "local", role: "host" });
    const local = openForBroker({ root: localRoot, role: "host", ownerToken: "R".repeat(32) });
    t.after(() => local.close());
    const generation = claimDeliveryOwner(local);
    const consumer = {
      status: async () => ({ state: "idle" }),
      submit: async () => ({ accepted: false, state: response.state }),
      observe: async () => ({ state: "unknown" }),
    };
    const target = { runtimeInstance: `runtime-${response.state}`, profile: "default", nativeSession: `native-${response.state}`, lifecycleGeneration: `life-${response.state}` };
    const binding = bindingInput(local, target, consumer);
    const supervisor = createDeliverySupervisor({ local, hub: null, pool: null, launchConfigured: false, ownerGeneration: generation.generation, clients: ["hermes"], pollMs: 250 });
    t.after(() => supervisor.close());
    await supervisor.start();
    await supervisor.bind(binding.input);
    await supervisor.refresh();

    const [attempt] = listDeliveryAttempts(local, generation.generation);
    assert.equal(attempt.state, response.state);
    assert.equal(attempt.reasonCode, response.reasonCode);
    assert.equal(deliveryStatus(local).targets.locked, response.locked);
    assert.deepEqual(local.pending(binding.session.id).pending, { msg: 1, work: 0 });
    await supervisor.close();
  }
});

test("configured hub Client summaries are read remotely and stored only in the local delivery ledger", async (t) => {
  const roots = ownedRoots(t);
  setup({ root: roots.localRoot, device: "local", role: "host" });
  setup({ root: roots.hubRoot, device: "hub", role: "hub" });
  const local = openForBroker({ root: roots.localRoot, role: "host", ownerToken: "D".repeat(32) });
  t.after(() => local.close());
  const remote = open({ root: roots.hubRoot, role: "hub" });
  const remoteWorker = remote.register("worker");
  remote.close();

  const grant = emptyGrant();
  grant.workers = [remoteWorker.id];
  grant.recipients = [remoteWorker.id];
  const auth = credential({ principal: "delivery-reader", grant });
  const credentialsFile = join(roots.hubRoot, "credentials.json");
  const tokenFile = join(roots.hubRoot, "hub-token");
  const configFile = join(roots.hubRoot, "hub.json");
  await privateFile(credentialsFile, JSON.stringify({ version: 1, credentials: [auth.entry] }));
  await privateFile(tokenFile, auth.token);
  const port = await freePort();
  await privateFile(configFile, JSON.stringify({ version: 1, role: "hub", mode: "local", listen: { host: "127.0.0.1", port }, tls: null, allowedPeers: [], credentialsFile: "./credentials.json", hub: null, pool: null, views: [] }));
  const hubBroker = await serve({ root: roots.hubRoot, configFile });
  let client;
  let supervisor;
  try {
    client = await connect({ url: `http://127.0.0.1:${port}`, tokenFile, mode: "local" });
    const remoteSession = await client.join(remoteWorker.id);
    await client.send(remoteSession.id, remoteWorker.id, { msg: "remote private body" });
    const remoteSummary = await client.pending(remoteSession.id);
    assert.equal(remoteSummary.authority, client.authority);
    assert.deepEqual(remoteSummary.pending, { msg: 1, work: 0 });
    const generation = claimDeliveryOwner(local);
    const nativeCalls = [];
    const consumer = {
      status: async () => ({ state: "idle" }),
      submit: async ({ attemptId, notice }) => { nativeCalls.push({ attemptId, notice }); return { accepted: true, nativeRequestId: "remote-target-request" }; },
      observe: async () => ({ state: "unknown" }),
    };
    const target = { runtimeInstance: "runtime-remote", profile: "default", nativeSession: "native-remote", lifecycleGeneration: "life-remote" };
    const remoteBinding = { authority: client.authority, worker: remoteWorker.id, sid: remoteSession.id, epoch: remoteSession.epoch, client: "opencode", target, capabilities: { context: true, idle: true, launch: false }, consumer };
    supervisor = createDeliverySupervisor({ local, hub: client, pool: null, launchConfigured: false, ownerGeneration: generation.generation, clients: ["hermes", "opencode"], pollMs: 250 });
    t.after(() => supervisor.close());
    await supervisor.start();
    await supervisor.bind(remoteBinding);
    await supervisor.refresh();
    assert.equal(nativeCalls.length, 1);
    const [attempt] = listDeliveryAttempts(local, generation.generation);
    assert.equal(attempt.scopes.length, 1);
    assert.equal(attempt.scopes[0].authority, client.authority);
    assert.equal(attempt.scopes[0].sid, remoteSession.id);
    const untouchedHub = open({ root: roots.hubRoot, role: "hub", readOnly: true });
    try { assert.equal(Number(untouchedHub._store.db.prepare("SELECT COUNT(*) AS n FROM delivery_attempts").get().n), 0); }
    finally { untouchedHub.close(); }
    assert.equal(nativeCalls[0].notice.includes("remote private body"), false);
  } finally {
    await supervisor?.close();
    await client?.close();
    await hubBroker.close();
  }
});

test("shutdown retains uncertain acceptance and a replacement owner cannot reuse an old callback", async (t) => {
  const { localRoot } = ownedRoots(t);
  setup({ root: localRoot, device: "local", role: "host" });
  const local = openForBroker({ root: localRoot, role: "host", ownerToken: "A".repeat(32) });
  t.after(() => local.close());
  const firstGeneration = claimDeliveryOwner(local);
  let submitted = 0;
  const target = { runtimeInstance: "runtime-2", profile: "default", nativeSession: "native-2", lifecycleGeneration: "life-2" };
  const firstConsumer = {
    status: async () => ({ state: "idle" }),
    submit: async () => { submitted++; return { accepted: true, nativeRequestId: "native-request-2" }; },
    observe: async () => ({ state: "unknown" }),
  };
  const firstInput = bindingInput(local, target, firstConsumer);
  const first = createDeliverySupervisor({ local, hub: null, pool: null, launchConfigured: false, ownerGeneration: firstGeneration.generation, clients: ["hermes"], pollMs: 250 });
  t.after(() => first.close());
  await first.start();
  const oldHandle = await first.bind(firstInput.input);
  await first.refresh();
  assert.equal(submitted, 1);
  const [accepted] = listDeliveryAttempts(local, firstGeneration.generation);
  assert.equal(accepted.state, "admitted");
  await first.close();
  assert.equal(oldHandle.observe(accepted.id, { state: "context_observed", nativeRequestId: "native-request-2" }), false);
  assert.equal(deliveryStatus(local).targets.locked, 1);

  const nextGeneration = claimDeliveryOwner(local);
  assert.equal(listDeliveryAttempts(local, nextGeneration.generation)[0].state, "uncertain");
  const replacementConsumer = {
    status: async () => ({ state: "idle" }),
    submit: async () => { submitted++; return { accepted: true }; },
    observe: async () => ({ state: "unknown" }),
  };
  const replacement = createDeliverySupervisor({ local, hub: null, pool: null, launchConfigured: false, ownerGeneration: nextGeneration.generation, clients: ["hermes"], pollMs: 250 });
  t.after(() => replacement.close());
  await replacement.start();
  await replacement.bind({ ...firstInput.input, consumer: replacementConsumer });
  await replacement.refresh();

  assert.equal(submitted, 1);
  assert.equal(listDeliveryAttempts(local, nextGeneration.generation)[0].state, "uncertain");
  assert.equal(deliveryStatus(local).targets.locked, 1);
  await replacement.close();
  const reconcileCli = cliCapture();
  assert.equal(await main(["delivery-reconcile", accepted.id, "--root", localRoot, "--outcome", "not-accepted", "--reason-code", "operator-confirmed", "--confirm", "--json"], reconcileCli.io), 0, reconcileCli.error());
  assert.deepEqual(JSON.parse(reconcileCli.output()), { id: accepted.id, state: "reconciled", outcome: "not-accepted" });
  assert.equal(deliveryStatus(local).targets.locked, 0);
});

test("shutdown cancellation preserves an uncertain native submission", async (t) => {
  const { localRoot } = ownedRoots(t);
  setup({ root: localRoot, device: "local", role: "host" });
  const local = openForBroker({ root: localRoot, role: "host", ownerToken: "C".repeat(32) });
  t.after(() => local.close());
  const generation = claimDeliveryOwner(local);
  const target = { runtimeInstance: "runtime-3", profile: "default", nativeSession: "native-3", lifecycleGeneration: "life-3" };
  let submitted = 0;
  let cancelled = 0;
  const consumer = {
    status: async () => ({ state: "idle" }),
    submit: async ({ signal }) => new Promise((resolve, reject) => {
      submitted++;
      signal.addEventListener("abort", () => { cancelled++; reject(new Error("cancelled")); }, { once: true });
    }),
    observe: async () => ({ state: "unknown" }),
  };
  const input = bindingInput(local, target, consumer);
  const supervisor = createDeliverySupervisor({ local, hub: null, pool: null, launchConfigured: false, ownerGeneration: generation.generation, clients: ["hermes"], pollMs: 250 });
  t.after(() => supervisor.close());
  await supervisor.start();
  await supervisor.bind(input.input);
  const pass = supervisor.refresh();
  await waitFor(() => submitted === 1);
  await supervisor.close();
  await pass;
  assert.equal(cancelled, 1);
  assert.equal(deliveryStatus(local).attempts.uncertain, 1);
  assert.equal(deliveryStatus(local).targets.locked, 1);
  assert.equal(deliveryStatus(local).owner.active, false);
});

test("serve owns the opt-in supervisor and releases its CORE owner on shutdown", async () => {
  await withTempDir(async (root) => {
    setup({ root, device: "host", role: "host" });
    const credentialsFile = join(root, "credentials.json");
    const configFile = join(root, "relay.json");
    await privateFile(credentialsFile, JSON.stringify({ version: 1, credentials: [] }));
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    await privateFile(configFile, JSON.stringify({
      version: 2,
      role: "host",
      mode: "local",
      listen: { host: "127.0.0.1", port },
      tls: null,
      allowedPeers: [],
      credentialsFile: "./credentials.json",
      hub: null,
      pool: null,
      views: [],
      delivery: { enabled: true, clients: ["hermes"], pollMs: 250 },
    }));
    const broker = await serve({ root, configFile });
    const active = open({ root, readOnly: true });
    try {
      assert.equal(deliveryStatus(active).owner.active, true);
      assert.equal(broker.address.port, port);
      const statusCli = cliCapture();
      assert.equal(await main(["delivery-status", "--root", root, "--config", configFile, "--json"], statusCli.io), 0, statusCli.error());
      const diagnostic = JSON.parse(statusCli.output());
      assert.equal(diagnostic.configuredEnabled, true);
      assert.equal(diagnostic.owner.active, true);
      assert.deepEqual(diagnostic.clients.map(({ client, evidence }) => ({ client, evidence })), [{ client: "hermes", evidence: "unsupported" }]);
    } finally { active.close(); }
    await broker.close();
    const stopped = open({ root, readOnly: true });
    try { assert.equal(deliveryStatus(stopped).owner.active, false); }
    finally { stopped.close(); }
  });
});

test("CLI migration holds the broker lock and publishes an explicit v2 backup", async (t) => {
  const root = temporaryRoot(t);
  setup({ root, device: "migration", role: "host" });
  const legacy = new DatabaseSync(join(root, "relay.sqlite"));
  legacy.exec("DROP TABLE delivery_attempt_scopes; DROP TABLE delivery_attempts; DROP TABLE delivery_bindings; DROP TABLE delivery_targets; DROP TABLE delivery_owners; UPDATE meta SET value='2' WHERE key='schema'; PRAGMA user_version=2;");
  legacy.close();
  const backup = join(root, "before-v3.sqlite");
  const capture = cliCapture();
  assert.equal(await main(["migrate", "--root", root, "--to", "3", "--backup", backup, "--json"], capture.io), 0, capture.error());
  assert.deepEqual(JSON.parse(capture.output()), { from: 2, to: 3, backup });
  assert.equal(existsSync(backup), true);
  assert.equal(existsSync(join(root, "broker.lock")), false);
  const migrated = open({ root, readOnly: true });
  try { assert.equal(deliveryStatus(migrated).owner.generation, 0); }
  finally { migrated.close(); }
});

test("delivery CLI routes are strict and local diagnostics remain read-only", () => {
  assert.equal(parseArgs(["pending", "--sid", "session-1", "--root", "/tmp/relay"]).readOnly, true);
  assert.throws(() => parseArgs(["pending", "--root", "/tmp/relay"]), /--sid is required/);
  assert.throws(() => parseArgs(["delivery-status", "--root", "/tmp/relay"]), /requires --root and --config/);
  assert.throws(() => parseArgs(["delivery-reconcile", "attempt-1", "--root", "/tmp/relay", "--outcome", "observed", "--reason-code", "operator-confirmed"]), /--confirm/);
  assert.equal(parseArgs(["delivery-reconcile", "attempt-1", "--root", "/tmp/relay", "--outcome", "not-accepted", "--reason-code", "operator-confirmed", "--confirm"]).command, "delivery-reconcile");
  assert.equal(parseArgs(["migrate", "--root", "/tmp/relay", "--to", "3", "--backup", "/tmp/backup.sqlite"]).command, "migrate");
  assert.throws(() => parseArgs(["migrate", "--root", "/tmp/relay", "--to", "2", "--backup", "/tmp/backup.sqlite"]), /--config FILE/);
});
