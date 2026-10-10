import {
  commitPulse,
  consumeSseBody,
  createUiState,
  mergeSnapshotPages,
  parseBoardPage,
  parseSnapshot,
  selectBoard,
} from "/state.mjs";

const PAGE_SIZE = 50;
const MAX_RESPONSE_BYTES = 1_048_576;
const REQUEST_DEADLINE_MS = 10_000;
const state = createUiState();
const requestControllers = new Set();
const paneControllers = new Map();
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
let resizeFallbackInstalled = false;
let resizeObserver = null;

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
  state.connection = value;
  connectionNode.dataset.state = value;
  connectionNode.textContent = label;
  statusNode.textContent = label;
  statusNode.dataset.state = value === "error" ? "error" : "";
  renderPane("inbox");
  renderPane("bounties");
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
  state.token = null;
  state.snapshot = null;
  state.selectedBoard = null;
  state.selectedNode = null;
  state.pulses = [];
  clearTimeout(pulseTimer);
  clearTimeout(paneRefreshTimer);
  state.inbox = { page: null, pages: [], pageIndex: -1, pageBase: 0, loading: false, error: null, generation: state.inbox.generation + 1 };
  state.bounties = { page: null, pages: [], pageIndex: -1, pageBase: 0, loading: false, error: null, generation: state.bounties.generation + 1 };
  stopStream();
  abortRequests();
  metaNode.textContent = "";
  topologyNode.replaceChildren();
  boardPicker.replaceChildren();
  boardPicker.disabled = true;
  clearPane("inbox");
  clearPane("bounties");
}

function handleAuthFault(error) {
  if (error?.code !== "auth" && error?.code !== "denied") return;
  clearPrivateState();
  byId("token").value = "";
  setConnection("error", error.code === "auth" ? "Authentication required" : "Denied");
}

async function requestJson(path, { signal, pane } = {}) {
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
      headers: { Authorization: `Bearer ${state.token}`, Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      mode: "same-origin",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = safeHttpError(response.status);
      const error = new Error(failure.label);
      error.code = failure.code;
      throw error;
    }
    const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
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
    if (error?.code === "auth" || error?.code === "denied") handleAuthFault(error);
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    requestControllers.delete(controller);
  }
}

async function loadSnapshot(signal) {
  const pages = [];
  let after = null;
  for (let pageNo = 0; pageNo < 32; pageNo += 1) {
    const url = new URL("/v1/topology", location.origin);
    url.searchParams.set("limit", "512");
    if (after) url.searchParams.set("after", after);
    const page = parseSnapshot(await requestJson(`${url.pathname}${url.search}`, { signal }));
    pages.push(page);
    if (page.complete) return mergeSnapshotPages(pages);
    after = page.next;
  }
  throw new Error("Topology page limit exceeded");
}

function boardAge(board, now) {
  if (board.authority === state.snapshot?.authority) return "local";
  if (board.receivedAt === null) return "age unknown · stale";
  const age = now - board.receivedAt;
  if (age < 0) return "age unknown · stale";
  const seconds = Math.floor(age / 1000);
  return `${seconds}s${board.reported && age <= 30_000 ? "" : " · stale"}`;
}

function timeLabel(time) {
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "time unknown";
}

function agentStatus(agent) {
  return agent.state;
}

function reportAge(receivedAt, now, stale, authority, localAuthority) {
  if (authority === localAuthority) return "local";
  if (receivedAt === null || receivedAt > now) return "age unknown · stale";
  const seconds = Math.floor((now - receivedAt) / 1000);
  return `${seconds}s${stale || now - receivedAt > 30_000 ? " · stale" : ""}`;
}

