import { Graph, createDockview, themeDark, Terminal, FitAddon } from "./assets/app.js";
const $ = (id) => document.getElementById(id);
let current = null,
  token = "",
  feed = null,
  connected = false,
  selection = { kind: "none" },
  dock,
  graph = null,
  baseline = true,
  lastAudit = 0;
const renderers = new Set(),
  sessions = new Map();
function dom(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function button(text, handler) {
  const b = dom("button", "", text);
  b.type = "button";
  b.onclick = handler;
  return b;
}
function notice(text) {
  $("connection").textContent = text;
}
async function action(input) {
  if (!connected) throw Error("Live feed disconnected. Reconnect before changing work.");
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Prototype-Token": token },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error);
  return data;
}
function command(worker, cmd) {
  return action({ action: "command", worker, command: cmd }).catch((e) => notice(e.message));
}
function choose(worker) {
  selection = { kind: "worker", id: worker };
  refresh();
  openSession(worker);
}
function openSession(worker) {
  if (!current?.workers.some((w) => w.id === worker && w.online)) {
    notice("No live fixture session available.");
    return;
  }
  const id = `session-${worker}`;
  const prior = dock.getPanel(id);
  if (prior) {
    prior.api.setActive();
    return;
  }
  dock.addPanel({
    id,
    component: "session",
    title: `Console · ${current.workers.find((w) => w.id === worker).slot}`,
    params: { worker },
    position: { referencePanel: "topology", direction: innerWidth < 850 ? "within" : "below" },
    initialHeight: 270,
    minimumHeight: 260,
  });
}
class BasePanel {
  constructor() {
    this.element = dom("div", "panel");
    renderers.add(this);
  }
  init(p) {
    this.params = p;
  }
  dispose() {
    renderers.delete(this);
  }
  updateState() {}
}
class TopologyPanel extends BasePanel {
  init(p) {
    super.init(p);
    this.host = dom("div", "graph-host");
    this.element.append(this.host);
    this.graph = new Graph({
      container: this.host,
      autoResize: true,
      background: { color: "#000" },
      grid: false,
      panning: true,
      mousewheel: { enabled: true, minScale: 0.35, maxScale: 2 },
      interacting: { edgeMovable: false, magnetConnectable: false },
      connecting: { allowBlank: false },
    });
    graph = this.graph;
    this.graph.addNode({
      id: "device",
      shape: "rect",
      x: 290,
      y: 20,
      width: 140,
      height: 42,
      label: "LOCAL FIXTURE",
      attrs: {
        body: { fill: "#000", stroke: "#9a9a9a", rx: 0, ry: 0 },
        label: { fill: "#c2c2c2", fontSize: 12, fontFamily: "monospace" },
      },
    });
    this.graph.addNode({
      id: "bounty",
      shape: "rect",
      x: 290,
      y: 155,
      width: 140,
      height: 48,
      label: "BOUNTY",
      attrs: {
        body: { fill: "#000", stroke: "#9a9a9a", rx: 0, ry: 0 },
        label: { fill: "#f4f4f4", fontSize: 12, fontFamily: "monospace" },
      },
    });
    this.graph.addEdge({
      id: "device-wire",
      source: "device",
      target: "bounty",
      attrs: { line: { stroke: "#646464", strokeWidth: 1, targetMarker: null } },
    });
    this.graph.on("node:click", ({ node }) => {
      if (node.id === "bounty") {
        selection = { kind: "board" };
        dock.getPanel("board")?.api.setActive();
        refresh();
      } else if (node.id === "device") {
        selection = { kind: "device" };
        refresh();
      } else choose(node.id);
    });
    this.observer = new ResizeObserver(() => {
      this.graph.resize(this.host.clientWidth, this.host.clientHeight);
      this.fit();
    });
    this.observer.observe(this.host);
    this.updateState();
  }
  fit() {
    this.graph?.zoomToFit({ padding: 45, maxScale: 1 });
  }
  updateState() {
    if (!current || !this.graph) return;
    for (const [i, w] of current.workers.entries()) {
      let n = this.graph.getCellById(w.id);
      const label = `${w.slot.toUpperCase()}\n${!w.online ? "OFFLINE" : w.mid ? "CLAIMED" : "READY"}`;
      if (!n) {
        n = this.graph.addNode({
          id: w.id,
          shape: "rect",
          x: 80 + i * 420,
          y: 330,
          width: 140,
          height: 48,
          label,
          attrs: {
            body: { fill: "#000", stroke: "#9a9a9a", rx: 0, ry: 0 },
            label: { fill: "#f4f4f4", fontSize: 12, fontFamily: "monospace" },
          },
        });
        this.graph.addEdge({
          id: `wire-${w.id}`,
          source: "bounty",
          target: w.id,
          router: { name: "manhattan" },
          attrs: { line: { stroke: "#646464", strokeWidth: 1, targetMarker: null } },
        });
      }
      n.attr("label/text", label);
      n.attr("body/stroke", selection.id === w.id ? "#c4ff00" : "#9a9a9a");
    }
    const pending = current.work.filter((w) => w.state === "pending").length;
    this.graph.getCellById("bounty").attr("label/text", `BOUNTY\n${pending} PENDING`);
  }
  pulse(event) {
    const edge = this.graph.getCellById(`wire-${event.worker}`);
    if (!edge) return;
    const color = event.type === "ack" ? "#f4f4f4" : "#c4ff00";
    edge.attr("line/stroke", color);
    const view = this.graph.findViewByCell(edge);
    const line = view?.container.querySelector("path:last-child");
    if (line) {
      line.classList.remove("signal-wire");
      void line.getBoundingClientRect();
      line.classList.add("signal-wire");
    }
    clearTimeout(this.pulseTimers?.get(edge.id));
    this.pulseTimers ??= new Map();
    this.pulseTimers.set(
      edge.id,
      setTimeout(() => {
        if (this.graph.getCellById(edge.id)) edge.attr("line/stroke", "#646464");
      }, 1100),
    );
  }
  dispose() {
    this.observer?.disconnect();
    for (const timer of this.pulseTimers?.values() ?? []) clearTimeout(timer);
    if (graph === this.graph) graph = null;
    this.graph.dispose();
    super.dispose();
  }
}
const BOARD_LANES = ["pending", "claimed", "done"];
const CLOSED_WORK_STATES = ["done", "failed", "rejected"];
function laneRows(work, state) {
  const states = state === "done" ? CLOSED_WORK_STATES : [state];
  return work.filter((w) => states.includes(w.state));
}
function workOwnerSlot(work) {
  const owner = current.workers.find((a) => a.mid === work.id);
  const claim = current.audit.findLast((e) => e.mid === work.id && e.type === "claim");
  return owner?.slot ?? current.workers.find((a) => a.id === claim?.worker)?.slot;
}
function workItem(work) {
  const item = dom("button", `work${selection.id === work.id ? " is-selected" : ""}`);
  item.type = "button";
  item.append(dom("div", "", work.data?.work?.task ?? work.id.slice(0, 8)));
  const slot = workOwnerSlot(work);
  item.append(
    dom("small", "", `${work.id.slice(0, 8)} · ${work.state}${slot ? ` · ${slot}` : ""}`),
  );
  item.onclick = () => {
    selection = { kind: "work", id: work.id };
    refresh();
    dock.getPanel("inspector")?.api.setActive();
  };
  return item;
}
class BoardPanel extends BasePanel {
  init(p) {
    super.init(p);
    this.element.append(dom("h2", "panel-heading", "Work board · committed Relay state"));
    this.board = dom("div", "board");
    this.element.append(this.board);
    this.updateState();
  }
  updateState() {
    if (!current) return;
    this.board.replaceChildren();
    for (const state of BOARD_LANES) {
      const lane = dom("section", "lane");
      const rows = laneRows(current.work, state);
      lane.append(dom("h3", "", `${state.toUpperCase()} / ${rows.length}`));
      for (const work of rows) lane.append(workItem(work));
      if (!rows.length) lane.append(dom("p", "work-empty", "No work"));
      this.board.append(lane);
    }
  }
}
class InspectorPanel extends BasePanel {
  init(p) {
    super.init(p);
    this.element.classList.add("inspector");
    this.updateState();
  }
  updateState() {
    this.element.replaceChildren();
    this.element.append(dom("h2", "", "Inspect / act"));
    this.element.append(this.renderAgentList());
    if (selection.kind === "work") {
      this.renderSelectedWork();
      return;
    }
    const worker = current?.workers.find((w) => w.id === selection.id);
    if (worker) {
      this.renderSelectedWorker(worker);
      return;
    }
    this.renderEmptySelection();
  }
  renderAgentList() {
    const list = dom("div", "agent-list");
    for (const w of current?.workers ?? []) {
      const b = button(w.slot, () => choose(w.id));
      b.setAttribute("aria-label", `Open ${w.slot} console`);
      list.append(b);
    }
    return list;
  }
  renderSelectedWork() {
    const work = current?.work.find((w) => w.id === selection.id);
    if (!work) {
      return;
    }
    this.element.append(
      dom("p", "", `${work.id} · ${work.state}`),
      dom("pre", "", JSON.stringify(work.data?.work, null, 2)),
    );
  }
  renderSelectedWorker(worker) {
    this.element.append(
      dom(
        "p",
        "",
        `${worker.id}\nPID ${worker.pid ?? "starting"} · epoch ${worker.epoch ?? "unknown"}\n${worker.online ? "Local fixture process connected" : "Process disconnected"}`,
      ),
    );
    const actions = dom("div", "actions");
    actions.append(
      button("Console", () => openSession(worker.id)),
      button("Run next", () => command(worker.id, "run")),
      button("Auto on", () => command(worker.id, "auto on")),
      button("Auto off", () => command(worker.id, "auto off")),
    );
    this.element.append(actions);
  }
  renderEmptySelection() {
    const message =
      selection.kind === "board"
        ? "Bounty board. Only committed store changes move packages."
        : selection.kind === "device"
          ? "Device container has no attachable session. Select a worker."
          : "Click a worker in X6 or use the keyboard-accessible console buttons above.";
    this.element.append(
      dom("p", "", message),
      dom(
        "p",
        "",
        "Commands execute in disposable fixture worker processes. Native AI sessions and arbitrary shells are not exposed.",
      ),
    );
  }
}
class EventsPanel extends BasePanel {
  init(p) {
    super.init(p);
    this.element.append(dom("h2", "panel-heading", "Commit journal"));
    this.list = dom("ol", "events");
    this.element.append(this.list);
    this.updateState();
  }
  updateState() {
    if (!current) return;
    this.list.replaceChildren();
    for (const event of current.audit.slice(-40).reverse()) {
      const row = dom("li");
      row.append(
        dom("time", "", new Date(event.time).toLocaleTimeString()),
        document.createTextNode(
          `${event.seq} / ${event.type}${event.mid ? ` / ${event.mid.slice(0, 8)}` : ""}`,
        ),
      );
      this.list.append(row);
    }
  }
}
class SessionPanel extends BasePanel {
  init(p) {
    super.init(p);
    this.worker = p.params.worker;
    this.element.className = "console-panel";
    const label = dom("div", "console-label", "Scoped fixture worker console · not an OS shell");
    const controls = dom("div", "console-actions");
    for (const [text, cmd] of [
      ["Run next", "run"],
      ["Claim only", "claim"],
      ["Complete", "complete"],
      ["Auto on", "auto on"],
      ["Auto off", "auto off"],
      ["Status", "status"],
    ])
      controls.append(button(text, () => command(this.worker, cmd)));
    this.host = dom("div", "terminal-host");
    this.element.append(label, controls, this.host);
    this.terminal = new Terminal({
      theme: { background: "#000000", foreground: "#c2c2c2", cursor: "#c4ff00" },
      fontSize: 12,
      fontFamily: "monospace",
      scrollback: 600,
      convertEol: true,
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.host);
    this.buffer = "";
    this.lastSeq = 0;
    this.terminal.onData((data) => this.handleInput(data));
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.host);
    sessions.set(this.worker, this);
    this.updateState();
    setTimeout(() => this.fit(), 30);
  }
  handleInput(data) {
    for (const ch of data) {
      this.handleChar(ch);
    }
  }
  handleChar(ch) {
    if (ch === "\r") {
      this.submitInput();
      return;
    }
    if (ch === "\x7f" && this.buffer.length) {
      this.buffer = this.buffer.slice(0, -1);
      this.terminal.write("\b \b");
      return;
    }
    if (/[a-z0-9 ]/i.test(ch) && this.buffer.length < 80) {
      this.buffer += ch;
      this.terminal.write(ch);
    }
  }
  submitInput() {
    const cmd = this.buffer.trim();
    this.buffer = "";
    this.terminal.write("\r\n");
    if (cmd) command(this.worker, cmd);
    this.terminal.write("> ");
  }
  fit() {
    if (this.host.clientWidth > 20 && this.host.clientHeight > 20) this.fitAddon.fit();
  }
  onShow() {
    this.fit();
  }
  updateState() {
    const w = current?.workers.find((w) => w.id === this.worker);
    if (!w) return;
    for (const line of w.logs)
      if (line.seq > this.lastSeq) {
        this.terminal.writeln(line.text);
        this.lastSeq = line.seq;
      }
  }
  dispose() {
    this.observer.disconnect();
    this.terminal.dispose();
    sessions.delete(this.worker);
    super.dispose();
  }
}
const components = {
  topology: TopologyPanel,
  board: BoardPanel,
  inspector: InspectorPanel,
  events: EventsPanel,
  session: SessionPanel,
};
function refresh() {
  for (const r of renderers) r.updateState();
  for (const b of document.querySelectorAll(
    ".console-actions button,.inspector .actions button,#post",
  ))
    b.disabled = !connected;
}
function connectFeed() {
  feed?.close();
  baseline = true;
  feed = new EventSource("/api/events");
  feed.onopen = () => {
    connected = true;
    notice("Connected · authoritative isolated Relay store");
    refresh();
  };
  feed.onerror = () => {
    connected = false;
    notice("Feed unavailable · showing cached state · controls cannot mutate until reconnected");
    refresh();
  };
  feed.onmessage = (e) => {
    const next = JSON.parse(e.data);
    const fresh = baseline
      ? []
      : next.audit.filter((a) => a.seq > lastAudit && ["claim", "ack", "post"].includes(a.type));
    lastAudit = Math.max(lastAudit, ...next.audit.map((a) => a.seq));
    baseline = false;
    current = next;
    refresh();
    for (const r of renderers) if (r instanceof TopologyPanel) for (const a of fresh) r.pulse(a);
  };
}
function defaults() {
  dock.clear();
  const narrow = innerWidth < 850;
  dock.addPanel({
    id: "topology",
    component: "topology",
    title: "Topology",
    initialWidth: 750,
    minimumHeight: 220,
  });
  dock.addPanel({
    id: "inspector",
    component: "inspector",
    title: "Inspector",
    position: { referencePanel: "topology", direction: narrow ? "within" : "right" },
    initialWidth: 320,
  });
  dock.addPanel({
    id: "board",
    component: "board",
    title: "Work board",
    position: { referencePanel: "topology", direction: "below" },
    initialHeight: 280,
    minimumHeight: 240,
  });
  dock.addPanel({
    id: "events",
    component: "events",
    title: "Commit journal",
    position: { referencePanel: "inspector", direction: "within" },
  });
  dock.getPanel("inspector")?.api.setActive();
  dock.getPanel("topology")?.api.setActive();
}
try {
  const response = await fetch("/api/bootstrap");
  if (!response.ok) throw Error(`Bootstrap failed (${response.status})`);
  const boot = await response.json();
  token = boot.token;
  current = boot.state;
  dock = createDockview($("workspace"), {
    theme: themeDark,
    createComponent: (options) => {
      const Constructor = components[options.name];
      if (!Constructor) throw Error("Unknown panel");
      return new Constructor();
    },
  });
  defaults();
  const observer = new ResizeObserver(() =>
    dock.layout($("workspace").clientWidth, $("workspace").clientHeight),
  );
  observer.observe($("workspace"));
  connectFeed();
  $("post").onclick = () => action({ action: "seed" }).catch((e) => notice(e.message));
  $("fit").onclick = () => graph?.zoomToFit({ padding: 45, maxScale: 1 });
  const layoutKey = `relay-workspace-${current.instance}`;
  $("save").onclick = () => {
    try {
      localStorage.setItem(layoutKey, JSON.stringify(dock.toJSON()));
      notice("Workspace layout saved for this fixture instance.");
    } catch (e) {
      notice(`Layout save failed: ${e.message}`);
    }
  };
  $("restore").onclick = () => {
    try {
      const saved = localStorage.getItem(layoutKey);
      if (!saved) {
        notice("No saved layout for this instance.");
        return;
      }
      if (saved.length > 131072) throw Error("Saved layout exceeds the fixture limit");
      dock.fromJSON(JSON.parse(saved));
      refresh();
      notice("Workspace layout restored.");
    } catch (e) {
      defaults();
      refresh();
      notice(`Layout restore failed: ${e.message}`);
    }
  };
  $("reset").onclick = () => {
    defaults();
    refresh();
  };
  $("disconnect").onclick = () => {
    if (connected) {
      feed.close();
      connected = false;
      $("disconnect").textContent = "Reconnect";
      notice("Feed disconnected · cached view · worker processes continue independently");
      refresh();
    } else {
      connectFeed();
      $("disconnect").textContent = "Disconnect";
    }
  };
  window.workspaceStudy = {
    get state() {
      return current;
    },
    get connected() {
      return connected;
    },
    get dock() {
      return dock;
    },
    get graph() {
      return graph;
    },
    get sessionPanels() {
      return sessions;
    },
    choose,
    command,
  };
  window.addEventListener(
    "pagehide",
    () => {
      observer.disconnect();
      feed?.close();
      dock.dispose();
    },
    { once: true },
  );
} catch (e) {
  notice(`Workspace failed: ${e.message}`);
  console.error(e);
}
