const SNAPSHOT_KEYS = [
  "v",
  "authority",
  "time",
  "cursor",
  "devices",
  "agents",
  "boards",
  "links",
  "totals",
  "visible",
  "complete",
  "next",
];
const DEVICE_KEYS = ["id", "name", "init", "authority", "receivedAt", "stale", "free"];
const AGENT_KEYS = [
  "id",
  "device",
  "runtime",
  "slot",
  "caps",
  "epoch",
  "init",
  "state",
  "assignmentCount",
  "receivedAt",
];
const BOARD_KEYS = [
  "id",
  "kind",
  "device",
  "authority",
  "inbox",
  "pending",
  "claimed",
  "terminal",
  "reported",
  "receivedAt",
];
const LINK_KEYS = ["id", "from", "to", "kind", "state", "mid", "time"];
const PAGE_KEYS = ["items", "total", "visible", "complete", "cursor", "next", "firstSeq", "pruned"];
const MESSAGE_KEYS = [
  "id",
  "seq",
  "from",
  "to",
  "board",
  "kind",
  "needs",
  "series",
  "data",
  "state",
  "init",
  "acked",
];
const FEED_TYPES = new Set(["post", "claim", "release", "ack", "refusal"]);
const MESSAGE_STATES = new Set(["pending", "claimed", "posted", "done", "failed", "rejected"]);
const AGENT_STATES = new Set(["registered", "starting", "ready", "busy", "unknown", "stale"]);
const LINK_STATES = new Set(["active", "stale", "unknown"]);
const RESET_REASONS = new Set(["old", "scope", "restart", "overflow"]);
const FAULT_CODES = new Set([
  "input",
  "data",
  "missing",
  "schema",
  "active",
  "session",
  "expired",
  "target",
  "device_conflict",
  "board",
  "key_conflict",
  "ack_conflict",
  "owner",
  "lease",
  "full",
  "busy",
  "clock",
  "storage",
  "auth",
  "denied",
  "protocol",
  "tls",
  "rpc_conflict",
  "uncertain",
  "cursor",
  "reset",
  "rate",
  "timeout",
  "unavailable",
]);
const SNAPSHOT_COLLECTIONS = { devices: 64, agents: 512, boards: 65, links: 512 };
const SNAPSHOT_COUNT_FIELDS = ["devices", "agents", "boards", "links"];
const DELTA_FRAME_KEYS = ["event", "cursor", "data"];
const DELTA_DATA_KEYS = [
  "v",
  "stream",
  "seq",
  "time",
  "type",
  "from",
  "to",
  "mid",
  "state",
  "code",
  "committed",
];
const RESET_FRAME_KEYS = ["event", "cursor", "reason"];
const KEEPALIVE_FRAME_KEYS = ["event", "time"];
const SSE_FRAME_LIMIT = 16_384;

function record(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label}: object required`);
  }
  return value;
}

function exact(value, keys, label, optional = []) {
  record(value, label);
  const allowed = new Set([...keys, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}: unknown field`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new TypeError(`${label}: missing field`);
  }
  return value;
}