function compareSlot(left, right) {
  if (left.slot === "prime") return right.slot === "prime" ? 0 : -1;
  if (right.slot === "prime") return 1;
  const a = left.slot.replace(/^0+/, "") || "0";
  const b = right.slot.replace(/^0+/, "") || "0";
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function drawTopology(snapshot = state.snapshot) {
  topologyNode.replaceChildren();
  if (!snapshot) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "topology-svg");
  svg.setAttribute("aria-hidden", "true");
  topologyNode.append(svg);
  const addColumn = (title) => {
    const column = node("div", "topology-column");
    column.append(node("h3", "topology-label", title));
    topologyNode.append(column);
    return column;
  };
  for (const device of snapshot.devices) {
    const column = addColumn(`Device · ${device.name}`);
    const deviceButton = node("button", "node");
    deviceButton.type = "button";
    deviceButton.dataset.entity = device.id;
    deviceButton.setAttribute("aria-pressed", String(state.selectedNode === device.id));
    deviceButton.append(node("span", "node-id", device.id), node("span", "node-state", device.stale ? "stale" : "registered"));
    const age = device.receivedAt === null ? null : snapshot.time - device.receivedAt;
    const fresh = device.authority === snapshot.authority || (!device.stale && age !== null && age >= 0 && age <= 30_000);
    const free = !fresh || device.free === null ? "free unknown" : `free ${device.free}`;
    const ageLabel = reportAge(device.receivedAt, snapshot.time, device.stale, device.authority, snapshot.authority);
    deviceButton.append(node("span", "node-detail", `${free} · ${ageLabel} · ${device.authority}`));
    column.append(deviceButton);
    for (const agent of snapshot.agents.filter((row) => row.device === device.id).sort(compareSlot)) {
      const button = node("button", "node");
      button.type = "button";
      button.dataset.entity = agent.id;
      button.setAttribute("aria-pressed", String(state.selectedNode === agent.id));
      const id = node("span", "node-id", agent.id);
      if (agent.state === "busy") id.classList.add("node-activity");
      button.append(id, node("span", "node-state", agentStatus(agent)));
      button.append(node("span", "node-detail", `caps ${agent.caps.length ? agent.caps.join(", ") : "none"} · assignments ${agent.assignmentCount} · ${reportAge(agent.receivedAt, snapshot.time, agent.state === "stale", device.authority, snapshot.authority)}`));
      column.append(button);
    }
  }
  for (const board of snapshot.boards) {
    const column = addColumn(board.kind === "bounty" ? "Bounty board" : `Host board · ${board.id}`);
    const button = node("button", "node");
    button.type = "button";
    button.dataset.board = board.id;
    button.setAttribute("aria-pressed", String(state.selectedBoard === board.id));
    const reported = board.authority === snapshot.authority ? "local" : board.reported ? "reported" : "unreported";
    button.append(node("span", "node-id", board.id), node("span", "node-state", reported));
    button.append(node("span", "node-detail", `inbox ${board.inbox} · pending ${board.pending} · claimed ${board.claimed} · terminal ${board.terminal} · ${boardAge(board, snapshot.time)}`));
    button.addEventListener("click", () => chooseBoard(board.id));
    column.append(button);
  }
  topologyNode.querySelectorAll("button[data-entity]").forEach((button) => button.addEventListener("click", () => {
    state.selectedNode = button.dataset.entity;
    topologyNode.querySelectorAll("button[data-entity]").forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.entity === state.selectedNode)));
  }));
  boardPicker.replaceChildren();
  for (const board of snapshot.boards) {
    const option = document.createElement("option");
    option.value = board.id;
    option.textContent = board.id;
    boardPicker.append(option);
  }
  boardPicker.disabled = snapshot.boards.length === 0;
  if (state.selectedBoard && snapshot.boards.some((board) => board.id === state.selectedBoard)) boardPicker.value = state.selectedBoard;
  metaNode.textContent = `${snapshot.authority} · ${snapshot.visible.devices}/${snapshot.totals.devices} devices · ${snapshot.visible.agents}/${snapshot.totals.agents} agents · ${snapshot.visible.boards}/${snapshot.totals.boards} boards`;
  drawPaths(svg, snapshot);
  if (resizeObserver) resizeObserver.disconnect();
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => drawPaths(svg, snapshot));
    resizeObserver.observe(topologyNode);
  } else if (!resizeFallbackInstalled) {
    resizeFallbackInstalled = true;
    window.addEventListener("resize", () => state.snapshot && drawTopology(state.snapshot), { passive: true });
  }
}

