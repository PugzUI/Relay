import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Fault } from "./fault.mjs";
import { parseJsonStrict } from "./config.mjs";
import { readLinuxProcessStart } from "./process-identity.mjs";
import { LIMITS } from "./validate.mjs";
import { invokeClient } from "./client.mjs";
import {
  dispatchLocalPool, inspectAttempt, reserveCapacity, bindCapacity, listCapacity,
  beginCapacitySettlement, resolveCapacity, reserveLaunch, listLaunches, updateLaunch, relayRoot,
} from "./relay.mjs";

const pools = new WeakMap();
const fail = (code, message) => { throw new Fault(code, message); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const rid = () => randomBytes(18).toString("base64url");
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Fault("unavailable", "Pool operation was cancelled")); return; }
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener("abort", aborted); resolve(); }
  function aborted() { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(new Fault("unavailable", "Pool operation was cancelled")); }
  signal?.addEventListener("abort", aborted, { once: true });
});
const randomWait = (min, max) => Math.min(max, Math.floor(min + Math.random() * Math.max(1, max - min + 1)));
const outcomeOf = (value) => value && typeof value === "object" && Object.hasOwn(value, "result") ? value.result : value;

async function reconcileHandle(handle) {
  if (!handle || handle.platform !== "linux" || !Number.isSafeInteger(handle.pid) || handle.pid < 1 || typeof handle.processStart !== "string" || typeof handle.nonce !== "string") return null;
  const current = await readLinuxProcessStart(handle.pid);
  if (current === false || current && current !== handle.processStart) return false;
  if (!current) return null;
  try {
    const environment = await readFile(`/proc/${handle.pid}/environ`, "utf8");
    return environment.split("\0").includes(`RELAY_LAUNCH_NONCE=${handle.nonce}`) ? true : null;
  } catch (error) { return error.code === "ENOENT" ? false : null; }
}
const handleMatches = async (handle) => await reconcileHandle(handle) === true;

function validateOptions(options) {
  if (!object(options) || !options.local || !Number.isInteger(options.maxAgents) || options.maxAgents < 1 || options.maxAgents > 512 || !Number.isInteger(options.maxJobs) || options.maxJobs < 1 || options.maxJobs > 128 || !Number.isInteger(options.pollMs) || options.pollMs < 100 || options.pollMs > 60000 || !Number.isInteger(options.minBackoffMs) || options.minBackoffMs < 100 || options.minBackoffMs > 5000 || !Number.isInteger(options.maxBackoffMs) || options.maxBackoffMs < options.minBackoffMs || options.maxBackoffMs > 60000) fail("input", "Pool options are invalid");
  if (options.launch !== null && (!object(options.launch) || !Array.isArray(options.launch.args) || !Array.isArray(options.launch.capabilities))) fail("input", "Launch recipe is invalid");
}

function localClaim(relay, sid, requestId, options) {
  return dispatchLocalPool(relay, { rid: requestId, op: "claim", args: { sid, options } });
}
function remoteCall(pool, client, requestId, op, args, signal = pool.abort.signal) {
  const requestSignal = signal === pool.abort.signal ? signal : AbortSignal.any([pool.abort.signal, signal]);
  return invokeClient(client, { rid: requestId, op, args, deadline: performance.now() + 10000, signal: requestSignal });
}

