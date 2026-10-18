import { LitElement, html, svg, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";

const field = { attribute: false };
const MAX_VISIBLE_WORKERS = 24;
const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const compareSlot = (a, b) => {
  if (a.slot === "prime") return b.slot === "prime" ? 0 : -1;
  if (b.slot === "prime") return 1;
  const left = a.slot.replace(/^0+/, "") || "0", right = b.slot.replace(/^0+/, "") || "0";
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0) || compareId(a, b);
};
const timestamp = (time) => {
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "time unknown";
};
const count = (value) => value === null || value === undefined ? "—" : String(value);

function age(receivedAt, time, local = false, stale = false) {
  if (local) return "local";
  if (receivedAt === null || receivedAt > time) return "age unknown · stale";
  return `${Math.floor((time - receivedAt) / 1000)}s${stale || time - receivedAt > 30_000 ? " · stale" : ""}`;
}

function deviceFresh(device, snapshot) {
  return device.authority === snapshot.authority || (!device.stale && device.receivedAt !== null
    && device.receivedAt <= snapshot.time && snapshot.time - device.receivedAt <= 30_000);
}

function signal(element, name, id) {
  element.dispatchEvent(new CustomEvent(name, { detail: id, bubbles: true }));
}

// Light DOM keeps one external theme and the existing strict style-src policy.
class ConsoleElement extends LitElement {
  createRenderRoot() { return this; }
}

class RelayOverview extends ConsoleElement {
  static properties = { snapshot: field, connection: field };
  constructor() { super(); this.snapshot = null; this.connection = "disconnected"; }
  render() {
    const snapshot = this.snapshot;
    const metrics = [
      ["Devices", snapshot?.totals.devices], ["Workers", snapshot?.totals.agents], ["Boards", snapshot?.totals.boards],
      ["Busy · visible", snapshot?.agents.filter((agent) => agent.state === "busy").length],
      ["Active links · visible", snapshot?.links.filter((link) => link.state === "active").length],
    ];
    return html`<dl class="overview-rail" data-cached=${Boolean(snapshot && this.connection !== "connected")}>
      ${metrics.map(([label, value]) => html`<div class="overview-metric"><dt>${label}</dt><dd>${count(value)}</dd></div>`)}
    </dl>`;
  }
}

class RelayInspector extends ConsoleElement {
  static properties = { snapshot: field, selection: field, connection: field };
  constructor() { super(); this.snapshot = null; this.selection = null; this.connection = "disconnected"; }
  render() {
    const snapshot = this.snapshot;
    const agent = snapshot?.agents.find((row) => row.id === this.selection);
    const device = snapshot?.devices.find((row) => row.id === (agent?.device ?? this.selection));
    const board = snapshot?.boards.find((row) => row.id === this.selection);
    const entity = agent ?? board ?? device;
    if (!entity) return html`<div class="inspector-empty">${snapshot ? "Select a device, worker or board" : "No snapshot"}</div>`;
    let rows;
    if (agent) rows = [["State", agent.state], ["Device", device?.name ?? agent.device], ["Runtime", agent.runtime],
      ["Slot", agent.slot], ["Epoch", agent.epoch], ["Assignments", agent.assignmentCount],
      ["Capabilities", agent.caps.join(", ") || "none"], ["Report age", age(agent.receivedAt, snapshot.time, device?.authority === snapshot.authority, agent.state === "stale")],
      ["Created · UTC", timestamp(agent.init)]];
    else if (board) rows = [["Kind", board.kind], ["Source", board.reported ? "reported" : "local"], ["Authority", board.authority],
      ["Inbox", board.inbox], ["Pending", board.pending], ["Claimed", board.claimed], ["Terminal", board.terminal],
      ["Report age", age(board.receivedAt, snapshot.time, !board.reported)]];
    else rows = [["Name", device.name], ["Authority", device.authority], ["State", deviceFresh(device, snapshot) ? "registered" : "stale"],
      ["Free slots", deviceFresh(device, snapshot) ? count(device.free) : "unknown"],
      ["Report age", age(device.receivedAt, snapshot.time, device.authority === snapshot.authority, device.stale)],
      ["Created · UTC", timestamp(device.init)]];
    return html`<div class="inspector-identity"><span class="eyebrow">${agent ? "Worker" : board ? "Board" : "Device"}${this.connection !== "connected" ? " · cached" : ""}</span><h3>${entity.id}</h3></div>
      <dl class="inspector-fields">${rows.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>`;
  }
}

