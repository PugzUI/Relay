import {
  commitPulse,
  consumeSseBody,
  createUiState,
  clearPrivateState as clearPrivateUiState,
  bindBoardAuthority,
  denyPane,
  mergeSnapshotPages,
  parseBoardPage,
  parseSnapshot,
  sameFeedBoundary,
  selectBoard,
} from "/state.mjs";
import "/assets/console.mjs";

const PAGE_SIZE = 50;
const MAX_RESPONSE_BYTES = 1_048_576;
const REQUEST_DEADLINE_MS = 10_000;
const MAX_SNAPSHOT_ATTEMPTS = 3;
const state = createUiState();
const requestControllers = new Set();
const paneControllers = new Map();
const recordSignatures = new WeakMap();
const byId = (id) => document.getElementById(id);
const connectionNode = byId("connection");
const topologyNode = byId("topology");
const statusNode = byId("topology-status");
const metaNode = byId("snapshot-meta");
const boardPicker = byId("board-picker");
let streamController = null;
let streamTask = null;
let streamGeneration = 0;
let snapshotController = null;
let snapshotGeneration = 0;
let pageHidden = document.hidden;
let refreshTimer = null;
let paneRefreshTimer = null;
let pulseTimer = null;
let freshnessTimer = null;

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = String(value);
  return element;
}

function abortRequests() {
  for (const controller of requestControllers) controller.abort();
  requestControllers.clear();
  for (const controller of paneControllers.values()) controller.abort();
  paneControllers.clear();
}

function requestController(pane) {
  const controller = new AbortController();
  requestControllers.add(controller);
  if (pane) {
    paneControllers.get(pane)?.abort();
    paneControllers.set(pane, controller);
  }
  controller.signal.addEventListener("abort", () => {
    requestControllers.delete(controller);
    if (paneControllers.get(pane) === controller) paneControllers.delete(pane);
  }, { once: true });
  return controller;
}

function setConnection(value, label) {
  const changed = state.connection !== value || connectionNode.textContent !== label;
  state.connection = value;
  connectionNode.dataset.state = value;
  connectionNode.textContent = label;
  statusNode.textContent = `${label}${state.snapshot && value !== "connected" ? " · cached" : ""}`;
  statusNode.dataset.state = value === "error" ? "error" : "";
  byId("auth-form").dataset.authenticated = String(Boolean(state.token));
  byId("disconnect").disabled = !state.token;
  byId("refresh").disabled = !state.token;
  byId("expand-all").disabled = !state.snapshot;
  renderViews();
  if (changed || !state.selectedBoard) {
    renderPane("inbox");
    renderPane("bounties");
  }
}

function safeHttpError(status) {
  if (status === 401) return { code: "auth", label: "Authentication required" };
  if (status === 403) return { code: "denied", label: "Denied" };
  if (status === 404 || status === 503) return { code: "unavailable", label: "Unavailable" };
  return { code: "http", label: `Request failed (${status})` };
}