async function claimAt(pool, input, remote, board, kind, signal = pool.abort.signal) {
  if (pool.closed || signal.aborted) return { state: "skipped" };
  const sid = remote ? input.hubSid : input.localSid;
  const worker = input.worker;
  if (kind === "msg" && !pool.pendingMessages.has(worker) && pool.pendingMessages.size >= 512) fail("full", "Pool message recovery capacity is full");
  const requestId = rid(); const authority = remote ? pool.hub?.authority : pool.local.authority;
  if (!authority || !sid) return { state: "skipped" };
  if (kind === "msg") {
    try {
      const result = remote ? await remoteCall(pool, pool.hub, requestId, "claim", { sid, options: { kind } }, signal) : await localClaim(pool.local, sid, requestId, { kind });
      const lease = outcomeOf(result);
      pool.pendingMessages.delete(worker);
      return lease ? { state: "claimed", kind, rid: requestId, authority, board: null, lease } : { state: "empty" };
    } catch (error) {
      if (error instanceof Fault && error.code === "rate") return { state: "rate" };
      if (error instanceof Fault && ["unavailable", "timeout", "uncertain"].includes(error.code)) {
        pool.pendingMessages.set(worker, { worker, sid, remote, authority, rid: requestId, kind });
        return { state: "uncertain", rid: requestId, authority, board: null, mid: null, lease: null };
      }
      pool.pendingMessages.delete(worker);
      if (remote && error instanceof Fault && ["auth", "denied", "missing", "unavailable"].includes(error.code)) return { state: "skipped" };
      throw error;
    }
  }
  const localSid = input.localSid; const remoteSid = remote ? input.hubSid ?? null : null;
  const selectedSid = sid;
  const reserve = { worker, localSid, remoteSid, board, rid: requestId, authority, maxJobs: pool.maxJobs };
  try { reserveCapacity(pool.local, reserve); }
  catch (error) { if (error instanceof Fault && ["full", "busy"].includes(error.code)) return { state: "empty" }; throw error; }
  try {
    const claimOptions = board === null ? { kind: "work" } : { board };
    const result = remote ? await remoteCall(pool, pool.hub, requestId, "claim", { sid: selectedSid, options: claimOptions }, signal) : await localClaim(pool.local, selectedSid, requestId, claimOptions);
    const lease = outcomeOf(result);
    if (!lease) {
      resolveCapacity(pool.local, { worker, rid: requestId, proof: { kind: "claim", rid: requestId, authority, outcome: "empty" } });
      return { state: "empty" };
    }
    bindCapacity(pool.local, { worker, rid: requestId, authority, lease });
    return { state: "claimed", kind, rid: requestId, authority, board, lease };
  } catch (error) {
    if (error instanceof Fault && ["timeout", "uncertain", "unavailable"].includes(error.code)) return { state: "uncertain", rid: requestId, authority, board, mid: null, lease: null };
    // A returned typed refusal means no claim was accepted; Core checks the exact row tuple.
    if (error instanceof Fault) {
      resolveCapacity(pool.local, { worker, rid: requestId, proof: { kind: "claim", rid: requestId, authority, outcome: "refused" } });
      if (error.code === "rate") return { state: "rate" };
      if (remote && ["auth", "denied", "unavailable"].includes(error.code)) return { state: "skipped" };
      if (["full", "busy", "board", "denied", "session"].includes(error.code)) return { state: "empty" };
    }
    throw error;
  }
}

async function onePass(pool, input, signal) {
  const sources = [
    [false, null, "msg"],
    [true, null, "msg"],
    [false, null, "work"],
    [true, null, "work"],
    [false, `host:${pool.local.device.id}`, "work"],
    [true, "bounty", "work"],
  ];
  for (let offset = 0; offset < sources.length; offset++) {
    const index = (pool.sourceCursor + offset) % sources.length;
    const result = await claimAt(pool, input, ...sources[index], signal);
    if (result.state === "claimed" || result.state === "uncertain" || result.state === "rate") {
      pool.sourceCursor = result.state === "rate" ? index : (index + 1) % sources.length;
      return result;
    }
  }
  pool.sourceCursor = (pool.sourceCursor + 1) % sources.length;
  return null;
}

async function retryPendingMessage(pool, pending, signal = pool.abort.signal) {
  const client = pending.remote ? authorityClient(pool, pending.authority) : null;
  if (client === undefined || pending.remote && !client) return { state: "uncertain", rid: pending.rid, authority: pending.authority, board: null, mid: null, lease: null };
  try {
    const result = client
      ? await remoteCall(pool, client, pending.rid, "claim", { sid: pending.sid, options: { kind: pending.kind } }, signal)
      : await localClaim(pool.local, pending.sid, pending.rid, { kind: pending.kind });
    const lease = outcomeOf(result);
    pool.pendingMessages.delete(pending.worker);
    return lease ? { state: "claimed", kind: pending.kind, rid: pending.rid, authority: pending.authority, board: null, lease } : { state: "empty" };
  } catch (error) {
    if (error instanceof Fault && ["unavailable", "timeout", "uncertain"].includes(error.code)) return { state: "uncertain", rid: pending.rid, authority: pending.authority, board: null, mid: null, lease: null };
    if (error instanceof Fault && error.code === "rate") return { state: "rate", rid: pending.rid, authority: pending.authority, board: null, mid: null, lease: null };
    pool.pendingMessages.delete(pending.worker);
    if (pending.remote && error instanceof Fault && ["auth", "denied", "missing"].includes(error.code)) return { state: "skipped" };
    if (error instanceof Fault && ["full", "busy", "session", "expired", "superseded"].includes(error.code)) return { state: "empty" };
    throw error;
  }
}

