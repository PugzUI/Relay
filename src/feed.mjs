import { randomUUID } from "node:crypto";
import { Fault } from "./fault.mjs";
import { LIMITS, canonicalJson } from "./validate.mjs";

function cursor(value) {
  if (typeof value !== "string" || value.length > 700 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Fault("cursor", "Invalid feed cursor");
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length > 512 || bytes.toString("base64url") !== value) throw new Error();
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(["authority", "scope", "seq", "stream", "v"]) || parsed.v !== 1 || typeof parsed.authority !== "string" || typeof parsed.stream !== "string" || typeof parsed.scope !== "string" || !Number.isSafeInteger(parsed.seq)) throw new Error();
    return parsed;
  } catch { throw new Fault("cursor", "Invalid feed cursor"); }
}
function encode(value) { return Buffer.from(canonicalJson(value, 512).json).toString("base64url"); }

export function createFeed(relay) {
  const stream = randomUUID();
  const ring = [];
  const waiters = new Set();
  let closed = false;
  let active = 0;
  let lastSeq = 0;
  let droppedThrough = 0;
  let lastPruned = Number(JSON.parse(relay._store.db.prepare("SELECT value FROM meta WHERE key='auditPruned'").get()?.value ?? "0"));
  let pollTimer;
  const signalWaiters = () => { for (const wake of waiters) wake(); waiters.clear(); };
  const push = (event) => {
    ring.push(event);
    if (ring.length > LIMITS.feedEvents) {
      const removed = ring.splice(0, ring.length - LIMITS.feedEvents);
      droppedThrough = Math.max(droppedThrough, removed.at(-1).seq);
    }
    signalWaiters();
  };
  const poll = () => {
    if (closed) return;
    try {
      const pruned = Number(JSON.parse(relay._store.db.prepare("SELECT value FROM meta WHERE key='auditPruned'").get()?.value ?? "0"));
      if (pruned !== lastPruned) {
        lastPruned = pruned;
        const current = Number(relay._store.db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM audit").get().n);
        droppedThrough = Math.max(droppedThrough, current);
        ring.length = 0;
        lastSeq = current;
        signalWaiters();
      }
      const rows = relay._store.db.prepare("SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT 128").all(lastSeq);
      for (const row of rows) {
        lastSeq = row.seq;
        if (!["post", "claim", "release", "ack", "refusal"].includes(row.type)) continue;
        const event = { v: 1, stream, seq: row.seq, time: row.time, type: row.type, from: row.source ?? row.worker ?? null,
          to: row.target ?? row.worker ?? null, mid: row.mid, state: row.state ?? null,
          code: row.code, committed: row.type !== "refusal" };
        if (Buffer.byteLength(canonicalJson(event).json) > LIMITS.eventBytes) continue;
        push(event);
      }
    } catch { /* a closed store is surfaced as feed closure on the next request */ }
    if (!closed) pollTimer = setTimeout(poll, 100);
  };
  poll();

  return {
    snapshot(options = {}, authorization) {
      const scope = authorization?.scopeKey ?? "local";
      return relay.snapshot(options, stream, scope);
    },
    subscribe({ cursor: value, authorization, signal }) {
      const scope = authorization?.scopeKey ?? "local";
      const start = cursor(value);
      if (start.authority !== relay.authority) throw new Fault("cursor", "Feed authority changed");
      if (start.scope !== scope) throw new Fault("cursor", "Feed permission scope changed");
      if (start.stream !== stream) throw new Fault("reset", "Feed instance changed");
      const current = Number(relay._store.db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM audit").get().n);
      if (start.seq > current) throw new Fault("cursor", "Feed cursor is ahead of the store");
      if (start.seq < droppedThrough) throw new Fault("reset", "Feed cursor is older than retained events");
      if (active >= LIMITS.feedStreams) throw new Fault("full", "Feed stream capacity is full");
      active++;
      let sequence = start.seq;
      return (async function* () {
        let sinceKeepalive = Date.now();
        try {
          while (!closed && !signal?.aborted) {
            if (sequence < droppedThrough) {
              yield { event: "reset", cursor: encode({ v: 1, authority: relay.authority, stream, seq: lastSeq, scope }), reason: "overflow" };
              return;
            }
            const ready = ring.filter((item) => item.seq > sequence);
            if (ready.length) {
              for (const data of ready) {
                sequence = data.seq;
                const next = encode({ v: 1, authority: relay.authority, stream, seq: sequence, scope });
                yield { event: "delta", cursor: next, data };
              }
              sinceKeepalive = Date.now();
              continue;
            }
            if (Date.now() - sinceKeepalive >= LIMITS.keepaliveMs) {
              sinceKeepalive = Date.now();
              yield { event: "keepalive", time: Date.now() };
              continue;
            }
            await new Promise((resolve) => {
              const wake = () => { clearTimeout(timeout); waiters.delete(wake); signal?.removeEventListener("abort", wake); resolve(); };
              const timeout = setTimeout(wake, 250);
              waiters.add(wake);
              signal?.addEventListener("abort", wake, { once: true });
            });
          }
        } finally { active--; }
      })();
    },
    close() { if (!closed) { closed = true; clearTimeout(pollTimer); signalWaiters(); } },
  };
}