async function readBounded(response, controller) {
  const header = response.headers.get("content-length");
  if (header !== null && (!/^\d+$/.test(header) || Number(header) > MAX_RESPONSE_BYTES)) throw new Error("Response limit exceeded");
  if (!response.body) throw new Error("Response body unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        controller.abort();
        await reader.cancel();
        throw new Error("Response limit exceeded");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function clearPrivateState() {
  clearPrivateUiState(state);
  clearTimeout(refreshTimer);
  clearTimeout(pulseTimer);
  clearTimeout(paneRefreshTimer);
  clearTimeout(freshnessTimer);
  stopStream();
  abortRequests();
  metaNode.textContent = "";
  metaNode.title = "";
  byId("node-filter").value = "";
  topologyNode.query = "";
  renderViews();
  boardPicker.replaceChildren();
  boardPicker.disabled = true;
  clearPane("inbox");
  clearPane("bounties");
}

function handleAuthFault(error, token) {
  if (error?.code !== "auth" && error?.code !== "denied") return;
  if (state.token !== token) return;
  clearPrivateState();
  byId("token").value = "";
  setConnection("error", error.code === "auth" ? "Authentication required" : "Denied");
}

async function requestJson(path, { signal, pane } = {}) {
  const token = state.token;
  const controller = requestController(pane);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_DEADLINE_MS);
  const abortListener = signal ? () => controller.abort() : null;
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortListener, { once: true });
  }
  try {
    const response = await fetch(path, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      mode: "same-origin",
      redirect: "error",
      signal: controller.signal,
    });
    const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (!response.ok) {
      const failure = safeHttpError(response.status);
      if (response.status === 503 && !pane && type === "application/json") {
        const value = JSON.parse(await readBounded(response, controller));
        if (value?.v === 1 && value.fault?.code === "reset") {
          failure.code = "reset";
          failure.label = "Topology changed";
        }
      }
      const error = new Error(failure.label);
      error.code = failure.code;
      throw error;
    }
    if (type !== "application/json") throw new Error("Invalid response type");
    return JSON.parse(await readBounded(response, controller));
  } catch (error) {
    if (error?.name === "AbortError") {
      if (timedOut) {
        const timeout = new Error("Request timed out");
        timeout.code = "timeout";
        throw timeout;
      }
      throw error;
    }
    controller.abort();
    if (!signal?.aborted && (error?.code === "auth" || (error?.code === "denied" && !pane))) handleAuthFault(error, token);
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    requestControllers.delete(controller);
    if (paneControllers.get(pane) === controller) paneControllers.delete(pane);
  }
}

async function loadSnapshot(signal) {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const pages = [];
    let after = null;
    try {
      for (let pageNo = 0; pageNo < 32; pageNo += 1) {
        if (signal.aborted) throw new DOMException("Snapshot cancelled", "AbortError");
        const url = new URL("/v1/topology", location.origin);
        url.searchParams.set("limit", "512");
        if (after) url.searchParams.set("after", after);
        const page = parseSnapshot(await requestJson(`${url.pathname}${url.search}`, { signal }));
        pages.push(page);
        if (page.complete) return mergeSnapshotPages(pages);
        after = page.next;
      }
      throw new Error("Topology page limit exceeded");
    } catch (error) {
      if (error.code !== "reset" || signal.aborted || attempt === MAX_SNAPSHOT_ATTEMPTS - 1) throw error;
    }
  }
}

function timeLabel(time) {
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "time unknown";
}

function renderViews() {
  const snapshot = state.snapshot;
  for (const id of ["overview", "topology", "inspector"]) {
    const view = byId(id);
    view.snapshot = snapshot;
    view.connection = state.connection;
  }
  topologyNode.selectedBoard = state.selectedBoard;
  topologyNode.selectedNode = state.selectedNode;
  topologyNode.pulses = state.pulses;
  byId("inspector").selection = state.selectedNode;
  byId("inspector").query = topologyNode.query;
}

function drawTopology(snapshot = state.snapshot) {
  state.pulses = state.pulses.filter((pulse) => pulse.until > Date.now());
  const entities = [...(snapshot?.devices ?? []), ...(snapshot?.agents ?? []), ...(snapshot?.boards ?? [])];
  if (state.selectedNode && !entities.some((row) => row.id === state.selectedNode)) state.selectedNode = null;
  renderViews();
  if (!snapshot) return;
  const ids = snapshot.boards.map((board) => board.id);
  if (JSON.stringify(ids) !== JSON.stringify([...boardPicker.children].map((option) => option.value))) {
    boardPicker.replaceChildren();
    for (const board of snapshot.boards) {
      const option = document.createElement("option");
      option.value = board.id;
      option.textContent = board.id;
      boardPicker.append(option);
    }
  }
  boardPicker.disabled = snapshot.boards.length === 0;
  if (state.selectedBoard) boardPicker.value = state.selectedBoard;
  metaNode.textContent = `${snapshot.visible.devices}/${snapshot.totals.devices} devices · ${snapshot.visible.agents}/${snapshot.totals.agents} workers · ${snapshot.visible.boards}/${snapshot.totals.boards} boards`;
  metaNode.title = `${snapshot.authority} · ${timeLabel(snapshot.time)}`;
}