function authorityClient(pool, authority) {
  if (authority === pool.local.authority) return null;
  if (pool.hub?.authority === authority) return pool.hub;
  return undefined;
}
function resolveCall(pool, row) {
  return authorityClient(pool, row.authority);
}
async function attempt(pool, row, signal = pool.abort.signal) {
  const client = resolveCall(pool, row);
  if (client === undefined) return null;
  if (client === null) return inspectAttempt(pool.local, { sid: row.remoteSid && row.authority !== pool.local.authority ? row.remoteSid : row.localSid, lease: row.lease }, null);
  if (!client || !row.remoteSid) return null;
  return outcomeOf(await remoteCall(pool, client, rid(), "attempt", { sid: row.remoteSid, lease: row.lease }, signal));
}
function terminal(state) { return ["done", "failed", "rejected", "released", "expired", "superseded"].includes(state); }
async function recover(pool, input) {
  const rows = listCapacity(pool.local, { worker: input.worker });
  for (const row of rows) {
    if (row.state === "reserved") {
      const client = resolveCall(pool, row);
      if (client === undefined) continue;
      const sid = row.authority === pool.local.authority ? row.localSid : row.remoteSid;
      if (!sid) continue;
      try {
        const options = row.board === null ? { kind: "work" } : { board: row.board };
        const result = client ? await remoteCall(pool, client, row.rid, "claim", { sid, options }, input.signal) : await localClaim(pool.local, sid, row.rid, options);
        const lease = outcomeOf(result);
        if (lease) {
          if (lease.sid !== sid || lease.mid === undefined) continue;
          bindCapacity(pool.local, { worker: row.worker, rid: row.rid, authority: row.authority, lease });
          pool.dispatched.add(row.rid);
          return { state: "claimed", kind: "work", rid: row.rid, authority: row.authority, board: row.board, lease };
        }
        else resolveCapacity(pool.local, { worker: row.worker, rid: row.rid, proof: { kind: "claim", rid: row.rid, authority: row.authority, outcome: "empty" } });
      } catch (error) {
        if (error instanceof Fault && error.code === "rate") return { state: "rate" };
        if (error instanceof Fault && ["timeout", "uncertain", "unavailable"].includes(error.code)) continue;
        if (error instanceof Fault && ["full", "busy", "board"].includes(error.code)) {
          resolveCapacity(pool.local, { worker: row.worker, rid: row.rid, proof: { kind: "claim", rid: row.rid, authority: row.authority, outcome: "refused" } });
        }
        else throw error;
      }
    } else if (row.state === "held") {
      try {
        if (row.settleRid && row.settleOutcome) {
          const client = resolveCall(pool, row);
          const sid = row.authority === pool.local.authority ? row.localSid : row.remoteSid;
          if (client !== undefined && sid) {
            const op = row.settleOutcome === "release" ? "release" : "ack";
            const args = op === "release" ? { sid, lease: row.lease } : { sid, lease: row.lease, outcome: row.settleOutcome };
            if (client) await remoteCall(pool, client, row.settleRid, op, args);
            else await dispatchLocalPool(pool.local, { rid: row.settleRid, op, args });
            resolveCapacity(pool.local, { worker: row.worker, rid: row.rid, proof: { kind: "attempt", rid: row.rid, authority: row.authority, mid: row.mid, lease: row.lease, epoch: row.epoch, state: row.settleOutcome === "release" ? "released" : row.settleOutcome } });
            pool.dispatched.delete(row.rid);
            continue;
          }
        }
        const status = await attempt(pool, row, input.signal);
        if (status && terminal(status.state) && status.mid === row.mid && status.lease === row.lease && status.epoch === row.epoch) {
          resolveCapacity(pool.local, { worker: row.worker, rid: row.rid, proof: { kind: "attempt", rid: row.rid, authority: row.authority, mid: row.mid, lease: row.lease, epoch: row.epoch, state: status.state } });
          pool.dispatched.delete(row.rid);
          continue;
        }
        if (!status || status.state !== "live" || status.mid !== row.mid || status.lease !== row.lease || status.epoch !== row.epoch || status.worker !== row.worker) continue;
        if (pool.dispatched.has(row.rid)) continue;
        const sid = row.authority === pool.local.authority ? row.localSid : row.remoteSid;
        if (!sid || status.sid !== sid) continue;
        const client = resolveCall(pool, row);
        if (client === undefined) continue;
        const options = row.board === null ? { kind: "work" } : { board: row.board };
        const result = client ? await remoteCall(pool, client, row.rid, "claim", { sid, options }, input.signal) : await localClaim(pool.local, sid, row.rid, options);
        const lease = outcomeOf(result);
        if (!lease || lease.mid !== row.mid || lease.id !== row.lease || lease.epoch !== row.epoch || lease.sid !== sid) continue;
        pool.dispatched.add(row.rid);
        return { state: "claimed", kind: "work", rid: row.rid, authority: row.authority, board: row.board, lease };
      } catch (error) {
        if (error instanceof Fault && error.code === "rate") return { state: "rate" };
        if (!(error instanceof Fault && ["timeout", "uncertain", "unavailable"].includes(error.code))) throw error;
      }
    }
  }
}

async function reconcileLaunches(pool) {
  for (const row of listLaunches(pool.local, { activeOnly: true })) {
    let current = row;
    const identity = row.handle ? await reconcileHandle(row.handle) : null;
    if (row.handle && identity === false) current = updateLaunch(pool.local, { id: row.id, from: row.state, to: "exited", handle: row.handle, exitCode: null, signal: null });
    else if (identity === true && row.worker && row.sid && Number.isSafeInteger(row.epoch)) {
      if (row.state === "unknown") current = updateLaunch(pool.local, { id: row.id, from: "unknown", to: "running", handle: row.handle, ready: { worker: row.worker, sid: row.sid, epoch: row.epoch, nonce: row.handle.nonce, caps: row.capabilities } });
    } else if ((row.state === "starting" || row.state === "running") && row.handle) current = updateLaunch(pool.local, { id: row.id, from: row.state, to: "unknown", handle: row.handle });
    pool.launchRows.set(row.id, current);
  }
}

