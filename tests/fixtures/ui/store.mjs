import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open as openFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createPool } from "../../../src/pool.mjs";
import { LIMITS } from "../../../src/validate.mjs";

// Test-only synthetic participants exercise the real store and broker, not native agents.

const DEFAULT_DURATION_MS = 300_000;
const MAX_DURATION_MS = 3_600_000;
const VALUE_FLAGS = new Set(["--port", "--duration-ms"]);
const IGNORED_LEAVE_CODES = new Set(["session", "expired"]);
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) await main();

export function fixtureOptions(args, env = process.env) {
  const parsed = parseFixtureArgs(args);
  if (!parsed.serve) {
    if (parsed.values.size) throw new Error("--port and --duration-ms require --serve");
    return { serve: false };
  }
  const port = positiveInt(
    parsed.values.get("--port") ?? env.RELAY_FIXTURE_PORT ?? "4200",
    "port",
    65_535,
  );
  const durationMs = positiveInt(
    parsed.values.get("--duration-ms") ??
      env.RELAY_FIXTURE_DURATION_MS ??
      String(DEFAULT_DURATION_MS),
    "duration",
    MAX_DURATION_MS,
  );
  if (durationMs < 1_000) throw new Error("duration must be at least 1000 ms");
  return { serve: true, port, durationMs };
}

function parseFixtureArgs(args) {
  const values = new Map();
  let serve = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--serve") {
      if (serve) throw new Error("--serve may be specified once");
      serve = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg))
      throw new Error(
        "usage: node tests/fixtures/ui/store.mjs [--serve [--port PORT] [--duration-ms MS]]",
      );
    if (values.has(arg)) throw new Error(`${arg} may be specified once`);
    const value = args[++index];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
  }
  return { serve, values };
}

function positiveInt(value, label, max) {
  if (!/^[0-9]{1,10}$/.test(String(value))) throw new Error(`${label} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max)
    throw new Error(`${label} is out of range`);
  return number;
}

async function main() {
  try {
    const options = fixtureOptions(process.argv.slice(2));
    if (options.serve) await serveFixture(options);
    else await inspectFixture();
  } catch (error) {
    const details =
      error instanceof AggregateError
        ? `${safeMessage(error)}: ${error.errors.map(safeMessage).join("; ")}`
        : safeMessage(error);
    process.stderr.write(`fixture failed: ${details}\n`);
    process.exitCode = 1;
  }
}

async function inspectFixture() {
  const { open, setup } = await import("../../../src/index.mjs");
  const parent = await mkdtemp(join(tmpdir(), "relay-ui-fixture-"));
  const parentIdentity = await identifyDirectory(parent);
  const root = join(parent, "store");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("fixture time limit reached")),
    15_000,
  );
  const signals = installSignals(controller);
  let relay;
  let failure;
  try {
    const device = setup({ root, device: "fixture-local", role: "hub" });
    relay = open({ root });
    const result = await populate(relay, device, controller.signal);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    clearTimeout(timeout);
    signals.remove();
    const cleanup = [];
    try {
      relay?.close();
    } catch (error) {
      cleanup.push(error);
    }
    await removeOwnedTemp(parent, parentIdentity, cleanup);
    finishCleanup(cleanup, failure);
  }
}

async function serveFixture({ port, durationMs }) {
  const parent = await mkdtemp(join(tmpdir(), "relay-ui-fixture-"));
  const parentIdentity = await identifyDirectory(parent);
  const root = join(parent, "store");
  const tokenDestination = resolveTokenDestination(parent);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("fixture duration reached")),
    durationMs,
  );
  const signals = installSignals(controller);
  const state = createServeState();
  const sessions = [];
  try {
    await runServeFixture({
      state,
      sessions,
      root,
      parent,
      port,
      durationMs,
      tokenDestination,
      controller,
    });
  } catch (error) {
    state.failure = error;
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort(new Error("fixture cleanup"));
    signals.remove();
    const cleanup = await cleanupServeFixture(state, sessions, parent, parentIdentity);
    finishCleanup(cleanup, state.failure);
  }
}

function createServeState() {
  return {
    device: null,
    tokenRecord: null,
    broker: null,
    api: null,
    relay: null,
    pool: null,
    maintenance: null,
    loopTasks: [],
    backgroundFailure: null,
    failure: null,
  };
}

function resolveTokenDestination(parent) {
  return process.env.RELAY_FIXTURE_TOKEN_FILE
    ? resolve(process.env.RELAY_FIXTURE_TOKEN_FILE)
    : join(parent, "capture.token");
}

async function runServeFixture({
  state,
  sessions,
  root,
  parent,
  port,
  durationMs,
  tokenDestination,
  controller,
}) {
  const { open, setup } = await import("../../../src/index.mjs");
  state.device = setup({ root, device: "fixture-local", role: "hub" });
  state.relay = open({ root });
  const result = await populate(state.relay, state.device, controller.signal, sessions, {
    serve: true,
  });
  state.tokenRecord = await createToken(tokenDestination);
  await writeFixtureFiles(parent, state.device, state.tokenRecord.token, port);
  state.pool = createPool({
    local: state.relay,
    hub: null,
    maxAgents: 2,
    maxJobs: 1,
    pollMs: 1_000,
    minBackoffMs: 250,
    maxBackoffMs: 1_000,
    launch: null,
  });
  state.loopTasks = startFixtureLoops(state, sessions, controller);
  state.maintenance = maintainSessions(
    state.relay,
    state.device,
    sessions,
    controller.signal,
  ).catch((error) => {
    recordBackgroundFailure(state, controller, error);
  });
  await startFixtureServices(state, { root, parent, port, tokenDestination });
  const topology = await state.api.snapshot({ limit: 64 });
  writeServeReport({ port, tokenDestination, durationMs, result, topology });
  await waitForStop(controller.signal);
  if (state.backgroundFailure) throw state.backgroundFailure;
  if (controller.signal.reason && !isNormalStop(controller.signal.reason))
    throw controller.signal.reason;
}

function startFixtureLoops(state, sessions, controller) {
  return sessions.map(({ worker, id }) =>
    state.pool
      .start({
        worker,
        localSid: id,
        signal: controller.signal,
        execute: (item, signal) => executeFixtureItem(item, signal),
      })
      .catch((error) => {
        recordBackgroundFailure(state, controller, error);
      }),
  );
}

function executeFixtureItem(item, signal) {
  if (signal.aborted) throw signal.reason;
  if (item.kind === "work") {
    if (typeof item.lease?.work?.input !== "string") return "rejected";
    computeWork(item.lease.work.input);
  }
  return "done";
}

function recordBackgroundFailure(state, controller, error) {
  if (isNormalStop(controller.signal.reason) && error?.code === "unavailable") return;
  state.backgroundFailure ??= error;
  if (!controller.signal.aborted) controller.abort(error);
}

async function startFixtureServices(state, { root, parent, port, tokenDestination }) {
  const { connect, serve } = await import("../../../src/index.mjs");
  state.broker = await serve({ root, configFile: join(parent, "config.json") });
  if (state.broker.address?.port !== port || state.broker.address?.address !== "127.0.0.1")
    throw new Error("fixture broker did not bind the configured loopback address");
  state.api = await connect({
    url: `http://127.0.0.1:${port}`,
    tokenFile: tokenDestination,
    mode: "local",
  });
}