class RelayTopology extends ConsoleElement {
  static properties = { snapshot: field, selectedBoard: field, selectedNode: field, pulses: field,
    query: field, connection: field, paths: { state: true }, collapsed: { state: true }, expanded: { state: true } };
  constructor() {
    super();
    this.snapshot = null; this.selectedBoard = null; this.selectedNode = null; this.pulses = [];
    this.query = ""; this.connection = "disconnected"; this.paths = []; this.collapsed = new Set(); this.expanded = new Set();
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
    if (["snapshot", "query", "collapsed", "expanded", "pulses"].some((key) => changed.has(key))) this.measurePaths();
  }
  toggle(id) {
    if (this.query.trim()) return;
    const next = new Set(this.collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    this.collapsed = next;
  }
  expandAll() { this.collapsed = new Set(); }
  toggleWorkers(id) {
    if (this.query.trim()) return;
    const next = new Set(this.expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    this.expanded = next;
  }
  isCollapsed(id) { return !this.query.trim() && this.collapsed.has(id); }
  navigate(event) {
    if (!new Set(["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight"]).has(event.key)) return;
    if (this.query.trim() && ["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const controls = [...this.querySelectorAll("button[data-entity], button[data-board], button[data-collapse], button[data-worker-overflow]")].filter((button) => !button.disabled);
    const index = controls.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
      const branch = event.target.closest(".topology-branch");
      const id = branch?.dataset.device;
      if (!id) return;
      const closed = this.isCollapsed(id);
      if (event.key === "ArrowLeft" && !closed || event.key === "ArrowRight" && closed) {
        if (event.key === "ArrowLeft") branch.querySelector("button[data-collapse]").focus();
        this.toggle(id);
      }
      return;
    }
    const target = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1
      : Math.min(controls.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    controls[target]?.focus();
  }
  measurePaths() {
    const surface = this.querySelector(".topology-surface");
    if (!surface || !this.snapshot) {
      if (this.paths.length) this.paths = [];
      return;
    }
    const bounds = surface.getBoundingClientRect();
    const endpoints = new Map([...this.querySelectorAll("button[data-entity], button[data-board]")]
      .map((element) => [element.dataset.entity ?? element.dataset.board, element.getBoundingClientRect()]));
    const next = [];
    const add = (id, from, to, kind) => {
      const a = endpoints.get(from), b = endpoints.get(to);
      if (!a || !b) return;
      let x1, x2, y1, y2, d;
      if (Math.abs(a.top - b.top) > a.height && Math.abs(a.left - b.left) < a.width / 2) {
        x1 = a.left - bounds.left + 12; x2 = b.left - bounds.left;
        y1 = a.bottom - bounds.top; y2 = b.top - bounds.top + b.height / 2;
        d = `M ${x1} ${y1} V ${y2} H ${x2}`;
      } else {
        const rightward = b.left >= a.right;
        x1 = (rightward ? a.right : a.left) - bounds.left;
        x2 = (rightward ? b.left : b.right) - bounds.left;
        y1 = a.top - bounds.top + a.height / 2; y2 = b.top - bounds.top + b.height / 2;
        const middle = (x1 + x2) / 2;
        d = `M ${x1} ${y1} H ${middle} V ${y2} H ${x2}`;
      }
      next.push({ id, d, kind });
    };
    for (const link of this.snapshot.links) add(`link:${link.id}`, link.from, link.to, link.state === "active" ? "current" : "uncertain");
    for (const [index, pulse] of this.pulses.entries()) if (pulse.until > Date.now()) add(`pulse:${index}`, pulse.from, pulse.to, "pulse");
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
  render() {
    const snapshot = this.snapshot;
    if (!snapshot) return html`<div class="topology-empty"><span class="empty-glyph" aria-hidden="true">[ — ]</span><span>No snapshot</span></div>`;
    const query = this.query.trim().toLowerCase();
    const matches = (value) => value.toLowerCase().includes(query);
    const groups = [...snapshot.devices].sort(compareId).map((device) => {
      const all = snapshot.agents.filter((agent) => agent.device === device.id).sort(compareSlot);
      const agents = matches(`${device.name} ${device.id}`) ? all : all.filter((agent) => matches(`${agent.id} ${agent.caps.join(" ")}`));
      const visibleAgents = query || this.expanded.has(device.id) ? agents : agents.slice(0, MAX_VISIBLE_WORKERS);
      return { device, agents: visibleAgents, total: agents.length, hidden: Math.max(0, agents.length - visibleAgents.length) };
    }).filter(({ device, agents }) => matches(`${device.name} ${device.id}`) || agents.length);
    const boards = [...snapshot.boards].sort(compareId).filter((board) => matches(`${board.id} ${board.kind}`));
    if (!groups.length && !boards.length) return html`<div class="topology-empty"><span class="empty-glyph" aria-hidden="true">[ — ]</span><span>${query ? "No matching nodes" : "No devices, workers or boards"}</span></div>`;
    return html`<div class="topology-viewport" data-cached=${this.connection !== "connected"} tabindex="0" aria-label="Topology viewport">
      <div class="topology-surface">
        <svg class="topology-svg" aria-hidden="true">${repeat(this.paths, (path) => path.id, (path) => svg`<path class=${`topology-path path-${path.kind}`} d=${path.d}></path>`)}</svg>
        <div class="topology-columns">
          <div class="device-lane"><h3 class="topology-label">Devices / Workers</h3>
            ${repeat(groups, ({ device }) => device.id, ({ device, agents, total, hidden }) => html`<section class="topology-branch" data-device=${device.id} aria-label=${device.name}>
              <div class="device-row"><button class="collapse-control" type="button" data-collapse=${device.id} ?disabled=${Boolean(query)} aria-label=${`${this.isCollapsed(device.id) ? "Expand" : "Collapse"} ${device.name}`} aria-expanded=${String(!this.isCollapsed(device.id))} @click=${() => this.toggle(device.id)}>${this.isCollapsed(device.id) ? "+" : "−"}</button>
                <button class="node device-node" type="button" data-entity=${device.id} aria-pressed=${String(this.selectedNode === device.id)} @click=${() => signal(this, "select-node", device.id)}>
                  <span class="node-symbol" aria-hidden="true">D</span><span class="node-identity"><span class="node-name">${device.name}</span><span class="node-id">${device.id}</span></span>
                  <span class="node-state">${deviceFresh(device, snapshot) ? "registered" : "stale"}</span>
                  <span class="node-detail">${total} workers · free ${deviceFresh(device, snapshot) && device.free !== null ? count(device.free) : "unknown"} · ${age(device.receivedAt, snapshot.time, device.authority === snapshot.authority, device.stale)}</span>
                </button></div>
              ${this.isCollapsed(device.id) ? nothing : html`<ul class="worker-rows">${repeat(agents, (agent) => agent.id, (agent) => this.worker(agent, device))}${hidden ? html`<li class="worker-summary"><button class="quiet-button summary-control" type="button" data-worker-overflow=${device.id} @click=${() => this.toggleWorkers(device.id)}>${hidden} more workers · expand</button></li>` : nothing}${agents.length || hidden ? nothing : html`<li class="branch-empty">No workers</li>`}</ul>`}
            </section>`)}
          </div>
          <div class="board-lane"><h3 class="topology-label">Boards</h3><ul class="board-nodes">${repeat(boards, (board) => board.id, (board) => this.board(board))}</ul></div>
        </div>
      </div>
    </div>`;
  }
}

customElements.define("relay-overview", RelayOverview);
customElements.define("relay-topology", RelayTopology);
customElements.define("relay-inspector", RelayInspector);