export function createPool(options) {
  validateOptions(options);
  if (pools.has(options.local)) fail("active", "A Pool already owns this local store");
  const pool = { ...options, storeRoot: relayRoot(options.local), closed: false, sourceCursor: 0, loops: new Set(), loopTasks: new Set(), children: new Map(), launchRows: new Map(), pendingMessages: new Map(), claiming: new Set(), dispatched: new Set(), authority: options.local.authority };
  pool.abort = new AbortController();
  pools.set(options.local, pool);
  pool.startupError = null;
  pool.ready = reconcileLaunches(pool).catch((error) => { pool.startupError = error; });
  return Object.freeze({
    claim: (input) => claimPool(pool, input),
    settle: (input) => settlePool(pool, input),
    start: (input) => startPool(pool, input),
    ensureCapacity: (input) => ensureCapacity(pool, input),
    close: () => closePool(pool),
  });
}

async function claimPool(pool, input, signal = pool.abort.signal) {
  if (pool.closed) fail("unavailable", "Pool is closed");
  if (!object(input) || typeof input.worker !== "string" || typeof input.localSid !== "string" || input.hubSid !== undefined && typeof input.hubSid !== "string") fail("input", "Pool worker input is invalid");
  if (pool.claiming.has(input.worker)) return null;
  pool.claiming.add(input.worker);
  try { return await claimWorker(pool, input, signal); }
  finally { pool.claiming.delete(input.worker); }
}

async function claimWorker(pool, input, signal) {
  const pending = pool.pendingMessages.get(input.worker);
  if (pending) {
    const result = await retryPendingMessage(pool, pending, signal);
    if (result.state === "rate") return result;
    if (result.state !== "empty" && result.state !== "skipped") return result;
  }
  const active = listCapacity(pool.local, { worker: input.worker });
  if (active.length) {
    const row = active[0];
    return row.state === "reserved" ? { state: "uncertain", rid: row.rid, authority: row.authority, board: row.board, mid: row.mid, lease: row.lease } : null;
  }
  return onePass(pool, input, signal);
}

async function settlePool(pool, input) {
  if (pool.closed) fail("unavailable", "Pool is closed");
  if (!object(input) || typeof input.worker !== "string" || !object(input.item) || input.item.state !== "claimed" || !["done", "failed", "rejected", "release"].includes(input.outcome)) fail("input", "Pool settlement is invalid");
  const item = input.item; const client = authorityClient(pool, item.authority);
  if (client === undefined || item.kind !== "work") fail("input", "Only reserved work uses Pool settlement");
  const active = listCapacity(pool.local, { worker: input.worker }).find((row) => row.rid === item.rid && row.authority === item.authority && row.lease === item.lease.id);
  if (!active) fail("lease", "Pool reservation is unavailable");
  const expectedSid = active.authority === pool.local.authority ? active.localSid : active.remoteSid;
  if (active.state !== "held" || active.board !== item.board || active.mid !== item.lease.mid || active.epoch !== item.lease.epoch || item.lease.sid !== expectedSid || item.lease.id !== active.lease) fail("lease", "Pool settlement does not match its saved reservation");
  const settleRid = active.settleRid ?? rid();
  beginCapacitySettlement(pool.local, { worker: input.worker, rid: item.rid, authority: item.authority, settleRid, outcome: input.outcome });
  try {
    const args = input.outcome === "release" ? { sid: item.lease.sid, lease: item.lease.id } : { sid: item.lease.sid, lease: item.lease.id, outcome: input.outcome };
    const result = client ? outcomeOf(await remoteCall(pool, client, settleRid, input.outcome === "release" ? "release" : "ack", args)) : outcomeOf(dispatchLocalPool(pool.local, { rid: settleRid, op: input.outcome === "release" ? "release" : "ack", args }));
    resolveCapacity(pool.local, { worker: input.worker, rid: item.rid, proof: { kind: "attempt", rid: item.rid, authority: item.authority, mid: item.lease.mid, lease: item.lease.id, epoch: item.lease.epoch, state: input.outcome === "release" ? "released" : input.outcome } });
    pool.dispatched.delete(item.rid);
    return { state: "settled", receipt: result };
  } catch (error) {
    if (error instanceof Fault && ["timeout", "uncertain", "unavailable"].includes(error.code)) return { state: "uncertain", rid: settleRid, authority: item.authority, mid: item.lease.mid, lease: item.lease.id };
    throw error;
  }
}

