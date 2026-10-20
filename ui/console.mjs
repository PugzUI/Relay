import { LitElement, html, svg, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { filteredTopology } from "./filter.mjs";

const field = { attribute: false };
const MAX_VISIBLE_WORKERS = 24;
const NAVIGATION_KEYS = ["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight"];
const HORIZONTAL_KEYS = ["ArrowLeft", "ArrowRight"];
const NODE_CONTROLS =
  "button[data-entity], button[data-board], button[data-collapse], button[data-worker-overflow]";
const NODE_ENDPOINTS = "button[data-entity], button[data-board]";
const compareId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const slotKey = (slot) => {
  const trimmed = slot.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
};
const compareSlot = (a, b) => {
  if (a.slot === "prime") {
    if (b.slot === "prime") return 0;
    return -1;
  }
  if (b.slot === "prime") return 1;
  const left = slotKey(a.slot),
    right = slotKey(b.slot);
  if (left.length !== right.length) return left.length - right.length;
  if (left !== right) return left < right ? -1 : 1;
  return compareId(a, b);
};
const timestamp = (time) => {
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "time unknown";
};
const count = (value) => (value === null || value === undefined ? "—" : String(value));

function age(receivedAt, time, local = false, stale = false) {
  if (local) return "local";
  if (receivedAt === null || receivedAt > time) return "age unknown · stale";
  return `${Math.floor((time - receivedAt) / 1000)}s${stale || time - receivedAt > 30_000 ? " · stale" : ""}`;
}

function deviceFresh(device, snapshot) {
  return (
    device.authority === snapshot.authority ||
    (!device.stale &&
      device.receivedAt !== null &&
      device.receivedAt <= snapshot.time &&
      snapshot.time - device.receivedAt <= 30_000)
  );
}

function signal(element, name, id) {
  element.dispatchEvent(new CustomEvent(name, { detail: id, bubbles: true }));
}

// Inspector selection resolves a worker, a board or a device from the same snapshot.
function inspectSelection(snapshot, selection) {
  const agent = snapshot?.agents.find((row) => row.id === selection) ?? null;
  const device = snapshot?.devices.find((row) => row.id === (agent?.device ?? selection)) ?? null;
  const board = snapshot?.boards.find((row) => row.id === selection) ?? null;
  return { agent, device, board, entity: agent ?? board ?? device };
}

function isFilteredOut(visible, target) {
  if (!visible.filter.active) return false;
  if (target.agent)
    return !visible.groups.some((group) =>
      group.agents.some((worker) => worker.id === target.agent.id),
    );
  if (target.board) return !visible.boards.some((row) => row.id === target.board.id);
  return !visible.groups.some((group) => group.device.id === target.device.id);
}

function agentFields(agent, device, snapshot) {
  return [
    ["State", agent.state],
    ["Device", device?.name ?? agent.device],
    ["Runtime", agent.runtime],
    ["Slot", agent.slot],
    ["Epoch", agent.epoch],
    ["Assignments", agent.assignmentCount],
    ["Capabilities", agent.caps.join(", ") || "none"],
    [
      "Report age",
      age(
        agent.receivedAt,
        snapshot.time,
        device?.authority === snapshot.authority,
        agent.state === "stale",
      ),
    ],
    ["Created · UTC", timestamp(agent.init)],
  ];
}

function boardFields(board, snapshot) {
  return [
    ["Kind", board.kind],
    ["Source", board.reported ? "reported" : "local"],
    ["Authority", board.authority],
    ["Inbox", board.inbox],
    ["Pending", board.pending],
    ["Claimed", board.claimed],
    ["Terminal", board.terminal],
    ["Report age", age(board.receivedAt, snapshot.time, !board.reported)],
  ];
}

function deviceFields(device, snapshot) {
  const fresh = deviceFresh(device, snapshot);
  return [
    ["Name", device.name],
    ["Authority", device.authority],
    ["State", fresh ? "registered" : "stale"],
    ["Free slots", fresh ? count(device.free) : "unknown"],
    [
      "Report age",
      age(device.receivedAt, snapshot.time, device.authority === snapshot.authority, device.stale),
    ],
    ["Created · UTC", timestamp(device.init)],
  ];
}

function inspectorFields(target, snapshot) {
  if (target.agent) return agentFields(target.agent, target.device, snapshot);
  if (target.board) return boardFields(target.board, snapshot);
  return deviceFields(target.device, snapshot);
}

function inspectorKind(target) {
  if (target.agent) return "Worker";
  if (target.board) return "Board";
  return "Device";
}

function inspectorContext(target, connection, filteredOut) {
  return [
    inspectorKind(target),
    connection !== "connected" ? "cached" : "",
    filteredOut ? "filtered out" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// Topology links are drawn as orthogonal routes between measured node boxes.
function pathGeometry(a, b, bounds) {
  if (Math.abs(a.top - b.top) > a.height && Math.abs(a.left - b.left) < a.width / 2) {
    const x1 = a.left - bounds.left + 12,
      x2 = b.left - bounds.left;
    const y1 = a.bottom - bounds.top,
      y2 = b.top - bounds.top + b.height / 2;
    return `M ${x1} ${y1} V ${y2} H ${x2}`;
  }
  const rightward = b.left >= a.right;
  const x1 = (rightward ? a.right : a.left) - bounds.left;
  const x2 = (rightward ? b.left : b.right) - bounds.left;
  const y1 = a.top - bounds.top + a.height / 2,
    y2 = b.top - bounds.top + b.height / 2;
  const middle = (x1 + x2) / 2;
  return `M ${x1} ${y1} H ${middle} V ${y2} H ${x2}`;
}

function branchToggle(key, closed) {
  if (key === "ArrowLeft") return !closed;
  if (key === "ArrowRight") return closed;
  return false;
}

// Measured links and live pulses become the path list rendered in the SVG layer.
function collectPaths(snapshot, pulses, endpoints, bounds, selected) {
  const next = [];
  const add = (id, from, to, kind) => {
    const a = endpoints.get(from),
      b = endpoints.get(to);
    if (!a || !b) return;
    const touches =
      selected !== null && selected !== undefined && (from === selected || to === selected);
    next.push({ id, d: pathGeometry(a, b, bounds), kind, selected: kind !== "pulse" && touches });
  };
  for (const link of snapshot.links)
    add(`link:${link.id}`, link.from, link.to, link.state === "active" ? "current" : "uncertain");
  for (const [index, pulse] of pulses.entries())
    if (pulse.until > Date.now()) add(`pulse:${index}`, pulse.from, pulse.to, "pulse");
  return next;
}

function focusControl(controls, index, key) {
  const last = controls.length - 1;
  const offset = key === "ArrowDown" ? 1 : -1;
  const target =
    key === "Home" ? 0 : key === "End" ? last : Math.min(last, Math.max(0, index + offset));
  controls[target]?.focus();
}

// Light DOM keeps one external theme and the existing strict style-src policy.
class ConsoleElement extends LitElement {
  createRenderRoot() {
    return this;
  }
}

class RelayOverview extends ConsoleElement {
  static properties = { snapshot: field, connection: field };
  constructor() {
    super();
    this.snapshot = null;
    this.connection = "disconnected";
  }
  render() {
    const snapshot = this.snapshot;
    const metrics = [
      ["Devices", snapshot?.totals.devices],
      ["Workers", snapshot?.totals.agents],
      ["Boards", snapshot?.totals.boards],
      ["Busy · visible", snapshot?.agents.filter((agent) => agent.state === "busy").length],
      ["Active links · visible", snapshot?.links.filter((link) => link.state === "active").length],
    ];
    return html`<dl class="overview-rail" data-cached=${Boolean(snapshot && this.connection !== "connected")}>
      ${metrics.map(([label, value]) => html`<div class="overview-metric"><dt>${label}</dt><dd>${count(value)}</dd></div>`)}
    </dl>`;
  }
}

class RelayInspector extends ConsoleElement {
  static properties = { snapshot: field, selection: field, query: field, connection: field };
  constructor() {
    super();
    this.snapshot = null;
    this.selection = null;
    this.query = "";
    this.connection = "disconnected";
  }
  render() {
    const snapshot = this.snapshot;
    const target = inspectSelection(snapshot, this.selection);
    const entity = target.entity;
    if (!entity)
      return html`<div class="inspector-empty">${snapshot ? "Select a device, worker or board" : "No snapshot"}</div>`;
    const visible = filteredTopology(snapshot, this.query, (entry) =>
      deviceFresh(entry, snapshot) ? "registered" : "stale",
    );
    const filteredOut = isFilteredOut(visible, target);
    const rows = inspectorFields(target, snapshot);
    const context = inspectorContext(target, this.connection, filteredOut);
    const links = snapshot.links.filter((link) => link.from === entity.id || link.to === entity.id);
    return html`<div class="inspector-identity"><span class="eyebrow">${context}</span><h3>${entity.id}</h3></div>
      <h3 class="inspector-section-label">Details</h3>
      <dl class="inspector-fields">${rows.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>
      <h3 class="inspector-section-label">Links · ${links.length}</h3>
      ${
        links.length
          ? html`<ul class="inspector-links">${links.slice(0, 6).map(
              (link) => html`<li>
        <span class="inspector-link-direction">${link.from === entity.id ? "to" : "from"}</span>
        <span class="inspector-link-target">${link.from === entity.id ? link.to : link.from}</span>
        <span class="inspector-link-state">${link.kind} · ${link.state}</span>
      </li>`,
            )}${links.length > 6 ? html`<li class="inspector-link-overflow">${links.length - 6} more links</li>` : nothing}</ul>`
          : html`<p class="inspector-no-links">No current links</p>`
      }`;
  }
}

class RelayTopology extends ConsoleElement {
  static properties = {
    snapshot: field,
    selectedBoard: field,
    selectedNode: field,
    pulses: field,
    query: field,
    connection: field,
    paths: { state: true },
    collapsed: { state: true },
    expanded: { state: true },
  };
  constructor() {
    super();
    this.snapshot = null;
    this.selectedBoard = null;
    this.selectedNode = null;
    this.pulses = [];
    this.query = "";
    this.connection = "disconnected";
    this.paths = [];
    this.collapsed = new Set();
    this.expanded = new Set();
    this.onResize = () => this.measurePaths();
    this.addEventListener("keydown", (event) => this.navigate(event));
  }
  connectedCallback() {
    super.connectedCallback();
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(this);
    } else window.addEventListener("resize", this.onResize, { passive: true });
  }
  disconnectedCallback() {
    this.observer?.disconnect();
    window.removeEventListener("resize", this.onResize);
    super.disconnectedCallback();
  }
  updated(changed) {
    if (changed.has("snapshot")) {
      const ids = new Set(this.snapshot?.devices.map((device) => device.id));
      const retained = new Set([...this.collapsed].filter((id) => ids.has(id)));
      if (retained.size !== this.collapsed.size) this.collapsed = retained;
      const expanded = new Set([...this.expanded].filter((id) => ids.has(id)));
      if (expanded.size !== this.expanded.size) this.expanded = expanded;
    }
    if (
      [
        "snapshot",
        "query",
        "collapsed",
        "expanded",
        "pulses",
        "selectedNode",
        "selectedBoard",
      ].some((key) => changed.has(key))
    )
      this.measurePaths();
  }
  toggle(id) {
    if (this.query.trim()) return;
    const next = new Set(this.collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.collapsed = next;
  }
  expandAll() {
    this.collapsed = new Set();
  }
  toggleWorkers(id) {
    const next = new Set(this.expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expanded = next;
  }
  isCollapsed(id) {
    return !this.query.trim() && this.collapsed.has(id);
  }
  navigate(event) {
    if (!NAVIGATION_KEYS.includes(event.key)) return;
    if (this.query.trim() && HORIZONTAL_KEYS.includes(event.key)) return;
    const controls = [...this.querySelectorAll(NODE_CONTROLS)].filter((button) => !button.disabled);
    const index = controls.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    if (HORIZONTAL_KEYS.includes(event.key)) {
      this.toggleBranch(event);
      return;
    }
    focusControl(controls, index, event.key);
  }
  toggleBranch(event) {
    const branch = event.target.closest(".topology-branch");
    const id = branch?.dataset.device;
    if (!id) return;
    const closed = this.isCollapsed(id);
    if (!branchToggle(event.key, closed)) return;
    if (event.key === "ArrowLeft") branch.querySelector("button[data-collapse]").focus();
    this.toggle(id);
  }
  measurePaths() {
    const surface = this.querySelector(".topology-surface");
    if (!surface || !this.snapshot) {
      if (this.paths.length) this.paths = [];
      return;
    }
    const bounds = surface.getBoundingClientRect();
    const endpoints = new Map(
      [...this.querySelectorAll(NODE_ENDPOINTS)].map((element) => [
        element.dataset.entity ?? element.dataset.board,
        element.getBoundingClientRect(),
      ]),
    );
    const next = collectPaths(
      this.snapshot,
      this.pulses,
      endpoints,
      bounds,
      this.selectedNode ?? this.selectedBoard,
    );
    if (JSON.stringify(next) !== JSON.stringify(this.paths)) this.paths = next;
    const svg = this.querySelector(".topology-svg");
    svg?.setAttribute("viewBox", `0 0 ${Math.max(1, bounds.width)} ${Math.max(1, bounds.height)}`);
  }
  worker(agent, device) {
    return html`<li class="worker-row"><button class="node worker-node" type="button" data-entity=${agent.id}
      aria-pressed=${String(this.selectedNode === agent.id)} data-state=${agent.state}
      @click=${() => signal(this, "select-node", agent.id)}>
      <span class="node-symbol" aria-hidden="true">${agent.slot === "prime" ? "P" : "W"}</span>
      <span class="node-identity"><span class="node-name">${agent.runtime}<span class="node-slot">:${agent.slot}</span></span><span class="node-id">${agent.id}</span></span>
      <span class="node-state">${agent.state}</span>
      <span class="node-detail">${agent.caps.join(" · ") || "caps none"} · assignments ${agent.assignmentCount} · ${age(agent.receivedAt, this.snapshot.time, device.authority === this.snapshot.authority, agent.state === "stale")}</span>
    </button></li>`;
  }
  board(board) {
    return html`<li><button class="node board-node" type="button" data-board=${board.id}
      aria-pressed=${String(this.selectedBoard === board.id)} @click=${() => signal(this, "select-board", board.id)}>
      <span class="node-symbol" aria-hidden="true">B</span><span class="node-identity"><span class="node-name">${board.id}</span><span class="node-id">${board.kind === "bounty" ? "Bounty board" : "Host board"}</span></span>
      <span class="node-state">${board.reported ? "reported" : "local"}</span>
      <span class="node-detail">inbox ${board.inbox} · pending ${board.pending} · claimed ${board.claimed} · terminal ${board.terminal}</span>
      <span class="node-detail">${age(board.receivedAt, this.snapshot.time, !board.reported)}</span>
    </button></li>`;
  }
  workerGroups(groups) {
    return groups
      .sort((a, b) => compareId(a.device, b.device))
      .map(({ device, agents: matching }) => {
        const agents = matching.sort(compareSlot);
        const overflow = agents.length > MAX_VISIBLE_WORKERS;
        const expanded = overflow && this.expanded.has(device.id);
        const visibleAgents = expanded ? agents : agents.slice(0, MAX_VISIBLE_WORKERS);
        return {
          device,
          agents: visibleAgents,
          total: agents.length,
          hidden: Math.max(0, agents.length - visibleAgents.length),
          overflow,
          expanded,
        };
      });
  }
  collapseControl(device, query, collapsed) {
    return html`<button class="collapse-control" type="button" data-collapse=${device.id} ?disabled=${Boolean(query)} aria-label=${`${collapsed ? "Expand" : "Collapse"} ${device.name}`} aria-expanded=${String(!collapsed)} @click=${() => this.toggle(device.id)}>${collapsed ? "+" : "−"}</button>`;
  }
  deviceNode(device, total) {
    const snapshot = this.snapshot;
    const fresh = deviceFresh(device, snapshot);
    const free = fresh && device.free !== null ? count(device.free) : "unknown";
    return html`<button class="node device-node" type="button" data-entity=${device.id} aria-pressed=${String(this.selectedNode === device.id)} @click=${() => signal(this, "select-node", device.id)}>
      <span class="node-symbol" aria-hidden="true">D</span><span class="node-identity"><span class="node-name">${device.name}</span><span class="node-id">${device.id}</span></span>
      <span class="node-state">${fresh ? "registered" : "stale"}</span>
      <span class="node-detail">${total} workers · free ${free} · ${age(device.receivedAt, snapshot.time, device.authority === snapshot.authority, device.stale)}</span>
    </button>`;
  }
  workerRows(group) {
    const { device, agents, hidden, overflow, expanded } = group;
    return html`<ul class="worker-rows">${repeat(
      agents,
      (agent) => agent.id,
      (agent) => this.worker(agent, device),
    )}${overflow ? html`<li class="worker-summary"><button class="quiet-button summary-control" type="button" data-worker-overflow=${device.id} aria-expanded=${String(expanded)} @click=${() => this.toggleWorkers(device.id)}>${expanded ? "Show fewer workers" : `${hidden} more workers · expand`}</button></li>` : nothing}${agents.length || hidden ? nothing : html`<li class="branch-empty">No workers</li>`}</ul>`;
  }
  branch(group) {
    const { device, total } = group;
    const query = this.query.trim();
    const collapsed = this.isCollapsed(device.id);
    return html`<section class="topology-branch" data-device=${device.id} aria-label=${device.name}>
      <div class="device-row">${this.collapseControl(device, query, collapsed)}
        ${this.deviceNode(device, total)}</div>
      ${collapsed ? nothing : this.workerRows(group)}
    </section>`;
  }
  render() {
    const snapshot = this.snapshot;
    if (!snapshot)
      return html`<div class="topology-empty"><span class="empty-glyph" aria-hidden="true">[ — ]</span><span>No snapshot</span></div>`;
    const query = this.query.trim();
    const filtered = filteredTopology(snapshot, query, (device) =>
      deviceFresh(device, snapshot) ? "registered" : "stale",
    );
    const groups = this.workerGroups(filtered.groups);
    const boards = filtered.boards.sort(compareId);
    if (!groups.length && !boards.length)
      return html`<div class="topology-empty"><span class="empty-glyph" aria-hidden="true">[ — ]</span><span>${query ? "No matching nodes" : "No devices, workers or boards"}</span></div>`;
    return html`<div class="topology-viewport" data-cached=${this.connection !== "connected"} tabindex="0" aria-label="Topology viewport">
      <div class="topology-surface">
        <svg class="topology-svg" aria-hidden="true">${repeat(
          this.paths,
          (path) => path.id,
          (path) =>
            svg`<path class=${`topology-path path-${path.kind}${path.selected ? " path-selected" : ""}`} d=${path.d}></path>`,
        )}</svg>
        <div class="topology-columns">
          <div class="device-lane"><h3 class="topology-label">Devices / Workers</h3>
            ${repeat(
              groups,
              ({ device }) => device.id,
              (group) => this.branch(group),
            )}
          </div>
          <div class="board-lane"><h3 class="topology-label">Boards</h3><ul class="board-nodes">${repeat(
            boards,
            (board) => board.id,
            (board) => this.board(board),
          )}</ul></div>
        </div>
      </div>
    </div>`;
  }
}

customElements.define("relay-overview", RelayOverview);
customElements.define("relay-topology", RelayTopology);
customElements.define("relay-inspector", RelayInspector);