function chooseBoard(board) {
  if (board !== null && !state.snapshot?.boards.some((entry) => entry.id === board)) return;
  cancelPaneRequests();
  try { selectBoard(state, board); } catch { return; }
  state.selectedNode = board;
  boardPicker.value = board;
  drawTopology();
  if (state.token && board) {
    loadPane("inbox", null);
    loadPane("bounties", null);
  }
}

function cancelPaneRequests() {
  for (const name of ["inbox", "bounties"]) {
    paneControllers.get(name)?.abort();
    paneControllers.delete(name);
    state[name].generation += 1;
    state[name].loading = false;
  }
}

function resetForResync() {
  clearTimeout(refreshTimer);
  clearTimeout(paneRefreshTimer);
  clearTimeout(pulseTimer);
  clearTimeout(freshnessTimer);
  snapshotController?.abort();
  snapshotController = null;
  cancelPaneRequests();
  state.snapshot = null;
  state.selectedNode = null;
  state.pulses = [];
  selectBoard(state, null);
  renderViews();
  metaNode.textContent = "";
  metaNode.title = "";
  boardPicker.replaceChildren();
  boardPicker.disabled = true;
  clearPane("inbox");
  clearPane("bounties");
  setConnection("disconnected", "Resynchronizing");
}

function clearPane(name) {
  byId(`${name}-rows`).replaceChildren();
  byId(`${name}-count`).textContent = "";
  byId(`${name}-page`).textContent = "";
  byId(`${name}-status`).textContent = state.token ? "Select a board" : "Disconnected";
  byId(`${name}-status`).dataset.state = "";
  byId(`${name}-prev`).disabled = true;
  byId(`${name}-next`).disabled = true;
}

function paneLabel(page) {
  const clipping = page.complete ? "" : " · clipped";
  const pruned = page.pruned ? ` · pruned ${page.pruned}` : "";
  return `${page.visible} visible / ${page.total} total${clipping}${pruned}`;
}

function renderPane(name) {
  const pane = state[name];
  const page = pane.page;
  const rows = byId(`${name}-rows`);
  if (!state.selectedBoard) return clearPane(name);
  const status = byId(`${name}-status`);
  status.dataset.state = "";
  if (pane.loading) status.textContent = "Loading";
  else if (pane.error) { status.textContent = pane.error; status.dataset.state = "error"; }
  else if (page && state.connection !== "connected") {
    status.textContent = `${connectionNode.textContent} · cached`;
    status.dataset.state = state.connection === "error" ? "error" : "";
  }
  else if (page?.items.length === 0) status.textContent = "Empty";
  else if (page) status.textContent = "Ready";
  else status.textContent = "Not loaded";
  if (page) {
    byId(`${name}-count`).textContent = paneLabel(page);
    const existing = new Map([...rows.children].map((item) => [item.dataset.mid, item]));
    const retained = new Set();
    let anchor = rows.firstChild;
    for (const row of page.items) {
      const item = existing.get(row.id) ?? node("li", "record");
      item.dataset.mid = row.id;
      const text = name === "inbox" ? row.data?.msg : row.data?.work === undefined ? undefined : JSON.stringify(row.data.work, null, 2);
      const metadata = name === "inbox"
        ? `seq ${row.seq} · ${timeLabel(row.init)}`
        : `seq ${row.seq} · ${row.needs.length ? `needs ${row.needs.join(", ")}` : "needs none"}${row.series ? ` · series ${row.series}` : ""} · ${timeLabel(row.init)}`;
      const signature = JSON.stringify([row.id, row.state, text, metadata]);
      if (recordSignatures.get(item) !== signature) {
        item.replaceChildren(node("span", "record-id", row.id), node("span", "record-state", row.state));
        if (text !== undefined) item.append(node("pre", "record-text", text));
        item.append(node("span", "record-meta", metadata));
        recordSignatures.set(item, signature);
      }
      retained.add(item);
      if (item === anchor) anchor = anchor.nextSibling;
      else rows.insertBefore(item, anchor);
    }
    for (const item of [...rows.children]) if (!retained.has(item)) item.remove();
  } else {
    rows.replaceChildren();
    byId(`${name}-count`).textContent = "";
  }
  byId(`${name}-prev`).disabled = pane.loading || pane.pageIndex <= 0;
  byId(`${name}-next`).disabled = pane.loading || !page || page.complete;
  byId(`${name}-page`).textContent = pane.pageIndex >= 0 ? `Page ${pane.pageBase + pane.pageIndex + 1}` : "";
}