async function startPool(pool, input) {
  if (pool.closed) fail("unavailable", "Pool is closed");
  if (!object(input) || typeof input.worker !== "string" || typeof input.localSid !== "string" || !(input.signal instanceof AbortSignal) || typeof input.execute !== "function") fail("input", "Pool worker input is invalid");
  await pool.ready;
  if (pool.startupError) throw pool.startupError;
  if (pool.loops.has(input.worker)) fail("active", "Worker loop is already active");
  const child = [...pool.children.values()].find((entry) => entry.record.worker === input.worker);
  const signal = AbortSignal.any([input.signal, pool.abort.signal, ...(child ? [child.abort.signal] : [])]);
  const workerInput = { ...input, signal };
  const loop = (async () => {
    let delay = pool.pollMs;
    while (!pool.closed && !signal.aborted) {
      try {
        let item = await recover(pool, workerInput);
        if (item?.state === "rate") { delay = Math.min(pool.maxBackoffMs, Math.max(pool.minBackoffMs, delay * 2)); await wait(randomWait(delay, pool.maxBackoffMs), signal); continue; }
        if (!item && listCapacity(pool.local, { worker: input.worker }).length) {
          delay = Math.min(pool.maxBackoffMs, Math.max(pool.minBackoffMs, delay * 2));
          await wait(randomWait(delay, pool.maxBackoffMs), signal);
          continue;
        }
        item ??= await claimPool(pool, workerInput, signal);
        if (item?.state === "rate") { delay = Math.min(pool.maxBackoffMs, Math.max(pool.minBackoffMs, delay * 2)); await wait(randomWait(delay, pool.maxBackoffMs), signal); continue; }
        if (!item) { delay = pool.pollMs; await wait(randomWait(delay, Math.min(pool.maxBackoffMs, Math.max(delay, pool.minBackoffMs))), signal); continue; }
        if (item.state === "uncertain") { delay = Math.min(pool.maxBackoffMs, Math.max(pool.minBackoffMs, delay * 2)); await wait(randomWait(delay, pool.maxBackoffMs), signal); continue; }
        if (signal.aborted || pool.closed) {
          if (item.kind === "work") await settlePool(pool, { worker: input.worker, item, outcome: "release" });
          else await settleAddressedUntilKnown(pool, item, "release");
          break;
        }
        if (item.kind === "work") pool.dispatched.add(item.rid);
        delay = pool.pollMs;
        let result;
        try {
          result = await executeLaunched(pool, input.worker, item, signal) ?? await input.execute(item, signal);
          if (!["done", "failed", "rejected", "release"].includes(result)) fail("input", "Worker returned an invalid outcome");
        }
        catch (error) {
          try {
            if (item.kind === "work") await settlePool(pool, { worker: input.worker, item, outcome: "release" });
            else await settleAddressedUntilKnown(pool, item, "release");
          } catch (cleanup) {
            if (error && typeof error === "object") {
              try { Object.defineProperty(error, "cleanupError", { value: cleanup, enumerable: false }); } catch {}
            }
          }
          throw error;
        }
        if (item.kind === "work") {
          const settled = await settlePool(pool, { worker: input.worker, item, outcome: result });
          if (settled.state === "uncertain") { await wait(pool.minBackoffMs, signal); continue; }
        } else await settleAddressedUntilKnown(pool, item, result);
      } catch (error) {
        if (signal.aborted || pool.closed) break;
        if (!(error instanceof Fault && ["timeout", "uncertain", "unavailable", "busy", "full"].includes(error.code))) throw error;
        delay = Math.min(pool.maxBackoffMs, Math.max(pool.minBackoffMs, delay * 2));
        await wait(randomWait(delay, pool.maxBackoffMs), signal).catch(() => {});
      }
    }
  })();
  pool.loops.add(input.worker);
  pool.loopTasks.add(loop);
  try { await loop; } finally { pool.loops.delete(input.worker); pool.loopTasks.delete(loop); }
}

async function settleAddressed(pool, item, outcome, requestId = rid()) {
  if (!["done", "failed", "rejected", "release"].includes(outcome)) fail("input", "Worker returned an invalid outcome");
  const client = authorityClient(pool, item.authority);
  if (client === undefined) return;
  const args = outcome === "release" ? { sid: item.lease.sid, lease: item.lease.id } : { sid: item.lease.sid, lease: item.lease.id, outcome };
  if (client) await remoteCall(pool, client, requestId, outcome === "release" ? "release" : "ack", args);
  else await dispatchLocalPool(pool.local, { rid: requestId, op: outcome === "release" ? "release" : "ack", args });
}

async function settleAddressedUntilKnown(pool, item, outcome) {
  const requestId = rid();
  let delayMs = pool.minBackoffMs;
  for (;;) {
    try { return await settleAddressed(pool, item, outcome, requestId); }
    catch (error) {
      if (!(error instanceof Fault && ["timeout", "uncertain", "unavailable"].includes(error.code))) throw error;
      await wait(randomWait(delayMs, pool.maxBackoffMs), pool.abort.signal);
      delayMs = Math.min(pool.maxBackoffMs, Math.max(pool.minBackoffMs, delayMs * 2));
    }
  }
}

