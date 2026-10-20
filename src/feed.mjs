import { randomUUID } from "node:crypto";
import { Fault } from "./fault.mjs";
import { LIMITS, canonicalJson } from "./validate.mjs";

const FEED_EVENT_TYPES = new Set(["post", "claim", "release", "ack", "refusal"]);
const POLL_INTERVAL_MS = 100;
const WAKE_INTERVAL_MS = 250;
const RESET = Symbol("feed reset");

/** Decode a feed cursor, refusing every payload that is not canonical. */
function cursor(value) {
  if (typeof value !== "string" || value.length > 700 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Fault("cursor", "Invalid feed cursor");
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length > 512 || bytes.toString("base64url") !== value) {
      throw new Error("Feed cursor is not canonical base64url");
    }
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (
      JSON.stringify(Object.keys(parsed).sort()) !==
        JSON.stringify(["authority", "scope", "seq", "stream", "v"]) ||
      parsed.v !== 1 ||
      typeof parsed.authority !== "string" ||
      typeof parsed.stream !== "string" ||
      typeof parsed.scope !== "string" ||
      !Number.isSafeInteger(parsed.seq)
    ) {
      throw new Error("Feed cursor payload is not a cursor shape");
    }
    return parsed;
  } catch {
    throw new Fault("cursor", "Invalid feed cursor");
  }
}

/** Encode a feed cursor as canonical base64url. */
function encode(value) {
  return Buffer.from(canonicalJson(value, 512).json).toString("base64url");
}

/** Read the audit prune watermark that decides whether retained events were dropped. */
function readPruned(relay) {
  const row = relay._store.db.prepare("SELECT value FROM meta WHERE key='auditPruned'").get();
  return Number(JSON.parse(row?.value ?? "0"));
}

/** Read the newest committed audit sequence. */
function readMaxSeq(relay) {
  return Number(relay._store.db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM audit").get().n);
}

/** Hold the mutable feed state that the polling loop and the subscriptions share. */
function createState(relay) {
  return {
    relay,
    stream: randomUUID(),
    ring: [],
    waiters: new Set(),
    closed: false,
    active: 0,
    lastSeq: 0,
    droppedThrough: 0,
    lastPruned: readPruned(relay),
    pollTimer: undefined,
  };
}

/** Wake every parked subscription so it can re-read the ring. */
function signalWaiters(state) {
  for (const wake of state.waiters) wake();
  state.waiters.clear();
}

/** Retain a committed event, recording the point past which events were dropped. */
function push(state, event) {
  state.ring.push(event);
  if (state.ring.length > LIMITS.feedEvents) {
    const removed = state.ring.splice(0, state.ring.length - LIMITS.feedEvents);
    state.droppedThrough = Math.max(state.droppedThrough, removed.at(-1).seq);
  }
  signalWaiters(state);
}

/** Project one committed audit row into a feed event, or null when it is not publishable. */
function auditEvent(state, row) {
  if (!FEED_EVENT_TYPES.has(row.type)) return null;
  const event = {
    v: 1,
    stream: state.stream,
    seq: row.seq,
    time: row.time,
    type: row.type,
    from: row.source ?? row.worker ?? null,
    to: row.target ?? row.worker ?? null,
    mid: row.mid,
    state: row.state ?? null,
    code: row.code,
    committed: row.type !== "refusal",
  };
  if (Buffer.byteLength(canonicalJson(event).json) > LIMITS.eventBytes) return null;
  return event;
}

/** Drain newly committed audit rows into the retained ring. */
function collectRows(state) {
  const rows = state.relay._store.db
    .prepare("SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT 128")
    .all(state.lastSeq);
  for (const row of rows) {
    state.lastSeq = row.seq;
    const event = auditEvent(state, row);
    if (event) push(state, event);
  }
}

/** Discard retained events when the store pruned the audit log underneath the feed. */
function syncPruned(state) {
  const pruned = readPruned(state.relay);
  if (pruned === state.lastPruned) return;
  state.lastPruned = pruned;
  const current = readMaxSeq(state.relay);
  state.droppedThrough = Math.max(state.droppedThrough, current);
  state.ring.length = 0;
  state.lastSeq = current;
  signalWaiters(state);
}

/** Poll the committed audit log for new events. */
function poll(state) {
  if (state.closed) return;
  try {
    syncPruned(state);
    collectRows(state);
  } catch {
    /* a closed store is surfaced as feed closure on the next request */
  }
  if (!state.closed) state.pollTimer = setTimeout(() => poll(state), POLL_INTERVAL_MS);
}

/** Encode the cursor that a subscriber reaches after the given sequence. */
function cursorAt(state, scope, seq) {
  return encode({ v: 1, authority: state.relay.authority, stream: state.stream, seq, scope });
}

/** Refuse a cursor that does not belong to this authority, scope, stream, or store. */
function assertCursor(state, start, scope) {
  if (start.authority !== state.relay.authority)
    throw new Fault("cursor", "Feed authority changed");
  if (start.scope !== scope) throw new Fault("cursor", "Feed permission scope changed");
  if (start.stream !== state.stream) throw new Fault("reset", "Feed instance changed");
  if (start.seq > readMaxSeq(state.relay))
    throw new Fault("cursor", "Feed cursor is ahead of the store");
  if (start.seq < state.droppedThrough) {
    throw new Fault("reset", "Feed cursor is older than retained events");
  }
}

/** Collect the retained events that follow the given sequence. */
function drainFrames(state, scope, sequence) {
  if (sequence < state.droppedThrough) return RESET;
  const ready = state.ring.filter((item) => item.seq > sequence);
  if (!ready.length) return [];
  return ready.map((data) => ({ event: "delta", cursor: cursorAt(state, scope, data.seq), data }));
}

/** Build the frame that retires a subscriber whose cursor fell behind the retained events. */
function resetFrame(state, scope) {
  return { event: "reset", cursor: cursorAt(state, scope, state.lastSeq), reason: "overflow" };
}

/** Park a subscriber until an event arrives, the feed closes, or the request aborts. */
function waitForEvent(state, signal) {
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timeout);
      state.waiters.delete(wake);
      signal?.removeEventListener("abort", wake);
      resolve();
    };
    const timeout = setTimeout(wake, WAKE_INTERVAL_MS);
    state.waiters.add(wake);
    signal?.addEventListener("abort", wake, { once: true });
  });
}