async function loadPane(name, after, reuse = false) {
  const pane = state[name];
  const selectedBoard = state.selectedBoard;
  const board = state.snapshot?.boards.find((item) => item.id === selectedBoard);
  const boardAuthority = state.boardAuthority ?? (board && (!board.reported || board.authority !== state.snapshot.authority) ? board.authority : null);
  if (!state.token || !selectedBoard || !board) return;
  const generation = ++pane.generation;
  pane.loading = true;
  pane.error = null;
  renderPane(name);
  const url = new URL("/v1/board", location.origin);
  url.searchParams.set("board", selectedBoard);
  url.searchParams.set("kind", name === "inbox" ? "msg" : "work");
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("data", "1");
  if (after) url.searchParams.set("after", after);
  try {
    const raw = await requestJson(`${url.pathname}${url.search}`, { pane: name });
    const parsed = parseBoardPage(raw, selectedBoard, name === "inbox" ? "msg" : "work", boardAuthority);
    if (generation !== pane.generation || selectedBoard !== state.selectedBoard || !state.token) return;
    bindBoardAuthority(state, parsed.authority);
    const page = parsed.page;
    if (reuse) pane.pages[pane.pageIndex] = page;
    else {
      pane.pages = pane.pages.slice(0, pane.pageIndex + 1);
      pane.pages.push(page);
      pane.pageIndex = pane.pages.length - 1;
      if (pane.pages.length > 20) {
        pane.pages.shift();
        pane.pageIndex -= 1;
        pane.pageBase += 1;
      }
    }
    pane.page = page;
  } catch (error) {
    if (error.name === "AbortError") return;
    if (generation !== pane.generation) return;
    if (error.code === "denied") {
      if (!denyPane(state, name, generation)) return;
      renderPane(name);
      return;
    }
    pane.error = error.code === "unavailable" ? "Unavailable" : error.code === "denied" ? "Denied" : error.code === "auth" ? "Authentication required" : error.code === "timeout" ? "Timed out" : error.message === "Failed to fetch" ? "Offline" : "Invalid response";
  } finally {
    if (generation === pane.generation) {
      pane.loading = false;
      renderPane(name);
    }
  }
}

function navigatePane(name, direction) {
  const pane = state[name];
  const target = pane.pageIndex + direction;
  if (target < 0) return;
  if (target < pane.pages.length) {
    pane.pageIndex = target;
    pane.page = pane.pages[target];
    renderPane(name);
  } else if (pane.page?.next) loadPane(name, pane.page.next);
}

async function refreshSnapshot(refreshBoardPages = false) {
  if (!state.token || pageHidden) return false;
  const token = state.token;
  const wasConnected = state.connection === "connected";
  snapshotController?.abort();
  const controller = requestController();
  snapshotController = controller;
  const generation = ++snapshotGeneration;
  try {
    const snapshot = await loadSnapshot(controller.signal);
    if (state.token !== token || controller.signal.aborted || generation !== snapshotGeneration) return false;
    if (state.snapshot && (state.snapshot.authority !== snapshot.authority || !sameFeedBoundary(state.snapshot.cursor, snapshot.cursor))) {
      stopStream();
      cancelPaneRequests();
      selectBoard(state, null);
      state.selectedNode = null;
      state.pulses = [];
    }
    state.snapshot = snapshot;
    let selectedChanged = false;
    if (!state.selectedBoard || !snapshot.boards.some((board) => board.id === state.selectedBoard)) {
      const preferred = snapshot.boards.find((board) => board.kind === "bounty")?.id ?? snapshot.boards[0]?.id ?? null;
      if (preferred !== state.selectedBoard) {
        cancelPaneRequests();
        selectBoard(state, preferred);
        if (!state.selectedNode) state.selectedNode = preferred;
        selectedChanged = true;
      }
    }
    drawTopology(snapshot);
    setConnection("connected", "Connected");
    if (state.selectedBoard && (selectedChanged || !wasConnected || refreshBoardPages)) {
      refreshPanes();
    }
    connectStream();
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    if (error.code === "auth" || error.code === "denied") return false;
    if (state.token !== token || controller.signal.aborted || generation !== snapshotGeneration || pageHidden) return false;
    setConnection("error", error.code === "reset" ? "Topology changed" : error.code === "unavailable" ? "Unavailable" : error.code === "timeout" ? "Timed out" : error.message === "Failed to fetch" ? "Offline" : "Invalid topology");
    statusNode.dataset.state = "error";
  } finally {
    requestControllers.delete(controller);
    if (snapshotController === controller) snapshotController = null;
    if (generation === snapshotGeneration) {
      clearTimeout(freshnessTimer);
      if (state.token === token && !pageHidden) freshnessTimer = setTimeout(() => refreshSnapshot(), 10_000);
    }
  }
  return false;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshSnapshot(), 150);
}