function recipeHash(launch) {
  const json = JSON.stringify({ runtime: launch.runtime, executable: launch.executable, args: launch.args, cwd: launch.cwd, capabilities: [...launch.capabilities].sort() });
  return createHash("sha256").update(json).digest("hex");
}
function childEnv() {
  const env = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
function parseFrame(line, max) {
  if (!line.length || line.length > max || line.includes("\r")) fail("protocol", "Child protocol frame is invalid");
  const frame = parseJsonStrict(line, max);
  if (!object(frame)) fail("protocol", "Child protocol frame is invalid");
  return frame;
}
async function writeChildFrame(child, line, max) {
  const frame = `${line}\n`;
  if (Buffer.byteLength(line) > max) fail("protocol", "Child input frame exceeds its limit");
  const input = child.stdin;
  if (input.destroyed || input.writableEnded || !input.writable) fail("unavailable", "Child input is closed");
  let accepted;
  try { accepted = input.write(frame); }
  catch { fail("unavailable", "Child input write failed"); }
  if (accepted) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { input.removeListener("drain", drained); input.removeListener("error", failed); input.removeListener("close", closed); };
    const drained = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Fault("unavailable", "Child input write failed")); };
    const closed = () => { cleanup(); reject(new Fault("unavailable", "Child input closed before draining")); };
    input.once("drain", drained); input.once("error", failed); input.once("close", closed);
  });
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function launchOne(pool, config, primeSid, demand, readySpare) {
  if (process.platform !== "linux") fail("unavailable", "Native process reconciliation is supported only on Linux");
  const executable = resolve(config.executable); const cwd = resolve(config.cwd);
  const [bin, dir] = await Promise.all([lstat(executable).catch(() => null), lstat(cwd).catch(() => null)]);
  if (!bin?.isFile() || bin.isSymbolicLink() || !dir?.isDirectory() || dir.isSymbolicLink()) fail("denied", "Configured launch recipe is unavailable");
  const requestId = rid();
  const row = reserveLaunch(pool.local, { primeSid, runtime: config.runtime, requestId, recipeHash: recipeHash(config), capabilities: config.capabilities, demand, readySpare, maxChildren: config.maxChildren });
  if (row.state !== "starting") return row;
  pool.launchRows.set(row.id, row);
  const nonce = randomBytes(24).toString("base64url");
  let child;
  try { child = spawn(executable, config.args, { cwd, env: { ...childEnv(), RELAY_LAUNCH_NONCE: nonce }, shell: false, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (error) {
    return updateLaunch(pool.local, { id: row.id, from: "starting", to: "failed", reason: "spawn" });
  }
  let lineBuffer = Buffer.alloc(0); let settled = false; let readySeen = false; let resultWaiter = null; let readyResolve; let readyReject; let currentHandle = null; let spawnError = null;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  void ready.catch(() => {});
  const protocolFailure = (error) => {
    readyReject(error);
    if (resultWaiter) { const rejectResult = resultWaiter.reject; resultWaiter = null; rejectResult(error); }
    const owned = pool.children.get(row.id);
    if (owned?.record.state === "running") {
      const unknown = updateLaunch(pool.local, { id: row.id, from: "running", to: "unknown", ...(currentHandle ? { handle: currentHandle } : {}) });
      owned.record = unknown; pool.launchRows.set(row.id, unknown); owned.abort.abort();
    }
  };
  const handlePromise = (async () => {
    for (let i = 0; i < 50; i++) {
      const processStartId = await readLinuxProcessStart(child.pid);
      if (processStartId) {
        const handle = { platform: process.platform, pid: child.pid, processStart: processStartId, nonce };
        if (await handleMatches(handle)) return handle;
      }
      await delay(10);
    }
    return null;
  })();
  child.stderr.on("data", () => {});
  child.stdout.on("data", (chunk) => {
    if (pool.closed) return;
    lineBuffer = Buffer.concat([lineBuffer, chunk]);
    let newline;
    while ((newline = lineBuffer.indexOf(10)) >= 0) {
      const bytes = lineBuffer.subarray(0, newline); lineBuffer = lineBuffer.subarray(newline + 1);
      try {
        if (!bytes.length || bytes.length > 4096) fail("protocol", "Child output exceeds its frame limit");
        const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const frame = parseFrame(line, 4096);
        if (!readySeen && frame.event === "ready" && Object.keys(frame).sort().join(",") === "caps,epoch,event,id,nonce,sid,v,worker" && frame.v === 1 && frame.id === row.id && frame.nonce === nonce) { readySeen = true; readyResolve(frame); }
        else if (readySeen && resultWaiter && frame.event === "result" && Object.keys(frame).sort().join(",") === "event,id,lease,nonce,outcome,v" && frame.v === 1 && frame.id === row.id && frame.nonce === nonce && frame.lease === resultWaiter.lease && ["done", "failed", "rejected", "release"].includes(frame.outcome)) { const resolveResult = resultWaiter.resolve; resultWaiter = null; resolveResult(frame.outcome); }
        else {
          const error = new Fault("protocol", "Child frame is not recognized");
          protocolFailure(error);
        }
      } catch (error) {
        protocolFailure(error);
      }
    }
    if (lineBuffer.length > 4096) {
      protocolFailure(new Fault("protocol", "Child output exceeds its frame limit"));
    }
  });
  child.once("error", (error) => { spawnError = error; protocolFailure(error); });
  child.stdin.on("error", protocolFailure);
  child.once("exit", (code, signal) => {
    if (lineBuffer.length) protocolFailure(new Fault("protocol", "Child ended with an incomplete frame"));
    if (!settled) readyReject(new Fault("unavailable", "Child exited before readiness"));
    resultWaiter?.reject(new Fault("unavailable", "Child exited during a task")); resultWaiter = null;
    pool.children.get(row.id)?.abort.abort();
    void handlePromise.then(async (handle) => {
      const current = pool.launchRows.get(row.id);
      if (handle && current && ["starting", "running", "unknown"].includes(current.state)) {
        const exited = updateLaunch(pool.local, { id: row.id, from: current.state, to: "exited", handle, exitCode: code, signal });
        pool.launchRows.set(row.id, exited);
        const owned = pool.children.get(row.id);
        if (owned) owned.record = exited;
      }
    }).catch(() => {});
  });
  const timer = setTimeout(() => readyReject(new Fault("timeout", "Child readiness timed out")), config.readyTimeoutMs);
  try {
    const bootstrap = JSON.stringify({ v: 1, event: "bootstrap", id: row.id, nonce, device: pool.local.device, runtime: config.runtime, capabilities: config.capabilities, storeRoot: pool.storeRoot });
    if (Buffer.byteLength(bootstrap) > 8192) fail("protocol", "Bootstrap frame is too large");
    await writeChildFrame(child, bootstrap, 8192);
    const [frame, handle] = await Promise.all([ready, handlePromise]);
    currentHandle = handle;
    if (!handle || !Array.isArray(frame.caps) || frame.caps.length > 16 || new Set(frame.caps).size !== frame.caps.length || [...frame.caps].sort().join("\0") !== [...config.capabilities].sort().join("\0") || !Number.isSafeInteger(frame.epoch) || frame.epoch < 1 || typeof frame.sid !== "string" || typeof frame.worker !== "string") fail("protocol", "Child readiness frame is invalid");
    const running = updateLaunch(pool.local, { id: row.id, from: "starting", to: "running", handle, ready: { worker: frame.worker, sid: frame.sid, epoch: frame.epoch, nonce: frame.nonce, caps: frame.caps } });
    settled = true;
    const childAbort = new AbortController();
    pool.children.set(row.id, {
      child, handle, nonce, record: running, config, abort: childAbort,
      sendFrame(frameValue) { return writeChildFrame(child, JSON.stringify(frameValue), LIMITS.payloadBytes + 1024); },
      cancelResult(error) {
        if (!resultWaiter) return;
        const rejectResult = resultWaiter.reject; resultWaiter = null; rejectResult(error);
      },
      waitResult(lease, signal) {
        return new Promise((resolveResult, rejectResult) => {
          if (resultWaiter) { rejectResult(new Fault("active", "Child already has an active task")); return; }
          let settledResult = false;
          const finish = (settle, value) => {
            if (settledResult) return;
            settledResult = true;
            signal.removeEventListener("abort", onAbort);
            if (resultWaiter?.lease === lease) resultWaiter = null;
            settle(value);
          };
          const onAbort = () => finish(rejectResult, new Fault("unavailable", "Worker task was cancelled"));
          resultWaiter = { lease, resolve: (value) => finish(resolveResult, value), reject: (error) => finish(rejectResult, error) };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    });
    pool.launchRows.set(row.id, running);
    return running;
  } catch (error) {
    try {
      const handle = await handlePromise;
      const current = pool.launchRows.get(row.id);
      if (current?.state === "starting" && spawnError) {
        const failed = updateLaunch(pool.local, { id: row.id, from: "starting", to: "failed", reason: "spawn" }); pool.launchRows.set(row.id, failed);
      } else if (current?.state === "starting" && handle) {
        let identity = await reconcileHandle(handle);
        if (identity === true) {
          child.kill("SIGTERM");
          await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(1000)]);
          identity = await reconcileHandle(handle);
          if (identity === true) {
            child.kill("SIGKILL");
            await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(1000)]);
            identity = await reconcileHandle(handle);
          }
        }
        const next = identity === false
          ? updateLaunch(pool.local, { id: row.id, from: "starting", to: "exited", handle, exitCode: null, signal: null })
          : updateLaunch(pool.local, { id: row.id, from: "starting", to: "unknown", handle });
        pool.launchRows.set(row.id, next);
      }
      // Without a verified handle, leave the starting reservation active. CORE
      // cannot record unknown without a handle despite the optional declaration.
    } catch (cleanupError) {
      if (error && typeof error === "object") {
        try { Object.defineProperty(error, "cleanupError", { value: cleanupError, enumerable: false }); } catch {}
      }
    }
    throw error;
  } finally { clearTimeout(timer); }
}

async function executeLaunched(pool, worker, item, signal) {
  const child = [...pool.children.values()].find((entry) => entry.record.worker === worker);
  if (!child) return null;
  if (child.record.state !== "running" || !await handleMatches(child.handle) || child.handle.nonce !== child.nonce) fail("unavailable", "Owned worker process cannot be verified");
  const frame = { v: 1, event: "execute", id: child.record.id, nonce: child.nonce, authority: item.authority, board: item.board, lease: item.lease };
  if (Buffer.byteLength(JSON.stringify(frame)) > LIMITS.payloadBytes + 1024) fail("data", "Launch task frame is too large");
  const result = child.waitResult(item.lease.id, signal);
  try { await child.sendFrame(frame); }
  catch (error) { child.cancelResult(error); await result.catch(() => {}); throw error; }
  return result;
}

async function ensureCapacity(pool, input) {
  if (pool.closed) fail("unavailable", "Pool is closed");
  if (!object(input) || typeof input.primeSid !== "string" || !Number.isInteger(input.demand) || input.demand < 0 || input.demand > 512 || !Number.isInteger(input.readySpare) || input.readySpare < 0 || input.readySpare > 512) fail("input", "Capacity request is invalid");
  await pool.ready;
  if (pool.startupError) throw pool.startupError;
  if (!pool.launch || input.demand <= input.readySpare) return null;
  const active = listLaunches(pool.local, { activeOnly: true });
  if (active.length >= pool.launch.maxChildren) return null;
  const readyWorkers = new Set([...pool.loops].filter((worker) => /:\d{3,32}$/.test(worker)));
  const used = readyWorkers.size + active.filter((row) => !readyWorkers.has(row.worker)).length;
  if (used >= pool.maxAgents) return null;
  return launchOne(pool, pool.launch, input.primeSid, input.demand, input.readySpare);
}

async function closePool(pool) {
  if (pool.closed) return; pool.closed = true;
  pool.abort.abort();
  await pool.ready;
  let timer;
  await Promise.race([Promise.allSettled([...pool.loopTasks]), new Promise((resolve) => { timer = setTimeout(resolve, 1000); })]);
  clearTimeout(timer);
  const failures = [];
  for (const childRecord of pool.children.values()) {
    if (childRecord.handle.nonce !== childRecord.nonce || childRecord.handle.pid !== childRecord.child.pid) continue;
    const identity = await reconcileHandle(childRecord.handle);
    if (identity === false) {
      if (childRecord.record.state === "running") {
        const exited = updateLaunch(pool.local, { id: childRecord.record.id, from: "running", to: "exited", handle: childRecord.handle, exitCode: null, signal: null });
        childRecord.record = exited; pool.launchRows.set(exited.id, exited);
      }
      continue;
    }
    if (identity !== true) {
      if (childRecord.record.state === "running") {
        const unknown = updateLaunch(pool.local, { id: childRecord.record.id, from: "running", to: "unknown", handle: childRecord.handle });
        childRecord.record = unknown; pool.launchRows.set(unknown.id, unknown);
      }
      failures.push(new Fault("unavailable", "Owned worker process identity is unresolved"));
      continue;
    }
    childRecord.child.kill("SIGTERM");
    await Promise.race([new Promise((resolveExit) => childRecord.child.once("exit", resolveExit)), delay(1000)]);
    if (await handleMatches(childRecord.handle)) {
      childRecord.child.kill("SIGKILL");
      await Promise.race([new Promise((resolveExit) => childRecord.child.once("exit", resolveExit)), delay(1000)]);
      if (await handleMatches(childRecord.handle)) {
        try {
          if (childRecord.record.state !== "running") throw new Fault("unavailable", "Owned worker state is already ambiguous");
          const unknown = updateLaunch(pool.local, { id: childRecord.record.id, from: "running", to: "unknown", handle: childRecord.handle });
          childRecord.record = unknown; pool.launchRows.set(unknown.id, unknown);
        } catch (error) { if (childRecord.record.state === "running") failures.push(error); }
        failures.push(new Fault("unavailable", "Owned worker process did not stop"));
      }
    }
  }
  await Promise.allSettled([...pool.loopTasks]);
  pool.children.clear(); pools.delete(pool.local);
  if (failures.length) {
    const error = new Fault("unavailable", "Pool cleanup did not stop every owned process");
    Object.defineProperty(error, "cleanupErrors", { value: failures, enumerable: false });
    throw error;
  }
}