function writeServeReport({ port, tokenDestination, durationMs, result, topology }) {
  process.stdout.write(
    `${JSON.stringify(
      {
        url: `http://127.0.0.1:${port}`,
        tokenFile: tokenDestination,
        durationMs,
        device: result.device,
        workers: result.workers,
        inbox: result.inbox,
        bounties: result.bounties,
        receipts: result.receipts,
        topology: {
          authority: topology.authority,
          totals: topology.totals,
          visible: topology.visible,
          cursor: topology.cursor,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function cleanupServeFixture(state, sessions, parent, parentIdentity) {
  const cleanup = [];
  if (state.maintenance) await state.maintenance.catch((error) => cleanup.push(error));
  await Promise.all(state.loopTasks);
  await collectCleanupError(cleanup, () => state.pool?.close());
  for (const session of sessions) leaveFixtureSession(state, session, cleanup);
  await collectCleanupError(cleanup, () => state.api?.close());
  await collectCleanupError(cleanup, () => state.broker?.close());
  await collectCleanupError(cleanup, () => state.relay?.close());
  const preserveTemp = await removeFixtureToken(state, parent, cleanup);
  await removeOwnedTemp(parent, parentIdentity, cleanup, preserveTemp);
  return cleanup;
}

async function collectCleanupError(cleanup, action) {
  try {
    await action();
  } catch (error) {
    cleanup.push(error);
  }
}

function leaveFixtureSession(state, session, cleanup) {
  try {
    state.relay?.leave(session.id);
  } catch (error) {
    if (!IGNORED_LEAVE_CODES.has(error.code)) cleanup.push(error);
  }
}

async function removeFixtureToken(state, parent, cleanup) {
  if (!state.tokenRecord) return false;
  try {
    await removeToken(state.tokenRecord);
    return false;
  } catch (error) {
    cleanup.push(error);
    return isWithin(parent, state.tokenRecord.path);
  }
}

async function populate(relay, device, signal, sessions = [], { serve = false } = {}) {
  const hostBoard = `host:${device.id}`;
  const workers = await registerFixtureWorkers(relay, sessions);
  const inboxAdmission = await relay.post(sessions[0].id, hostBoard, {
    msg: "Synthetic test workers are ready.",
  });
  await relay.post(sessions[0].id, "bounty", { msg: "Synthetic test workers are ready." });
  const workAdmissions = [
    await relay.post(
      sessions[0].id,
      "bounty",
      { work: { task: "inspect", input: "relay fixture topology" } },
      { needs: ["inspect"] },
    ),
    await relay.post(
      sessions[0].id,
      hostBoard,
      { work: { task: "verify", input: "relay fixture board" } },
      { needs: ["verify"] },
    ),
  ];
  const consumed = await consumeFixtureWork(relay, sessions, signal, serve, hostBoard);
  return collectFixtureSummary(relay, {
    device,
    hostBoard,
    workers,
    inboxAdmission,
    workAdmissions,
    consumed,
    serve,
  });
}

async function registerFixtureWorkers(relay, sessions) {
  const workerA = await relay.register("worker", { caps: ["inspect"] });
  const workerB = await relay.register("worker", { caps: ["verify"] });
  const workers = [workerA, workerB];
  for (const worker of workers)
    sessions.push({ worker: worker.id, id: (await relay.join(worker.id)).id });
  return workers;
}

async function consumeFixtureWork(relay, sessions, signal, serve, hostBoard) {
  const consumed = [];
  for (const index of serve ? [0] : [0, 1]) {
    const board = index === 0 ? "bounty" : hostBoard;
    const lease = await relay.claim(sessions[index].id, { board, kind: "work" });
    if (!lease?.work || typeof lease.work.input !== "string")
      throw new Error("fixture work was not claimable");
    if (signal.aborted) throw signal.reason;
    const workResult = computeWork(lease.work.input);
    if (signal.aborted) {
      await relay.release(sessions[index].id, lease.id);
      throw signal.reason;
    }
    const receipt = await relay.ack(sessions[index].id, lease.id, "done");
    consumed.push([
      { mid: receipt.mid, lease: receipt.lease, outcome: receipt.outcome, result: workResult },
    ]);
  }
  return consumed;
}

async function collectFixtureSummary(
  relay,
  { device, hostBoard, workers, inboxAdmission, workAdmissions, consumed, serve },
) {
  const inbox = await relay.list({ board: hostBoard, kind: "msg", limit: 20, data: true });
  const bounties = await relay.list({ board: "bounty", kind: "work", limit: 20, data: true });
  const work = await relay.list({ board: hostBoard, kind: "work", limit: 20, data: true });
  const snapshot = serve ? null : await relay.snapshot({ limit: 64 });
  const audit = serve ? null : await relay.audit({ limit: 64 });
  return {
    device: { id: device.id, name: device.name },
    workers: workers.map(({ id }) => id),
    inboxAdmission,
    workAdmissions,
    consumed,
    inbox: { total: inbox.total, visible: inbox.visible, rows: inbox.items.map(compactMessage) },
    work: { total: work.total, visible: work.visible, rows: work.items.map(compactMessage) },
    bounties: {
      total: bounties.total,
      visible: bounties.visible,
      rows: bounties.items.map(compactMessage),
    },
    receipts: consumed.flat(),
    topology: snapshot
      ? {
          authority: snapshot.authority,
          totals: snapshot.totals,
          visible: snapshot.visible,
          cursor: snapshot.cursor,
        }
      : null,
    events:
      audit?.items.map(({ seq, time, type, worker, mid, lease, code }) => ({
        seq,
        time,
        type,
        worker,
        mid,
        lease,
        code,
      })) ?? [],
  };
}

async function maintainSessions(relay, device, sessions, signal) {
  let seq = 0;
  while (!signal.aborted) {
    for (const session of sessions) relay.renew(session.id);
    const snapshot = await relay.snapshot({ limit: 64 });
    const inbox = await relay.list({ board: `host:${device.id}`, kind: "msg", limit: 200 });
    const [pending, claimed, done, failed, rejected] = await Promise.all(
      ["pending", "claimed", "done", "failed", "rejected"].map((state) =>
        relay.list({ board: `host:${device.id}`, kind: "work", state, limit: 1 }),
      ),
    );
    await relay.report(sessions[0].id, {
      seq: ++seq,
      agents: snapshot.agents.map(({ id, assignmentCount }) => ({
        worker: id,
        state: "unknown",
        free: null,
        assignmentCount,
      })),
      board: {
        id: `host:${device.id}`,
        inbox: inbox.total,
        pending: pending.total,
        claimed: claimed.total,
        terminal: done.total + failed.total + rejected.total,
      },
    });
    await delay(LIMITS.reportIntervalMs, signal);
  }
}

function delay(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", abort);
      resolveDelay();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolveDelay();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function isNormalStop(reason) {
  return (
    reason?.message === "fixture duration reached" ||
    reason?.message === "fixture interrupted" ||
    reason?.message === "fixture cleanup"
  );
}

function isWithin(parent, path) {
  return resolve(path).startsWith(`${resolve(parent)}${sep}`);
}

function compactMessage({ id, seq, from, board, kind, state, init, acked }) {
  return { id, seq, from, board, kind, state, init, acked };
}

function computeWork(input) {
  let value = input;
  for (let i = 0; i < 128; i++) value = createHash("sha256").update(value).digest("hex");
  return value.slice(0, 16);
}

async function writeFixtureFiles(parent, device, token, port) {
  const registry = {
    version: 1,
    credentials: [
      {
        principal: "relay-fixture",
        tokenDigest: createHash("sha256").update(token).digest("hex"),
        grant: {
          enroll: [],
          register: [],
          workers: [],
          recipients: [],
          boardPost: [],
          boardClaim: [],
          inboxRead: ["bounty", `host:${device.id}`],
          workRead: ["bounty", `host:${device.id}`],
          inspect: { messages: false, receipts: false, audit: false, topology: true },
          reportDevice: null,
        },
      },
    ],
  };
  const config = {
    version: 1,
    role: "hub",
    mode: "local",
    listen: { host: "127.0.0.1", port },
    tls: null,
    allowedPeers: [],
    credentialsFile: "registry.json",
    hub: null,
    pool: null,
    views: [],
  };
  await writePrivate(join(parent, "registry.json"), JSON.stringify(registry));
  await writePrivate(join(parent, "config.json"), JSON.stringify(config));
}

async function createToken(path) {
  const token = randomBytes(32).toString("base64url");
  const handle = await openFile(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let created;
  try {
    created = await handle.stat();
    await handle.writeFile(`${token}\n`, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    return { path, token, dev: created.dev, ino: created.ino };
  } catch (error) {
    await cleanupFailedToken(handle, path, created, error);
  }
}

async function cleanupFailedToken(handle, path, created, error) {
  const cleanup = [];
  try {
    await handle.close();
  } catch (cleanupError) {
    cleanup.push(cleanupError);
  }
  try {
    const current = await lstat(path);
    if (
      created &&
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === created.dev &&
      current.ino === created.ino
    )
      await rm(path);
  } catch (cleanupError) {
    if (cleanupError?.code !== "ENOENT") cleanup.push(cleanupError);
  }
  if (cleanup.length)
    throw new AggregateError([error, ...cleanup], "fixture token creation and cleanup failed", {
      cause: error,
    });
  throw error;
}

async function writePrivate(path, value) {
  const handle = await openFile(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${value}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeToken(tokenRecord) {
  const info = await lstat(tokenRecord.path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.dev !== tokenRecord.dev ||
    info.ino !== tokenRecord.ino
  )
    throw new Error("refusing to remove a replaced fixture token file");
  await rm(tokenRecord.path);
  tokenRecord.token = "";
}

async function identifyDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("fixture temporary root is not a private directory");
  return { dev: info.dev, ino: info.ino };
}

async function removeOwnedTemp(parent, identity, cleanup, preserve = false) {
  const base = resolve(tmpdir());
  const path = resolve(parent);
  if (!path.startsWith(`${base}${sep}`)) {
    cleanup.push(new Error("refusing to remove unowned fixture state"));
    return;
  }
  if (preserve) return;
  try {
    const current = await lstat(parent);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw new Error("refusing to remove a replaced fixture root");
    await rm(parent, { recursive: true });
  } catch (error) {
    cleanup.push(error);
  }
}

function installSignals(controller) {
  const signal = () => controller.abort(new Error("fixture interrupted"));
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  return {
    remove: () => {
      process.removeListener("SIGINT", signal);
      process.removeListener("SIGTERM", signal);
    },
  };
}

function waitForStop(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveStop) =>
    signal.addEventListener("abort", resolveStop, { once: true }),
  );
}

function finishCleanup(cleanup, failure) {
  if (!cleanup.length) return;
  if (failure) {
    process.stderr.write(`cleanup after primary failure: ${cleanup.map(safeMessage).join("; ")}\n`);
    return;
  }
  throw new AggregateError(cleanup, "fixture cleanup failed");
}

function safeMessage(error) {
  return error instanceof Error
    ? error.message.replace(/\p{Cc}/gu, " ").slice(0, 500)
    : "unknown error";
}