function schedulePaneRefresh() {
  clearTimeout(paneRefreshTimer);
  paneRefreshTimer = setTimeout(() => {
    if (!state.token || !state.selectedBoard || pageHidden) return;
    refreshPanes();
  }, 250);
}

function refreshPanes() {
  for (const name of ["inbox", "bounties"]) {
    const pane = state[name];
    if (pane.pageIndex < 0) loadPane(name, null);
    else loadPane(name, pane.pageIndex === 0 ? null : pane.pages[pane.pageIndex - 1]?.next ?? null, true);
  }
}

function schedulePulseExpiry() {
  clearTimeout(pulseTimer);
  const next = Math.min(...state.pulses.map((pulse) => pulse.until));
  if (!Number.isFinite(next)) return;
  pulseTimer = setTimeout(() => drawTopology(), Math.max(0, next - Date.now()));
}

async function readEventStream(response, signal, onFrame) {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "text/event-stream" || !response.body) {
    await response.body?.cancel();
    throw new Error("Invalid event stream");
  }
  await consumeSseBody(response.body, signal, onFrame);
}

function waitForReconnect(delay, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delay);
    signal.addEventListener("abort", done, { once: true });
  });
}

function stopStream() {
  streamGeneration += 1;
  streamController?.abort();
  streamController = null;
  streamTask = null;
}