function text(value, label, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label}: string required`);
  }
  return value;
}

function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new TypeError(`${label}: invalid integer`);
  return value;
}

function nullableInteger(value, label) {
  return value === null ? null : integer(value, label);
}

function countFields(value, keys, label) {
  exact(value, keys, label);
  for (const key of keys) integer(value[key], `${label}.${key}`);
  return value;
}

function canonicalKeyOrder(value) {
  if (Array.isArray(value)) return value.every(canonicalKeyOrder);
  if (value === null || typeof value !== "object") return true;
  const keys = Object.keys(value);
  return (
    keys.every((key, index) => index === 0 || keys[index - 1] < key) &&
    Object.values(value).every(canonicalKeyOrder)
  );
}

function nullableText(value, label) {
  return value === null ? null : text(value, label);
}

function decodeCursorText(token, maxBytes, label) {
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > Math.ceil((maxBytes * 4) / 3)) {
    throw new TypeError(`${label}: invalid token`);
  }
  try {
    const base64 = token
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(token.length / 4) * 4, "=");
    const binary = atob(base64);
    if (binary.length > maxBytes) throw new TypeError(`${label}: token too large`);
    const canonical = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    if (canonical !== token) throw new TypeError(`${label}: noncanonical token`);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(`${label}:`)) throw error;
    throw new TypeError(`${label}: invalid encoding`);
  }
}

function decodeCursor(token, maxBytes, keys, label) {
  text(token, label);
  const decoded = decodeCursorText(token, maxBytes, label);
  let value;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new TypeError(`${label}: invalid JSON`);
  }
  exact(value, keys, label);
  if (JSON.stringify(value) !== decoded || !canonicalKeyOrder(value)) {
    throw new TypeError(`${label}: noncanonical JSON`);
  }
  if (value.v !== 1 || !/^[a-f0-9]{64}$/.test(value.scope)) {
    throw new TypeError(`${label}: invalid version or scope`);
  }
  text(value.authority, `${label}.authority`);
  return value;
}

function feedCursor(token) {
  const value = decodeCursor(
    token,
    512,
    ["v", "authority", "stream", "seq", "scope"],
    "feed cursor",
  );
  text(value.stream, "feed cursor.stream");
  integer(value.seq, "feed cursor.seq");
  return value;
}

export function sameFeedBoundary(left, right) {
  const a = feedCursor(left);
  const b = feedCursor(right);
  return a.authority === b.authority && a.stream === b.stream && a.scope === b.scope;
}

function messageCursor(token) {
  const value = decodeCursor(
    token,
    1024,
    ["v", "authority", "scope", "filter", "boundary", "last"],
    "message cursor",
  );
  if (!/^[a-f0-9]{64}$/.test(value.filter))
    throw new TypeError("message cursor.filter: invalid hash");
  integer(value.boundary, "message cursor.boundary");
  integer(value.last, "message cursor.last");
  return value;
}

function snapshotCursor(token) {
  const value = decodeCursor(
    token,
    1024,
    ["v", "authority", "scope", "filter", "boundary", "time", "last"],
    "snapshot cursor",
  );
  if (!/^[a-f0-9]{64}$/.test(value.filter))
    throw new TypeError("snapshot cursor.filter: invalid hash");
  integer(value.boundary, "snapshot cursor.boundary");
  integer(value.time, "snapshot cursor.time");
  exact(value.last, ["agent", "link"], "snapshot cursor.last");
  for (const key of ["agent", "link"]) {
    if (value.last[key] !== null && typeof value.last[key] !== "string") {
      throw new TypeError(`snapshot cursor.last.${key}: invalid position`);
    }
  }
  return value;
}

function parseDevice(value) {
  exact(value, DEVICE_KEYS, "device");
  text(value.id, "device.id");
  text(value.name, "device.name");
  integer(value.init, "device.init");
  text(value.authority, "device.authority");
  nullableInteger(value.receivedAt, "device.receivedAt");
  if (typeof value.stale !== "boolean") throw new TypeError("device.stale: boolean required");
  nullableInteger(value.free, "device.free");
}

function parseAgent(value) {
  exact(value, AGENT_KEYS, "agent");
  for (const key of ["id", "device", "runtime", "slot"]) text(value[key], `agent.${key}`);
  integer(value.epoch, "agent.epoch");
  integer(value.init, "agent.init");
  if (!Array.isArray(value.caps) || value.caps.some((cap) => typeof cap !== "string")) {
    throw new TypeError("agent.caps: string array required");
  }
  if (!AGENT_STATES.has(value.state)) throw new TypeError("agent.state: invalid state");
  if (value.assignmentCount !== 0 && value.assignmentCount !== 1) {
    throw new TypeError("agent.assignmentCount: invalid count");
  }
  nullableInteger(value.receivedAt, "agent.receivedAt");
}

function parseBoard(value) {
  exact(value, BOARD_KEYS, "board");
  text(value.id, "board.id");
  if (value.kind !== "bounty" && value.kind !== "host")
    throw new TypeError("board.kind: invalid kind");
  nullableText(value.device, "board.device");
  text(value.authority, "board.authority");
  for (const key of ["inbox", "pending", "claimed", "terminal"])
    integer(value[key], `board.${key}`);
  if (typeof value.reported !== "boolean") throw new TypeError("board.reported: boolean required");
  nullableInteger(value.receivedAt, "board.receivedAt");
}

function parseLink(value) {
  exact(value, LINK_KEYS, "link");
  for (const key of ["id", "from", "to"]) text(value[key], `link.${key}`);
  if (!["addressed", "board", "report"].includes(value.kind) || !LINK_STATES.has(value.state)) {
    throw new TypeError("link: invalid relationship");
  }
  nullableText(value.mid, "link.mid");
  nullableInteger(value.time, "link.time");
}

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? Object.keys(value).length === value.length && value.every((entry) => isJsonValue(entry, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((entry) => isJsonValue(entry, seen));
  seen.delete(value);
  return valid;
}

function parseEnvelope(value, kind) {
  record(value, "message.data");
  const keys = Object.keys(value);
  if (kind === "msg") {
    if (
      keys.length !== 1 ||
      keys[0] !== "msg" ||
      typeof value.msg !== "string" ||
      value.msg.length === 0
    ) {
      throw new TypeError("message.data: invalid msg envelope");
    }
  } else if (keys.length !== 1 || keys[0] !== "work" || !isJsonValue(value.work)) {
    throw new TypeError("message.data: invalid work envelope");
  }
}

function snapshotCollections(value) {
  return SNAPSHOT_COUNT_FIELDS.map((field) => [field, value[field]]);
}

function parseSnapshotRows(value) {
  for (const [field, limit] of Object.entries(SNAPSHOT_COLLECTIONS)) {
    if (!Array.isArray(value[field]) || value[field].length > limit) {
      throw new TypeError("snapshot: invalid collection");
    }
  }
  value.devices.forEach(parseDevice);
  value.agents.forEach(parseAgent);
  value.boards.forEach(parseBoard);
  value.links.forEach(parseLink);
}

function assertUniqueSnapshotRows(value) {
  for (const [field, rows] of snapshotCollections(value)) {
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new TypeError(`snapshot: duplicate ${field}`);
    }
  }
}

function assertSnapshotCounts(value) {
  countFields(value.totals, SNAPSHOT_COUNT_FIELDS, "snapshot.totals");
  countFields(value.visible, SNAPSHOT_COUNT_FIELDS, "snapshot.visible");
  for (const [field, rows] of snapshotCollections(value)) {
    if (value.visible[field] !== rows.length || value.totals[field] < value.visible[field]) {
      throw new TypeError(`snapshot.${field}: inconsistent counts`);
    }
  }
}

function snapshotContinuationInvalid(value) {
  if (typeof value.complete !== "boolean") return true;
  if (value.complete) return value.next !== null;
  return typeof value.next !== "string";
}

function assertSnapshotContinuation(value, cursor) {
  if (snapshotContinuationInvalid(value)) {
    throw new TypeError("snapshot: invalid continuation");
  }
  if (value.complete) return;
  const next = snapshotCursor(value.next);
  if (
    next.authority !== value.authority ||
    next.scope !== cursor.scope ||
    next.boundary !== cursor.seq ||
    next.time !== value.time
  ) {
    throw new TypeError("snapshot: continuation boundary mismatch");
  }
}

export function parseSnapshot(input) {
  const value = exact(input, SNAPSHOT_KEYS, "snapshot");
  if (value.v !== 1) throw new TypeError("snapshot.v: unsupported version");
  text(value.authority, "snapshot.authority");
  integer(value.time, "snapshot.time");
  text(value.cursor, "snapshot.cursor");
  parseSnapshotRows(value);
  assertUniqueSnapshotRows(value);
  const cursor = feedCursor(value.cursor);
  if (cursor.authority !== value.authority)
    throw new TypeError("snapshot: feed authority mismatch");
  assertSnapshotCounts(value);
  assertSnapshotContinuation(value, cursor);
  return value;
}

function assertSamePageBoundary(page, first) {
  if (
    page.authority !== first.authority ||
    page.time !== first.time ||
    page.cursor !== first.cursor ||
    JSON.stringify(page.totals) !== JSON.stringify(first.totals)
  ) {
    throw new TypeError("snapshot: page boundary changed");
  }
}

function uniqueSnapshotRows(parsed, field) {
  const rows = parsed.flatMap((page) => page[field]);
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new TypeError(`snapshot: duplicate ${field}`);
  }
  return rows;
}

function repeatedSnapshotRows(parsed, field) {
  const rows = parsed.flatMap((page) => page[field]);
  const byId = new Map();
  for (const row of rows) {
    const prior = byId.get(row.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
      throw new TypeError(`snapshot: changed ${field} row`);
    }
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

export function mergeSnapshotPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) throw new TypeError("snapshot pages required");
  const parsed = pages.map(parseSnapshot);
  const first = parsed[0];
  if (parsed.length > 1 && parsed.slice(0, -1).some((page) => page.complete)) {
    throw new TypeError("snapshot: premature complete page");
  }
  if (!parsed.at(-1).complete) throw new TypeError("snapshot: continuation incomplete");
  for (const page of parsed) assertSamePageBoundary(page, first);
  const devices = repeatedSnapshotRows(parsed, "devices");
  const boards = repeatedSnapshotRows(parsed, "boards");
  const agents = uniqueSnapshotRows(parsed, "agents").sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const links = uniqueSnapshotRows(parsed, "links").sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (agents.length > first.totals.agents || links.length > first.totals.links) {
    throw new TypeError("snapshot: visible rows exceed totals");
  }
  return {
    ...first,
    devices,
    agents,
    boards,
    links,
    visible: {
      devices: devices.length,
      agents: agents.length,
      boards: boards.length,
      links: links.length,
    },
    complete: true,
    next: null,
  };
}

function assertDeltaEvent(value) {
  if (value.v !== 1 || !FEED_TYPES.has(value.type) || typeof value.committed !== "boolean") {
    throw new TypeError("delta: invalid event");
  }
}

function assertDeltaCursor(cursor, value) {
  if (cursor.stream !== value.stream || cursor.seq !== value.seq) {
    throw new TypeError("delta: cursor mismatch");
  }
}

function assertDeltaStatus(value) {
  if (value.state !== null && !MESSAGE_STATES.has(value.state)) {
    throw new TypeError("delta.state: invalid state");
  }
  if (value.code !== null && !FAULT_CODES.has(value.code)) {
    throw new TypeError("delta.code: invalid fault");
  }
  if (
    (value.type === "refusal" && value.committed) ||
    (value.type !== "refusal" && !value.committed)
  ) {
    throw new TypeError("delta: inconsistent commit status");
  }
}

function parseDeltaFrame(input) {
  exact(input, DELTA_FRAME_KEYS, "delta frame");
  if (input.event !== "delta") throw new TypeError("delta: invalid frame");
  const cursor = feedCursor(input.cursor);
  const value = exact(input.data, DELTA_DATA_KEYS, "delta");
  assertDeltaEvent(value);
  text(value.stream, "delta.stream");
  integer(value.seq, "delta.seq", 1);
  integer(value.time, "delta.time");
  assertDeltaCursor(cursor, value);
  nullableText(value.from, "delta.from");
  nullableText(value.to, "delta.to");
  nullableText(value.mid, "delta.mid");
  assertDeltaStatus(value);
  return { event: "delta", cursor: input.cursor, data: value };
}

function parseResetFrame(input) {
  exact(input, RESET_FRAME_KEYS, "reset");
  if (input.event !== "reset" || !RESET_REASONS.has(input.reason)) {
    throw new TypeError("reset: invalid frame");
  }
  feedCursor(input.cursor);
  return { event: "reset", cursor: input.cursor, reason: input.reason };
}

function parseKeepaliveFrame(input) {
  exact(input, KEEPALIVE_FRAME_KEYS, "keepalive");
  if (input.event !== "keepalive") throw new TypeError("keepalive: invalid frame");
  integer(input.time, "keepalive.time");
  return { event: "keepalive", time: input.time };
}

export function parseFeedFrame(event, input) {
  if (event === "delta") return parseDeltaFrame(input);
  if (event === "reset") return parseResetFrame(input);
  if (event === "keepalive") return parseKeepaliveFrame(input);
  throw new TypeError("feed: unknown event");
}

function sseDispatch(state, onFrame) {
  if (!state.data.length) {
    state.event = "message";
    state.bytes = 0;
    return;
  }
  const frame = parseFeedFrame(state.event, JSON.parse(state.data.join("\n")));
  onFrame(frame);
  state.event = "message";
  state.data = [];
  state.bytes = 0;
}

function sseLine(state, value, onFrame) {
  let line = value;
  if (line.endsWith("\r")) line = line.slice(0, -1);
  if (!line) {
    sseDispatch(state, onFrame);
    return;
  }
  const colon = line.indexOf(":");
  const field = colon < 0 ? line : line.slice(0, colon);
  let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
  if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
  state.bytes += state.encoder.encode(line).byteLength + 1;
  if (state.bytes > SSE_FRAME_LIMIT) throw new Error("Event frame limit exceeded");
  if (line.startsWith(":")) return;
  if (field === "event") {
    state.event = fieldValue;
  } else if (field === "data") {
    state.data.push(fieldValue);
  }
}

function drainSseLines(buffer, signal, state, onFrame) {
  let rest = buffer;
  while (!signal.aborted) {
    const newline = rest.indexOf("\n");
    if (newline < 0) break;
    const current = rest.slice(0, newline);
    rest = rest.slice(newline + 1);
    sseLine(state, current, onFrame);
  }
  return rest;
}

async function readSseStream(reader, decoder, encoder, signal, state, onFrame) {
  let buffer = "";
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done || signal.aborted) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = drainSseLines(buffer, signal, state, onFrame);
    if (!signal.aborted && state.bytes + encoder.encode(buffer).byteLength > SSE_FRAME_LIMIT) {
      throw new Error("Event frame limit exceeded");
    }
  }
  if (signal.aborted) return;
  buffer += decoder.decode();
  if (buffer) sseLine(state, buffer, onFrame);
  sseDispatch(state, onFrame);
}

async function releaseSseReader(reader, cancellation, failure) {
  try {
    await (cancellation ?? reader.cancel());
  } catch (error) {
    if (!failure) failure = error;
  }
  try {
    reader.releaseLock();
  } catch (error) {
    if (!failure) failure = error;
  }
  return failure;
}

export async function consumeSseBody(body, signal, onFrame) {
  if (!body || typeof onFrame !== "function") {
    throw new TypeError("event stream body and handler required");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state = { event: "message", data: [], bytes: 0, encoder: new TextEncoder() };
  let failure;
  let cancellation;
  const abort = () => {
    cancellation = reader.cancel().catch((error) => {
      failure ??= error;
    });
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    await readSseStream(reader, decoder, state.encoder, signal, state, onFrame);
  } catch (error) {
    failure = error;
  }
  signal.removeEventListener("abort", abort);
  failure = await releaseSseReader(reader, cancellation, failure);
  if (failure) throw failure;
}

function assertPageCounts(page) {
  if (
    !Array.isArray(page.items) ||
    page.items.length > 200 ||
    page.visible !== page.items.length ||
    page.total < page.visible
  ) {
    throw new TypeError("page: invalid counts");
  }
}

function pageContinuationInvalid(page) {
  if (typeof page.complete !== "boolean") return true;
  if (page.complete) return page.next !== null;
  return typeof page.next !== "string";
}

function assertPageContinuation(page, cursor) {
  if (page.next === null) return;
  const next = messageCursor(page.next);
  if (
    next.authority !== cursor.authority ||
    next.scope !== cursor.scope ||
    next.filter !== cursor.filter ||
    next.boundary !== cursor.boundary ||
    next.last <= cursor.last
  ) {
    throw new TypeError("page: continuation mismatch");
  }
}

function parseMessageRow(row, board, kind) {
  exact(row, MESSAGE_KEYS, "message", ["data"]);
  text(row.id, "message.id");
  integer(row.seq, "message.seq", 1);
  nullableText(row.from, "message.from");
  nullableText(row.to, "message.to");
  if (row.board !== board || row.kind !== kind || !MESSAGE_STATES.has(row.state)) {
    throw new TypeError("message: scope mismatch");
  }
  if (!Array.isArray(row.needs) || row.needs.some((tag) => typeof tag !== "string")) {
    throw new TypeError("message.needs: invalid tags");
  }
  nullableText(row.series, "message.series");
  integer(row.init, "message.init");
  nullableInteger(row.acked, "message.acked");
  if ("data" in row) parseEnvelope(row.data, kind);
}

export function parseBoardPage(input, board, kind, authority = null) {
  const page = exact(input, PAGE_KEYS, "page");
  text(board, "board");
  if (kind !== "msg" && kind !== "work") throw new TypeError("kind: invalid kind");
  integer(page.total, "page.total");
  integer(page.visible, "page.visible");
  integer(page.pruned, "page.pruned");
  assertPageCounts(page);
  if (pageContinuationInvalid(page)) throw new TypeError("page: invalid continuation");
  const cursor = messageCursor(page.cursor);
  if (authority !== null && cursor.authority !== authority) {
    throw new TypeError("page: authority mismatch");
  }
  nullableText(page.next, "page.next");
  assertPageContinuation(page, cursor);
  nullableInteger(page.firstSeq, "page.firstSeq");
  for (const row of page.items) parseMessageRow(row, board, kind);
  return { page, authority: cursor.authority };
}

export function bindBoardAuthority(state, authority) {
  text(authority, "page authority");
  if (state.boardAuthority !== null && state.boardAuthority !== authority) {
    throw new TypeError("page: authority mismatch");
  }
  state.boardAuthority = authority;
}

export function createUiState() {
  return {
    token: null,
    snapshot: null,
    selectedBoard: null,
    boardAuthority: null,
    selectedNode: null,
    connection: "disconnected",
    inbox: {
      page: null,
      pages: [],
      pageIndex: -1,
      pageBase: 0,
      loading: false,
      error: null,
      generation: 0,
    },
    bounties: {
      page: null,
      pages: [],
      pageIndex: -1,
      pageBase: 0,
      loading: false,
      error: null,
      generation: 0,
    },
    pulses: [],
  };
}

function emptyPane(generation, error = null) {
  return { page: null, pages: [], pageIndex: -1, pageBase: 0, loading: false, error, generation };
}

export function clearPrivateState(state) {
  state.token = null;
  state.snapshot = null;
  state.selectedBoard = null;
  state.boardAuthority = null;
  state.selectedNode = null;
  state.pulses = [];
  state.inbox = emptyPane(state.inbox.generation + 1);
  state.bounties = emptyPane(state.bounties.generation + 1);
}

export function denyPane(state, name, generation) {
  if (name !== "inbox" && name !== "bounties") throw new TypeError("unknown pane");
  const pane = state[name];
  if (pane.generation !== generation) return false;
  state[name] = emptyPane(pane.generation + 1, "Denied");
  return true;
}

export function selectBoard(state, board) {
  if (board !== null && !state.snapshot?.boards.some((entry) => entry.id === board)) {
    throw new TypeError("board is not in the current snapshot");
  }
  state.selectedBoard = board;
  state.boardAuthority = null;
  state.inbox = emptyPane(state.inbox.generation + 1);
  state.bounties = emptyPane(state.bounties.generation + 1);
  return state;
}

export function commitPulse(state, frame, now = Date.now()) {
  if (frame?.event !== "delta" || !frame.data.committed || !frame.data.from || !frame.data.to) {
    return false;
  }
  state.pulses.push({
    from: frame.data.from,
    to: frame.data.to,
    seq: frame.data.seq,
    until: now + 1500,
  });
  if (state.pulses.length > 64) state.pulses.splice(0, state.pulses.length - 64);
  return true;
}