/** Yield committed events, keepalives, and the reset that retires a stale cursor. */
async function* streamEvents(state, { scope, signal, start }) {
  let sequence = start;
  let sinceKeepalive = Date.now();
  try {
    while (!state.closed && !signal?.aborted) {
      const frames = drainFrames(state, scope, sequence);
      if (frames === RESET) {
        yield resetFrame(state, scope);
        return;
      }
      if (frames.length) {
        sequence = frames.at(-1).data.seq;
        yield* frames;
        sinceKeepalive = Date.now();
        continue;
      }
      if (Date.now() - sinceKeepalive >= LIMITS.keepaliveMs) {
        sinceKeepalive = Date.now();
        yield { event: "keepalive", time: Date.now() };
        continue;
      }
      await waitForEvent(state, signal);
    }
  } finally {
    state.active--;
  }
}

/** Open a bounded subscription over the committed feed. */
function openSubscription(state, { cursor: value, authorization, signal }) {
  const scope = authorization?.scopeKey ?? "local";
  const start = cursor(value);
  assertCursor(state, start, scope);
  if (state.active >= LIMITS.feedStreams) throw new Fault("full", "Feed stream capacity is full");
  state.active++;
  return streamEvents(state, { scope, signal, start: start.seq });
}

/** Stop the polling loop and release every parked subscriber. */
function closeFeed(state) {
  if (state.closed) return;
  state.closed = true;
  clearTimeout(state.pollTimer);
  signalWaiters(state);
}

/** Create the committed event feed for a relay. */
export function createFeed(relay) {
  const state = createState(relay);
  poll(state);
  return {
    snapshot(options = {}, authorization) {
      const scope = authorization?.scopeKey ?? "local";
      return relay.snapshot(options, state.stream, scope);
    },
    subscribe(options) {
      return openSubscription(state, options);
    },
    close() {
      closeFeed(state);
    },
  };
}