function drawPaths(svg, snapshot) {
  if (!svg.isConnected) return;
  svg.replaceChildren();
  const bounds = topologyNode.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${Math.max(1, bounds.width)} ${Math.max(1, bounds.height)}`);
  const endpoints = new Map([...topologyNode.querySelectorAll("[data-entity], [data-board]")].map((element) => [element.dataset.entity ?? element.dataset.board, element]));
  const addPath = (from, to, active = false) => {
    const source = endpoints.get(from)?.getBoundingClientRect();
    const target = endpoints.get(to)?.getBoundingClientRect();
    if (!source || !target) return;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const x1 = source.left + source.width / 2 - bounds.left;
    const y1 = source.top + source.height / 2 - bounds.top;
    const x2 = target.left + target.width / 2 - bounds.left;
    const y2 = target.top + target.height / 2 - bounds.top;
    const middleX = (x1 + x2) / 2;
    line.setAttribute("d", `M ${x1} ${y1} C ${middleX} ${y1}, ${middleX} ${y2}, ${x2} ${y2}`);
    line.setAttribute("class", active ? "topology-path is-active" : "topology-path");
    svg.append(line);
  };
  for (const link of snapshot.links) if (link.state === "active") addPath(link.from, link.to);
  const now = Date.now();
  state.pulses = state.pulses.filter((pulse) => pulse.until > now);
  for (const pulse of state.pulses) addPath(pulse.from, pulse.to, true);
}

function chooseBoard(board) {
  if (board !== null && !state.snapshot?.boards.some((entry) => entry.id === board)) return;
  cancelPaneRequests();
  try { selectBoard(state, board); } catch { return; }
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
  }
}

function resetForResync() {
  clearTimeout(refreshTimer);
  clearTimeout(paneRefreshTimer);
  clearTimeout(pulseTimer);
  snapshotController?.abort();
  snapshotController = null;
  cancelPaneRequests();
  state.snapshot = null;
  state.selectedNode = null;
  state.pulses = [];
  selectBoard(state, null);
  topologyNode.replaceChildren();
  metaNode.textContent = "";
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
  rows.replaceChildren();
  if (!state.selectedBoard) return clearPane(name);
  const status = byId(`${name}-status`);
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
    for (const row of page.items) {
      const item = node("li", "record");
      item.append(node("span", "record-id", row.id), node("span", "record-state", row.state));
      if (name === "inbox" && row.data?.msg !== undefined) item.append(node("pre", "record-text", row.data.msg));
      else if (name === "bounties" && row.data?.work !== undefined) item.append(node("pre", "record-text", JSON.stringify(row.data.work, null, 2)));
      const metadata = name === "inbox"
        ? `seq ${row.seq} · ${timeLabel(row.init)}`
        : `seq ${row.seq} · ${row.needs.length ? `needs ${row.needs.join(", ")}` : "needs none"}${row.series ? ` · series ${row.series}` : ""} · ${timeLabel(row.init)}`;
      item.append(node("span", "record-meta", metadata));
      rows.append(item);
    }
  } else byId(`${name}-count`).textContent = "";
  byId(`${name}-prev`).disabled = pane.loading || pane.pageIndex <= 0;
  byId(`${name}-next`).disabled = pane.loading || !page || page.complete;
  byId(`${name}-page`).textContent = pane.pageIndex >= 0 ? `Page ${pane.pageBase + pane.pageIndex + 1}` : "";
}

async function loadPane(name, after, reuse = false) {
  const pane = state[name];
  const generation = pane.generation;
  const selectedBoard = state.selectedBoard;
  const boardAuthority = state.snapshot?.boards.find((board) => board.id === selectedBoard)?.authority;
  if (!state.token || !selectedBoard || !boardAuthority) return;
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
    const page = parseBoardPage(raw, selectedBoard, name === "inbox" ? "msg" : "work", boardAuthority);
    if (generation !== pane.generation || selectedBoard !== state.selectedBoard || !state.token) return;
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

async function refreshSnapshot() {
  if (!state.token || pageHidden) return;
  const token = state.token;
  const wasConnected = state.connection === "connected";
  snapshotController?.abort();
  const controller = requestController();
  snapshotController = controller;
  const generation = ++snapshotGeneration;
  try {
    const snapshot = await loadSnapshot(controller.signal);
    if (state.token !== token || controller.signal.aborted || generation !== snapshotGeneration) return;
    state.snapshot = snapshot;
    let selectedChanged = false;
    if (!state.selectedBoard || !snapshot.boards.some((board) => board.id === state.selectedBoard)) {
      const preferred = snapshot.boards.find((board) => board.kind === "bounty")?.id ?? snapshot.boards[0]?.id ?? null;
      if (preferred !== state.selectedBoard) {
        cancelPaneRequests();
        selectBoard(state, preferred);
        selectedChanged = true;
      }
    }
    drawTopology(snapshot);
    setConnection("connected", "Connected");
    if (selectedChanged && state.selectedBoard) {
      refreshPanes();
    } else if (!wasConnected && state.selectedBoard) {
      refreshPanes();
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    if (error.code === "auth" || error.code === "denied") return;
    setConnection("error", error.code === "unavailable" ? "Unavailable" : error.code === "timeout" ? "Timed out" : error.message === "Failed to fetch" ? "Offline" : "Invalid topology");
    statusNode.dataset.state = "error";
  } finally {
    requestControllers.delete(controller);
    if (snapshotController === controller) snapshotController = null;
  }
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
  if (type !== "text/event-stream" || !response.body) throw new Error("Invalid event stream");
  await consumeSseBody(response.body, signal, onFrame);
}

function stopStream() {
  streamGeneration += 1;
  streamController?.abort();
  streamController = null;
  streamTask = null;
}

async function connectStream() {
  if (!state.token || !state.snapshot || pageHidden || streamTask) return;
  const generation = ++streamGeneration;
  streamTask = (async () => {
    let delay = 500;
    while (state.token && !pageHidden && generation === streamGeneration) {
      const controller = new AbortController();
      streamController = controller;
      try {
        const url = new URL("/v1/events", location.origin);
        url.searchParams.set("cursor", state.snapshot.cursor);
        const response = await fetch(`${url.pathname}${url.search}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${state.token}`, Accept: "text/event-stream" },
          credentials: "omit", cache: "no-store", mode: "same-origin", redirect: "error", signal: controller.signal,
        });
        if (!response.ok) {
          const failure = safeHttpError(response.status);
          const error = new Error(failure.label);
          error.code = failure.code;
          throw error;
        }
        setConnection("connected", "Connected");
        delay = 500;
        await readEventStream(response, controller.signal, (frame) => {
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
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 10_000);
          if (state.token && !pageHidden) await refreshSnapshot();
        }
      } catch (error) {
        if (generation !== streamGeneration) break;
        if (controller.signal.aborted && (!state.token || pageHidden)) break;
        if (error.code === "auth" || error.code === "denied") { handleAuthFault(error); break; }
        setConnection(error.code === "unavailable" ? "error" : "disconnected", error.message === "Failed to fetch" ? "Offline · reconnecting" : "Reconnecting");
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 10_000);
        if (!state.token || pageHidden || generation !== streamGeneration) break;
        await refreshSnapshot();
      } finally {
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
  if (state.token && state.snapshot) connectStream();
}

byId("auth-form").addEventListener("submit", (event) => {
  event.preventDefault();
  connect();
});
boardPicker.addEventListener("change", () => chooseBoard(boardPicker.value));
for (const name of ["inbox", "bounties"]) {
  byId(`${name}-prev`).addEventListener("click", () => navigatePane(name, -1));
  byId(`${name}-next`).addEventListener("click", () => navigatePane(name, 1));
}
document.addEventListener("visibilitychange", () => {
  pageHidden = document.hidden;
  if (pageHidden) {
    state.pulses = [];
    clearTimeout(pulseTimer);
    drawTopology();
    stopStream();
    setConnection("disconnected", "Paused");
  }
  else if (state.token) {
    refreshSnapshot().then(() => { if (state.snapshot) connectStream(); });
  }
});
