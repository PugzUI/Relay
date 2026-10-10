import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitPulse,
  consumeSseBody,
  createUiState,
  mergeSnapshotPages,
  parseBoardPage,
  parseFeedFrame,
  parseSnapshot,
  selectBoard,
} from "../ui/state.mjs";

const device = { id: "dev-1", name: "north", init: 1, authority: "auth-1", receivedAt: 900, stale: true, free: null };
const agent = { id: "north:worker:prime", device: "dev-1", runtime: "worker", slot: "prime", caps: [], epoch: 1, init: 2, state: "stale", assignmentCount: 0, receivedAt: 800 };
const board = { id: "bounty", kind: "bounty", device: null, authority: "auth-1", inbox: 1, pending: 2, claimed: 0, terminal: 0, reported: false, receivedAt: null };
const scope = "a".repeat(64);
const filter = "b".repeat(64);
const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const encodeToken = (value) => btoa(canonicalJson(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const feedCursor = (seq = 1, authority = "auth-1") => encodeToken({ v: 1, authority, stream: "stream", seq, scope });
const messageCursor = (last = 0) => encodeToken({ v: 1, authority: "auth-1", scope, filter, boundary: 20, last });
const snapshotCursor = (time = 1_000) => encodeToken({ v: 1, authority: "auth-1", scope, filter, boundary: 1, time, last: { agent: "", link: "" } });

function snapshot(overrides = {}) {
  const value = {
    v: 1, authority: "auth-1", time: 1_000, cursor: feedCursor(),
    devices: [device], agents: [agent], boards: [board], links: [],
    totals: { devices: 1, agents: 1, boards: 1, links: 0 },
    visible: { devices: 1, agents: 1, boards: 1, links: 0 }, complete: true, next: null,
    ...overrides,
  };
  return value;
}

test("A42 snapshot keeps exact totals distinct from visible rows and stale capacity unknown", () => {
  const value = parseSnapshot(snapshot({
    totals: { devices: 3, agents: 14, boards: 2, links: 9 },
  }));
  assert.equal(value.totals.agents, 14);
  assert.equal(value.visible.agents, 1);
  assert.equal(value.devices[0].free, null);
  assert.equal(value.devices[0].stale, true);
});

test("A42 rejects inconsistent visible counts and unsupported snapshot fields", () => {
  assert.throws(() => parseSnapshot(snapshot({ visible: { devices: 0, agents: 1, boards: 1, links: 0 } })), /inconsistent counts/);
  assert.throws(() => parseSnapshot(snapshot({ madeUp: true })), /unknown field/);
});

test("canonical cursors accept CORE key order and reject insertion-ordered JSON", () => {
  assert.deepEqual(parseFeedFrame("reset", { event: "reset", cursor: feedCursor(), reason: "restart" }).event, "reset");
  const insertionOrdered = btoa(JSON.stringify({ v: 1, authority: "auth-1", stream: "stream", seq: 1, scope }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  assert.throws(() => parseFeedFrame("reset", { event: "reset", cursor: insertionOrdered, reason: "restart" }), /noncanonical JSON/);
});

test("A43 only committed accepted deltas create a bounded path pulse", () => {
  const state = createUiState();
  const delta = { v: 1, stream: "stream", seq: 4, time: 1, type: "post", from: "agent", to: "bounty", mid: "opaque", state: "posted", code: null, committed: true };
  const wrapped = { event: "delta", cursor: feedCursor(4), data: delta };
  assert.equal(commitPulse(state, parseFeedFrame("delta", wrapped), 100), true);
  const refusal = { ...delta, seq: 5, type: "refusal", code: "denied", committed: false };
  assert.equal(commitPulse(state, parseFeedFrame("delta", { event: "delta", cursor: feedCursor(5), data: refusal }), 101), false);
  assert.equal(commitPulse(state, { event: "keepalive", time: 1 }, 102), false);
  assert.equal(state.pulses.length, 1);
  assert.equal(state.pulses[0].until, 1_600);
});

test("A43 inconsistent commit flags are rejected before rendering", () => {
  assert.throws(() => parseFeedFrame("delta", { event: "delta", cursor: feedCursor(), data: {
    v: 1, stream: "stream", seq: 1, time: 0, type: "refusal", from: null, to: null, mid: null, state: null, code: "denied", committed: true,
  } }), /inconsistent commit/);
});

test("A44 snapshot pages retain one authority boundary and repeat identical device and board summaries", () => {
  const first = snapshot({ complete: false, next: snapshotCursor() });
  const second = snapshot({ complete: true, next: null, agents: [], visible: { devices: 1, agents: 0, boards: 1, links: 0 } });
  const merged = mergeSnapshotPages([first, second]);
  assert.equal(merged.devices.length, 1);
  assert.equal(merged.boards.length, 1);
  assert.equal(merged.complete, true);
  assert.equal(merged.next, null);
  assert.throws(() => mergeSnapshotPages([first, { ...second, authority: "other", cursor: feedCursor(1, "other") }]), /boundary changed/);
});

test("A44 changed repeated summary and historical reset are not accepted as current state", () => {
  const changed = snapshot({ devices: [{ ...device, stale: false }] });
  assert.throws(() => mergeSnapshotPages([snapshot({ complete: false, next: snapshotCursor() }), changed]), /changed devices row/);
  assert.deepEqual(parseFeedFrame("reset", { event: "reset", cursor: feedCursor(), reason: "restart" }), { event: "reset", cursor: feedCursor(), reason: "restart" });
});

test("A45 bounded snapshot and stream schemas reject oversized collections and unknown feed types", () => {
  assert.throws(() => parseSnapshot(snapshot({ links: Array(513).fill({ ...agent, id: "l", from: "a", to: "b", kind: "report", state: "active", mid: null, time: null }) })), /invalid collection/);
  assert.throws(() => parseFeedFrame("delta", { event: "delta", cursor: feedCursor(), data: {
    v: 1, stream: "stream", seq: 1, time: 0, type: "heartbeat", from: null, to: null, mid: null, state: null, code: null, committed: false,
  } }), /invalid event/);
});

test("A45 SSE reader parses many frames from one chunk and cancels an oversized frame", async () => {
  const frame = 'event: keepalive\ndata: {"event":"keepalive","time":1}\n\n';
  const chunk = new TextEncoder().encode(frame.repeat(400));
  let count = 0;
  await consumeSseBody(new ReadableStream({ start(controller) { controller.enqueue(chunk); controller.close(); } }), new AbortController().signal, () => { count += 1; });
  assert.equal(count, 400);
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(16_500)}\n\n`)); controller.close(); } });
  await assert.rejects(consumeSseBody(oversized, new AbortController().signal, () => {}), /frame limit/);
});

test("A47 board selection invalidates both independent pane generations and clears old pages", () => {
  const state = createUiState();
  state.snapshot = parseSnapshot(snapshot());
  state.inbox.page = { items: [{ id: "private" }] };
  state.bounties.page = { items: [{ id: "private-work" }] };
  const inboxGeneration = state.inbox.generation;
  const bountyGeneration = state.bounties.generation;
  selectBoard(state, "bounty");
  assert.equal(state.inbox.generation, inboxGeneration + 1);
  assert.equal(state.bounties.generation, bountyGeneration + 1);
  assert.equal(state.inbox.page, null);
  assert.equal(state.bounties.page, null);
  assert.throws(() => selectBoard(state, "host:foreign"), /not in the current snapshot/);
});

test("A47 layout keeps narrow panes readable, keyboard focus visible, and reduced motion static", async () => {
  const style = await readFile(new URL("../ui/style.css", import.meta.url), "utf8");
  assert.match(style, /:focus-visible\s*\{[^}]*outline/);
  assert.match(style, /@media \(max-width: 760px\)[\s\S]*?\.panes\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(style, /border-radius: 0 !important/);
  assert.doesNotMatch(style, /overflow-x:\s*hidden/);
});

test("A49 pane page validates kind, board, envelope and stable pagination counts", () => {
  const page = {
    items: [{ id: "m1", seq: 1, from: "worker", to: null, board: "bounty", kind: "msg", needs: [], series: null, data: { msg: "<script>text only</script>\nα" }, state: "posted", init: 1, acked: null }],
    total: 2, visible: 1, complete: false, cursor: messageCursor(), next: messageCursor(1), firstSeq: 1, pruned: 0,
  };
  assert.equal(parseBoardPage(page, "bounty", "msg", "auth-1").items[0].data.msg, "<script>text only</script>\nα");
  assert.throws(() => parseBoardPage(page, "bounty", "work", "auth-1"), /scope mismatch/);
  assert.throws(() => parseBoardPage({ ...page, total: 0 }, "bounty", "msg", "auth-1"), /invalid counts/);
});

test("A50 selecting and parsing shared Inbox pages creates no read receipt or local read cursor", () => {
  const state = createUiState();
  state.snapshot = parseSnapshot(snapshot());
  selectBoard(state, "bounty");
  const before = structuredClone(state);
  parseBoardPage({ items: [], total: 0, visible: 0, complete: true, cursor: messageCursor(), next: null, firstSeq: null, pruned: 0 }, "bounty", "msg", "auth-1");
  assert.deepEqual(state, before);
  assert.equal("readPosition" in state, false);
});

test("A51 frontend sends in-memory auth to fixed same-origin routes and uses inert text nodes", async () => {
  const source = await readFile(new URL("../ui/main.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../ui/index.html", import.meta.url), "utf8");
  assert.match(source, /Authorization: `Bearer \$\{state\.token\}`/);
  assert.match(source, /credentials: "omit"/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /new URL\("\/v1\/board", location\.origin\)/);
  assert.match(source, /textContent = String\(value\)/);
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage|EventSource/);
  assert.match(html, /Content-Security-Policy/);
});

test("A51 revoked credentials clear selected and cached private page state", async () => {
  const source = await readFile(new URL("../ui/main.mjs", import.meta.url), "utf8");
  assert.match(source, /function clearPrivateState\(\)[\s\S]*?state\.inbox = \{ page: null/);
  assert.match(source, /state\.bounties = \{ page: null/);
  assert.match(source, /error\.code === "auth" \|\| error\.code === "denied"/);
});

test("native CORE snapshot, board pages, and feed deltas match the UI contract", {
  skip: !existsSync(new URL("../src/relay.mjs", import.meta.url)),
}, async () => {
  const [{ open, setup }, { createFeed }] = await Promise.all([
    import("../src/index.mjs"), import("../src/feed.mjs"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "relay-ui-native-"));
  let relay;
  let feed;
  let stream;
  try {
    setup({ root, device: "ui-probe", role: "hub" });
    relay = open({ root });
    const worker = relay.register("worker");
    relay.register("worker", { slot: "002" });
    const session = relay.join(worker.id);
    feed = createFeed(relay);
    const board = "bounty";
    const authorization = {
      scopeKey: "a".repeat(64),
      principal: { id: "ui-probe", grant: { inboxRead: [board], workRead: [board] } },
    };
    relay.post(session.id, board, { msg: "inbox probe" });
    relay.post(session.id, board, { work: { task: "bounty probe" } });
    const inbox = parseBoardPage(relay.list({ board, kind: "msg", limit: 1, data: true }, authorization), board, "msg", relay.authority);
    const bounties = parseBoardPage(relay.list({ board, kind: "work", limit: 1, data: true }, authorization), board, "work", relay.authority);
    assert.equal(inbox.items.length, 1);
    assert.equal(bounties.items.length, 1);

    const first = parseSnapshot(feed.snapshot({ limit: 1 }, authorization));
    assert.equal(first.complete, false);
    const second = parseSnapshot(feed.snapshot({ limit: 1, after: first.next }, authorization));
    const snapshotPage = mergeSnapshotPages([first, second]);
    assert.equal(snapshotPage.totals.agents, 2);
    assert.equal(snapshotPage.visible.agents, 2);
    assert.equal(snapshotPage.boards[0].id, board);

    const controller = new AbortController();
    stream = feed.subscribe({ cursor: snapshotPage.cursor, authorization, signal: controller.signal });
    const pending = stream.next();
    relay.post(session.id, board, { msg: "stream probe" });
    let timer;
    const event = await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("native feed probe timed out")), 2_000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(event.value.event, "delta");
    assert.equal(parseFeedFrame(event.value.event, event.value).data.type, "post");
  } finally {
    await stream?.return();
    feed?.close();
    relay?.close();
    await rm(root, { recursive: true, force: true });
  }
});