async function connectStream() {
  if (!state.token || !state.snapshot || pageHidden || streamTask) return;
  const token = state.token;
  const generation = ++streamGeneration;
  streamTask = (async () => {
    let delay = 500;
    let needsSnapshot = false;
    while (state.token === token && !pageHidden && generation === streamGeneration) {
      const controller = new AbortController();
      const fetchController = new AbortController();
      const abortFetch = () => fetchController.abort();
      let headerTimer = null;
      let timedOut = false;
      streamController = controller;
      try {
        if (needsSnapshot && !await refreshSnapshot()) {
          await waitForReconnect(delay, controller.signal);
          delay = Math.min(delay * 2, 10_000);
          continue;
        }
        needsSnapshot = false;
        if (generation !== streamGeneration || state.token !== token || pageHidden || controller.signal.aborted) break;
        const url = new URL("/v1/events", location.origin);
        url.searchParams.set("cursor", state.snapshot.cursor);
        controller.signal.addEventListener("abort", abortFetch, { once: true });
        headerTimer = setTimeout(() => { timedOut = true; fetchController.abort(); }, REQUEST_DEADLINE_MS);
        const response = await fetch(`${url.pathname}${url.search}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
          credentials: "omit", cache: "no-store", mode: "same-origin", redirect: "error", signal: fetchController.signal,
        });
        clearTimeout(headerTimer);
        if (timedOut) {
          await response.body?.cancel();
          throw new Error("Event stream handshake timed out");
        }
        if (generation !== streamGeneration || state.token !== token || pageHidden || controller.signal.aborted) {
          await response.body?.cancel();
          break;
        }
        if (!response.ok) {
          const failure = safeHttpError(response.status);
          const error = new Error(failure.label);
          error.code = failure.code;
          try { await response.body?.cancel(); }
          catch (cause) { error.cause = cause; }
          throw error;
        }
        setConnection("connected", "Connected");
        delay = 500;
        await readEventStream(response, controller.signal, (frame) => {
          if (generation !== streamGeneration || state.token !== token || pageHidden || controller.signal.aborted || !state.snapshot) return;
          if (frame.event === "reset") {
            resetForResync();
            throw new Error("Feed reset");
          }
          if (frame.event === "delta") {
            if (commitPulse(state, frame)) {
              drawTopology();
              schedulePulseExpiry();
            }
            state.snapshot.cursor = frame.cursor;
            scheduleRefresh();
            schedulePaneRefresh();
          }
        });
        if (!controller.signal.aborted) {
          setConnection("disconnected", "Reconnecting");
          needsSnapshot = true;
          await waitForReconnect(delay, controller.signal);
          delay = Math.min(delay * 2, 10_000);
        }
      } catch (error) {
        if (generation !== streamGeneration) break;
        if (controller.signal.aborted && (!state.token || pageHidden)) break;
        if (error.code === "auth" || error.code === "denied") { handleAuthFault(error, token); break; }
        setConnection(timedOut || error.code === "unavailable" ? "error" : "disconnected", timedOut ? "Timed out · reconnecting" : error.message === "Failed to fetch" ? "Offline · reconnecting" : "Reconnecting");
        needsSnapshot = true;
        await waitForReconnect(delay, controller.signal);
        delay = Math.min(delay * 2, 10_000);
      } finally {
        clearTimeout(headerTimer);
        controller.signal.removeEventListener("abort", abortFetch);
        if (streamController === controller) streamController = null;
      }
    }
  })().finally(() => { if (generation === streamGeneration) streamTask = null; });
}

async function connect() {
  clearPrivateState();
  const input = byId("token");
  const token = input.value.trim();
  input.value = "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    setConnection("error", "Invalid token");
    return;
  }
  state.token = token;
  setConnection("disconnected", "Connecting");
  await refreshSnapshot();
}

byId("auth-form").addEventListener("submit", (event) => {
  event.preventDefault();
  connect();
});
boardPicker.addEventListener("change", () => chooseBoard(boardPicker.value));
topologyNode.addEventListener("select-node", (event) => {
  if (!state.snapshot?.devices.some((row) => row.id === event.detail) && !state.snapshot?.agents.some((row) => row.id === event.detail)) return;
  state.selectedNode = event.detail;
  renderViews();
});
topologyNode.addEventListener("select-board", (event) => chooseBoard(event.detail));
byId("node-filter").addEventListener("input", (event) => {
  topologyNode.query = event.target.value.slice(0, 128);
  renderViews();
});
byId("expand-all").addEventListener("click", () => topologyNode.expandAll());
byId("refresh").addEventListener("click", () => refreshSnapshot(true));
byId("disconnect").addEventListener("click", () => {
  clearTimeout(refreshTimer);
  snapshotController?.abort();
  clearPrivateState();
  setConnection("disconnected", "Disconnected");
});
document.addEventListener("keydown", (event) => {
  const filter = byId("node-filter");
  if (event.key === "Escape" && event.target === filter) {
    filter.value = "";
    topologyNode.query = "";
  } else if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target?.closest?.("input, select, textarea, [contenteditable]")) {
    event.preventDefault();
    filter.focus();
  }
});
for (const name of ["inbox", "bounties"]) {
  byId(`${name}-prev`).addEventListener("click", () => navigatePane(name, -1));
  byId(`${name}-next`).addEventListener("click", () => navigatePane(name, 1));
}
document.addEventListener("visibilitychange", () => {
  pageHidden = document.hidden;
  if (pageHidden) {
    snapshotController?.abort();
    cancelPaneRequests();
    state.pulses = [];
    clearTimeout(refreshTimer);
    clearTimeout(paneRefreshTimer);
    clearTimeout(pulseTimer);
    clearTimeout(freshnessTimer);
    drawTopology();
    stopStream();
    setConnection("disconnected", "Paused");
  }
  else if (state.token) {
    refreshSnapshot();
  }
});
renderViews();
