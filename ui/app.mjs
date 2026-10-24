import { LitElement, html, svg, nothing } from "lit";
import { Fleet, attentionFor, sessionState, statusOf } from "../src/fleet.mjs";
import { buildGraph } from "../src/graph.mjs";

const short = (value, length = 32) =>
  String(value || "—").length > length ? String(value).slice(0, length - 1) + "…" : String(value || "—");
const labelText = (value) => typeof value === "string" ? value : value?.markdown || "";
const when = (value) => value && !Number.isNaN(new Date(value).getTime())
  ? new Date(value).toLocaleString() : "Not reported";
const tail = (value) => String(value || "").split("/").filter(Boolean).at(-1) || value || "—";
const safeLink = (value) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};
const changeStats = (diff) => {
  const stats = [];
  if (Number.isInteger(diff?.added)) stats.push("+" + diff.added);
  if (Number.isInteger(diff?.removed)) stats.push("−" + diff.removed);
  return stats.join(" / ");
};
const summaryStats = (summary) => {
  if (!summary) return "Not reported";
  const stats = [];
  if (Number.isInteger(summary.files)) stats.push(summary.files + " files");
  if (Number.isInteger(summary.additions)) stats.push("+" + summary.additions);
  if (Number.isInteger(summary.deletions)) stats.push("−" + summary.deletions);
  return stats.join(" · ") || "Not reported";
};
const fileLabel = (file) => file.edit?.after?.uri || file.edit?.before?.uri || file.id;
const fileKind = (file) => {
  const { before, after } = file.edit || {};
  if (before && !after) return "Deleted";
  if (before && after && before.uri !== after.uri) return "Renamed";
  return "Changed";
};

function readAnswer(question, data) {
  const values = data.getAll(question.id).map(String).filter(Boolean);
  const kind = question.kind;
  const freeform = question.allowFreeformInput &&
    (kind === "single-select" || kind === "multi-select")
      ? String(data.get(question.id + ":freeform") || "").trim() : "";
  if (!values.length && !freeform && question.required)
    throw Error("Complete " + (question.title || question.message));
  if (!values.length && !freeform) return { state: "skipped" };
  let value;
  if (kind === "boolean") value = { kind: "boolean", value: values[0] === "true" };
  else if (kind === "number" || kind === "integer") {
    const number = Number(values[0]);
    if (!Number.isFinite(number) || (kind === "integer" && !Number.isInteger(number)))
      throw Error("Invalid number for " + question.id);
    value = { kind: "number", value: number };
  } else if (kind === "single-select") value = {
    kind: "selected", value: values[0] || "", ...(freeform ? { freeformValues: [freeform] } : {}),
  };
  else if (kind === "multi-select") value = {
    kind: "selected-many", value: values, ...(freeform ? { freeformValues: [freeform] } : {}),
  };
  else value = { kind: "text", value: values[0] };
  return { state: "submitted", value };
}

export class RelayFleet extends LitElement {
  createRenderRoot() { return this; }

  constructor() {
    super();
    this.fleet = new Fleet(() => {
      if (this.filePreview && this.filePreview.changesState !== this.fleet.changes) {
        this.filePreview = null;
      }
      this.requestUpdate();
    });
    this.activeHost = "";
    this.filterText = "";
    this.connectOpen = true;
    this.createOpen = false;
    this.busy = false;
    this.catalogLimit = 100;
    this.focusedNodeId = "";
    this.modelId = "";
    this.historyOffset = 0;
    this.explicitChatUri = "";
    this.sessionConfig = null;
    this.sessionConfigKey = "";
    this.configRevision = 0;
    this.filePreview = null;
    this.handleShortcuts = (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
          this.querySelector(".shortcuts-dialog")?.open ||
          event.target.closest?.("input, select, textarea, [contenteditable], [role='textbox']")) return;
      if (event.key === "/") {
        event.preventDefault();
        this.querySelector("#session-search")?.focus();
      } else if (event.key === "?") {
        event.preventDefault();
        this.openShortcuts();
      }
    };
    this.handleVisibility = () => {
      if (document.visibilityState === "visible" && this.fleet.selected &&
          this.fleet.currentHost()?.state.status === "connected" &&
          typeof this.fleet.refreshSelection === "function") {
        this.filePreview = null;
        void this.run(() => this.fleet.refreshSelection());
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleShortcuts);
    document.addEventListener("visibilitychange", this.handleVisibility);
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.handleShortcuts);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    super.disconnectedCallback();
    void this.fleet.shutdown();
  }

  openShortcuts() {
    const dialog = this.querySelector(".shortcuts-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  activateNode(node) {
    if (node.kind === "session") this.openSession(node.hostId, node.uri);
    else this.selectHost(node.hostId);
  }

  onGraphKey(event, node, graph) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.activateNode(node);
      return;
    }
    if (event.key === "Escape" && this.fleet.selected) {
      event.preventDefault();
      void this.run(() => this.fleet.select(null));
      return;
    }
    const direction = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[event.key];
    if (!direction && event.key !== "Home" && event.key !== "End") return;
    const origin = { x: node.x + node.w / 2, y: node.y + node.h / 2 };
    const candidates = graph.nodes.map((other, index) => {
      const dx = other.x + other.w / 2 - origin.x;
      const dy = other.y + other.h / 2 - origin.y;
      if (other.id === node.id ||
          (direction === "left" && dx >= -1) || (direction === "right" && dx <= 1) ||
          (direction === "up" && dy >= -1) || (direction === "down" && dy <= 1)) return null;
      const horizontal = direction === "left" || direction === "right";
      const primary = Math.abs(horizontal ? dx : dy);
      const transverse = Math.abs(horizontal ? dy : dx);
      return { index, score: primary + transverse * (horizontal ? 2.5 : 3) };
    }).filter(Boolean);
    const next = event.key === "Home"
      ? graph.nodes.findIndex((entry) => entry.kind === "host")
      : event.key === "End"
        ? Math.max(0, graph.nodes.findLastIndex((entry) => entry.kind === "session"))
        : candidates.sort((a, b) => a.score - b.score)[0]?.index;
    if (next === undefined || next < 0) return;
    event.preventDefault();
    this.focusedNodeId = graph.nodes[next].id;
    this.requestUpdate();
    event.currentTarget.parentElement.querySelector(`[data-node-index="${next}"]`)?.focus();
  }

  async run(action) {
    if (this.busy) return;
    this.busy = true;
    this.fleet.error = "";
    this.requestUpdate();
    try { await action(); }
    catch (error) { this.fleet.error = error?.message || String(error); }
    finally { this.busy = false; this.requestUpdate(); }
  }

  selectHost(id) {
    if (this.activeHost !== id) {
      this.modelId = "";
      this.sessionConfig = null;
      ++this.configRevision;
      this.historyOffset = 0;
      this.explicitChatUri = "";
      this.filePreview = null;
    }
    this.activeHost = id;
    if (this.fleet.selected && this.fleet.selected.hostId !== id) {
      void this.fleet.select(null);
    }
    this.requestUpdate();
    if (this.createOpen) {
      void this.updateComplete.then(() => this.resolveCreateConfig(this.querySelector(".create-form"), true));
    }
  }

  removeActiveHost(hostId) {
    void this.run(async () => {
      await this.fleet.removeHost(hostId);
      const next = this.fleet.hosts()[0];
      this.activeHost = next?.id || "";
      this.modelId = "";
      this.filePreview = null;
      this.historyOffset = 0;
      this.explicitChatUri = "";
      this.createOpen = false;
      this.sessionConfig = null;
      this.sessionConfigKey = "";
      ++this.configRevision;
    });
  }

  openSession(hostId, uri) {
    if (this.fleet.selected?.hostId !== hostId || this.fleet.selected?.uri !== uri) {
      this.modelId = "";
      this.historyOffset = 0;
      this.explicitChatUri = "";
      this.filePreview = null;
    }
    this.activeHost = hostId;
    void this.run(() => this.fleet.select({ hostId, uri }));
  }

  connect(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const form = event.currentTarget;
    void this.run(async () => {
      await this.fleet.addHost({
        label: data.get("label") || "",
        endpoint: data.get("endpoint") || "",
        token: data.get("token") || "",
      });
      this.activeHost = String(data.get("label")).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      form.reset();
      this.connectOpen = false;
    });
  }

  toggleCreate() {
    this.createOpen = !this.createOpen;
    this.sessionConfig = null;
    this.sessionConfigKey = "";
    ++this.configRevision;
    this.requestUpdate();
    if (this.createOpen) {
      void this.updateComplete.then(() => this.resolveCreateConfig(this.querySelector(".create-form"), true));
    }
  }

  readSessionConfig(data) {
    const schema = this.sessionConfig?.schema;
    const values = { ...(this.sessionConfig?.values || {}) };
    for (const [key, property] of Object.entries(schema?.properties || {})) {
      if (property.readOnly) continue;
      const raw = data.get("config:" + key);
      if (raw === null) continue;
      if (property.type === "array" && property.items?.type === "string") {
        values[key] = String(raw).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      } else if (raw === "") continue;
      else if (property.enum?.length && !property.enumDynamic) {
        const index = Number(raw);
        if (!Number.isInteger(index) || index < 0 || index >= property.enum.length) {
          throw Error("Invalid host option " + (property.title || key));
        }
        values[key] = property.enum[index];
      } else if (property.type === "boolean") {
        values[key] = raw === "true";
      } else if (property.type === "number") {
        const value = Number(raw);
        if (!Number.isFinite(value)) throw Error("Invalid host option " + (property.title || key));
        values[key] = value;
      } else if (property.type === "string") {
        values[key] = String(raw);
      }
    }
    return values;
  }

  async resolveCreateConfig(form, reset = false) {
    if (!form || this.busy || !this.createOpen) return;
    const data = new FormData(form);
    const hostId = this.activeHost;
    const provider = String(data.get("provider") || "");
    const directory = String(data.get("directory") || "");
    if (!provider) return;
    const key = JSON.stringify([hostId, provider, directory]);
    const config = reset ? {} : this.readSessionConfig(data);
    const revision = ++this.configRevision;
    await this.run(async () => {
      const result = await this.fleet.resolveSessionConfig({ hostId, provider, directory, config });
      if (this.configRevision === revision && this.createOpen && this.activeHost === hostId) {
        this.sessionConfig = result;
        this.sessionConfigKey = key;
      }
    });
  }

  createFormChanged(event) {
    const name = event.target.name || "";
    if (name === "provider") {
      this.sessionConfig = null;
      void this.resolveCreateConfig(event.currentTarget, true);
    } else if (name === "directory") {
      // The submit action resolves workspace-dependent schema itself. Starting
      // an RPC during input blur would steal the user's first submit click.
      this.sessionConfig = null;
      this.sessionConfigKey = "";
      ++this.configRevision;
      this.requestUpdate();
    } else if (name.startsWith("config:") && event.target.tagName === "SELECT") {
      void this.resolveCreateConfig(event.currentTarget);
    }
  }

  renderConfigField(key, property) {
    const value = this.sessionConfig.values?.[key] ?? property.default;
    const required = (this.sessionConfig.schema?.required || []).includes(key);
    const title = property.title || key;
    if (property.readOnly || !["string", "number", "boolean", "array"].includes(property.type) ||
        (property.type === "array" && property.items?.type !== "string")) {
      return html`<div class="host-option host-option-info"><strong>${title}</strong>
        <span>${property.readOnly ? "Managed by host" : "Advanced host setting"}${required ? " · Required" : ""}</span>
        ${property.description ? html`<small>${property.description}</small>` : nothing}
      </div>`;
    }
    let input;
    if (property.type === "array") {
      input = html`<textarea name="config:${key}" rows="3" spellcheck="false"
        placeholder="One entry per line" ?required=${required}
        .value=${Array.isArray(value) ? value.join("\n") : ""}></textarea>`;
    } else if (Array.isArray(property.enum) && !property.enumDynamic) {
      const index = property.enum.findIndex((candidate) => Object.is(candidate, value));
      input = html`<select name="config:${key}" .value=${index < 0 ? "" : String(index)} ?required=${required}>
        <option value="">${required ? "Choose an option" : "Host default"}</option>
        ${property.enum.map((choice, position) => html`<option value="${position}">${property.enumLabels?.[position] || String(choice)}</option>`)}
      </select>`;
    } else if (property.type === "boolean") {
      input = html`<select name="config:${key}" .value=${value === undefined ? "" : String(value)} ?required=${required}>
        <option value="">${required ? "Choose an option" : "Host default"}</option>
        <option value="true">Yes</option><option value="false">No</option>
      </select>`;
    } else {
      input = html`<input name="config:${key}" .value=${value == null ? "" : String(value)}
        type="${property.type === "number" ? "number" : "text"}" step=${property.type === "number" ? "any" : nothing}
        ?required=${required} spellcheck="false" autocomplete="off"
        list=${property.enumDynamic && property.enum?.length ? "choices-" + key : nothing}>
        ${property.enumDynamic && property.enum?.length ? html`
          <datalist id="choices-${key}">${property.enum.map((choice, position) =>
            html`<option value="${String(choice)}" label="${property.enumLabels?.[position] || String(choice)}"></option>`)}</datalist>` : nothing}`;
    }
    return html`<label class="host-option">${title}${input}
      ${property.description ? html`<small>${property.description}</small>` : nothing}
    </label>`;
  }

  create(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void this.run(async () => {
      const hostId = this.activeHost;
      const provider = String(data.get("provider") || "");
      const directory = String(data.get("directory") || "");
      const trust = data.get("trustWorkspace") === "on";
      const key = JSON.stringify([hostId, provider, directory]);
      let config;
      if (this.sessionConfig && this.sessionConfigKey === key) {
        const values = this.readSessionConfig(data);
        const result = await this.fleet.resolveSessionConfig({ hostId, provider, directory, config: values });
        this.sessionConfig = result;
        this.sessionConfigKey = key;
        config = { ...result.values, ...values };
      } else {
        const result = await this.fleet.resolveSessionConfig({ hostId, provider, directory });
        this.sessionConfig = result;
        this.sessionConfigKey = key;
        config = { ...(result.values || {}) };
      }
      const required = this.sessionConfig.schema?.required || [];
      if (required.some((field) => config[field] == null || config[field] === "" ||
          (Array.isArray(config[field]) && this.sessionConfig.schema.properties?.[field]?.minItems > config[field].length))) {
        throw Error("Complete the host-required session options");
      }
      await this.fleet.createSession({
        hostId, provider, directory, trust, ...(config ? { config } : {}),
      });
      this.modelId = "";
      this.sessionConfig = null;
      this.createOpen = false;
    });
  }

  submitPrompt(event) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("prompt");
    const message = input?.value || "";
    void this.run(() => {
      this.fleet.queueTurn(message, this.modelId || undefined);
      input.value = "";
    });
  }

  answer(event, entry) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void this.run(() => {
      const answers = {};
      for (const question of entry.request.questions || []) {
        answers[question.id] = readAnswer(question, data);
      }
      this.fleet.answerInput(entry, "accept", answers);
    });
  }

  confirm(entry, approved, selectedOptionId) {
    void this.run(() => this.fleet.confirmTool(entry, approved, selectedOptionId));
  }

  refreshSelected() {
    this.filePreview = null;
    void this.run(() => this.fleet.refreshSelection());
  }

  async inspectFile(fileId) {
    const { hostId, uri } = this.fleet.selected || {};
    const changesetUri = this.fleet.slots.changes?.uri;
    const previous = this.filePreview;
    if (previous?.hostId === hostId && previous?.sessionUri === uri &&
        previous?.changesState === this.fleet.changes &&
        previous?.changesetUri === changesetUri && previous.fileId === fileId) {
      this.filePreview = null;
      this.requestUpdate();
      return;
    }
    const preview = {
      hostId, sessionUri: uri, changesetUri, fileId, changesState: this.fleet.changes,
      before: null, after: null, loading: true, error: "",
    };
    this.filePreview = preview;
    this.requestUpdate();
    try {
      const result = await this.fleet.readEdit(fileId);
      if (this.filePreview !== preview || preview.changesState !== this.fleet.changes) return;
      preview.before = result.before;
      preview.after = result.after;
    } catch (error) {
      if (this.filePreview !== preview) return;
      preview.error = error?.message || String(error);
    } finally {
      if (this.filePreview === preview) {
        preview.loading = false;
        this.requestUpdate();
      }
    }
  }

  async earlierTurns(chat) {
    const end = Math.max(0, chat.turns.length - this.historyOffset);
    const start = Math.max(0, end - 40);
    if (start > 0) {
      this.historyOffset = chat.turns.length - start;
      this.requestUpdate();
    } else if (chat.turnsNextCursor) {
      const previouslyLoaded = chat.turns.length;
      await this.run(async () => {
        await this.fleet.loadOlderTurns();
        const current = this.fleet.chat?.turns.length || 0;
        if (current > previouslyLoaded) this.historyOffset = previouslyLoaded;
      });
    }
  }

  getView() {
    const hosts = this.fleet.hosts();
    const sessions = this.fleet.sessions();
    const activeHost = hosts.find((host) => host.id === this.activeHost) || hosts[0] || null;
    const selectedSummary = sessions.find((s) =>
      this.fleet.selected?.hostId === s.hostId &&
      this.fleet.selected?.uri === s.summary.resource)?.summary;
    const working = sessions.filter((s) =>
      sessionState(s.summary, hosts.find((h) => h.id === s.hostId)?.state.status === "connected") === "working").length;
    const attention = sessions.filter((s) => statusOf(s.summary.status) === "attention" &&
      hosts.find((h) => h.id === s.hostId)?.state.status === "connected").length;
    return { hosts, sessions, activeHost, selectedSummary, working, attention };
  }

  render() {
    const { hosts, sessions, activeHost, selectedSummary, working, attention } = this.getView();
    const online = hosts.filter((host) => host.state.status === "connected").length;
    const graph = buildGraph(hosts, sessions, this.filterText);
    const focusedNode = graph.nodes.find((node) => node.id === this.focusedNodeId) ||
      graph.nodes.find((node) => node.kind === "session" &&
        node.hostId === this.fleet.selected?.hostId && node.uri === this.fleet.selected?.uri) ||
      graph.nodes.find((node) => node.kind === "host") || graph.nodes[0];
    const selected = this.fleet.selected;
    const live = this.fleet.currentHost()?.state.status === "connected";
    const detail = this.fleet.session;
    const chat = this.fleet.chat;
    const selectableChats = (detail?.chats || []).filter((entry) =>
      entry.interactivity !== "hidden" || entry.resource === this.explicitChatUri);
    const promptPolicy = this.fleet.chatPromptPolicy;
    const chatAllowsInput = promptPolicy.allowsInput;
    const turns = chat?.turns || [];
    const historyEnd = Math.max(0, turns.length - this.historyOffset);
    const historyStart = Math.max(0, historyEnd - 40);
    const models = selected
      ? this.fleet.modelsFor(selected.hostId, detail?.provider || selectedSummary?.provider) : [];
    const changesets = this.fleet.availableChangesets?.() || [];
    const staticChangesets = changesets.filter((entry) => !entry.uriTemplate.includes("{"));
    const changes = this.fleet.changes;
    const changeset = this.fleet.changeset;
    const changesLoadError = this.fleet.slots.changes?.error;
    const preview = this.filePreview?.hostId === selected?.hostId &&
      this.filePreview?.sessionUri === selected?.uri &&
      this.filePreview?.changesState === changes &&
      this.filePreview?.changesetUri === this.fleet.slots.changes?.uri &&
      changes?.files?.some((file) => file.id === this.filePreview.fileId)
        ? this.filePreview : null;
    const canReviewChanges = changeset?.capabilities &&
      Object.prototype.hasOwnProperty.call(changeset.capabilities, "review");
    const sessionLoadError = this.fleet.slots.session?.error;
    const chatLoadError = this.fleet.slots.chat?.error;
    const filteredSessions = sessions.filter((s) => {
      const value = [s.hostLabel, s.summary.title, s.summary.provider,
        ...(s.summary.workingDirectories || [])].join(" ").toLowerCase();
      return this.filterText.toLowerCase().split(/\s+/).filter(Boolean)
        .every((term) => value.includes(term));
    });

    return html`
      <header class="bar">
        <div class="brand">
          <svg viewBox="0 0 26 26" aria-hidden="true"><path d="M2 3 H17 V10 H8 V23 H24 M17 3 H24 M8 16 H19" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          <span>Relay</span><span class="brand-separator"></span><span class="brand-detail">Fleet</span>
        </div>
        <div class="bar-right">
          <span class="pulse-marker ${online ? "online" : ""}" aria-hidden="true"></span>
          <span role="status" aria-live="polite">${online} / ${hosts.length} hosts online</span>
          <button class="primary small" @click=${() => { this.connectOpen = !this.connectOpen; this.requestUpdate(); }} aria-controls="connect-panel" aria-expanded=${this.connectOpen}>+ Connect host</button>
        </div>
      </header>
      <main id="main" class="workspace">
        <aside class="sidebar" aria-label="Fleet hosts">
          <div class="rail-title"><span>HOSTS</span><span>${hosts.length}</span></div>
          <div class="hosts-list">${hosts.map((host) => html`
            <button class="host-row ${activeHost?.id === host.id ? "selected" : ""}" @click=${() => this.selectHost(host.id)}
              aria-pressed=${activeHost?.id === host.id}>
              <span class="status-dot ${host.state.status}" aria-hidden="true"></span>
              <span class="host-text"><strong>${host.label}</strong><small>${host.state.status}</small></span>
              <span class="subtle">${host.sessionSummaries.length}</span>
            </button>
          `)}</div>
          ${hosts.length === 0 ? html`<p class="muted pad">No connected hosts. Add an AHP endpoint.</p>` : nothing}
          <div class="rail-title border-top"><span>FLEET SUMMARY</span></div>
          <div class="rail-data"><span>Sessions</span><b>${sessions.length}</b></div>
          <div class="rail-data"><span>In progress</span><b>${working}</b></div>
          <div class="rail-data"><span>Needs input</span><b class="${attention ? "warning" : ""}">${attention}</b></div>
          <div class="rail-data"><span>Advertised agents</span><b>${this.fleet.agents().length}</b></div>
          ${activeHost ? html`
            <div class="rail-title border-top"><span>ACTIVE HOST</span></div>
            <div class="rail-info">${activeHost.label}<small>${activeHost.protocolVersion ? "AHP " + activeHost.protocolVersion : "Protocol pending"}</small>
              ${activeHost.lastError ? html`<small class="host-error">${activeHost.lastError.message === "websocket failed to open"
                ? "WebSocket handshake failed. Check the host URL and access token."
                : activeHost.lastError.message}</small>` : nothing}
            </div>
            <div class="rail-actions">
              ${activeHost.state.status === "connected"
                ? html`<button class="quiet small" @click=${() => this.run(() => this.fleet.reconnect(activeHost.id))} ?disabled=${this.busy}>Reconnect</button>`
                : html`<button class="quiet small" @click=${() => { this.connectOpen = true; this.removeActiveHost(activeHost.id); }} ?disabled=${this.busy}>Fix connection</button>`}
              <button class="quiet small" @click=${() => this.removeActiveHost(activeHost.id)} ?disabled=${this.busy}>Remove</button>
            </div>
          ` : nothing}
        </aside>

        <section class="center">
          ${this.connectOpen ? html`
            <form id="connect-panel" class="connect-form" @submit=${this.connect}>
              <div class="section-label">NEW HOST <span>Credentials remain in this browser tab</span></div>
              <div class="form-grid">
                <label>Host label<input name="label" required placeholder="v-arch" autocomplete="off" spellcheck="false"></label>
                <label>AHP WebSocket<input name="endpoint" required type="url" placeholder="ws://127.0.0.1:9187" autocomplete="off" spellcheck="false"></label>
                <label>Access token<input name="token" type="password" required placeholder="Required" autocomplete="off">
                  <small>Read from the host's ~/.config/ahpd/connection-token file. Never share this token.</small>
                </label>
                <button class="primary" type="submit" ?disabled=${this.busy}>Connect</button>
              </div>
            </form>
          ` : nothing}
          ${this.fleet.error ? html`<div class="alert" role="alert"><span>ERROR</span> ${this.fleet.error}<button aria-label="Dismiss error" class="close" @click=${() => { this.fleet.error = ""; this.requestUpdate(); }}>×</button></div>` : nothing}
          <div class="metrics" aria-label="Fleet metrics">
            <div><b>${online}</b><span>Hosts online</span></div>
            <div><b>${this.fleet.agents().length}</b><span>Advertised agents</span></div>
            <div><b>${working}</b><span>Working sessions</span></div>
            <div><b class="${attention ? "warning" : ""}">${attention}</b><span>Requiring action</span></div>
          </div>

          <section class="topology-panel" aria-labelledby="topology-title">
            <div class="section-head">
              <div><span class="eyebrow">01 / OPERATIONS</span><h1 id="topology-title">Topology</h1></div>
              <div class="section-meta"><span class="muted mono">${graph.shown} / ${graph.total} sessions shown</span>
                <button class="quiet small" @click=${() => this.openShortcuts()} aria-keyshortcuts="?">Keys <kbd>?</kbd></button></div>
            </div>
            <div class="topology-tools">
              <label for="session-search">SEARCH FLEET</label>
              <input id="session-search" type="search" placeholder="Host, agent, session, workspace" aria-keyshortcuts="/" .value=${this.filterText}
                @input=${(e) => { this.filterText = e.target.value; this.catalogLimit = 100; this.requestUpdate(); }}
                @keydown=${(e) => { if (e.key === "Escape" && this.filterText) { e.preventDefault(); this.filterText = ""; e.currentTarget.value = ""; this.requestUpdate(); } }}>
              ${this.filterText ? html`<button class="quiet small" @click=${() => { this.filterText = ""; this.requestUpdate(); this.querySelector("#session-search")?.focus(); }}>Clear</button>`
                : html`<span class="search-hint">/ to focus</span>`}
            </div>
            <div class="legend" aria-label="Topology legend"><span><i class="legend-dot lime"></i> Selected / working</span><span><i class="legend-dot"></i> Connected</span><span><i class="legend-dot gold"></i> Needs input</span><span><i class="legend-dot stale"></i> Disconnected link</span></div>
            <p class="sr-only" id="map-instructions">Use Tab to enter the topology, arrow keys to move between nodes, Enter or Space to select, Escape to clear selection. The session catalog below offers the same sessions as a list.</p>
            <div class="map-viewport" role="region" aria-label="Scrollable fleet topology" tabindex="0">
              <div class="map-head" aria-hidden="true"><span>HOST</span><span>AGENT</span><span>SESSION</span></div>
              ${hosts.length && graph.nodes.length ? html`
                <svg class="map" viewBox="0 0 ${graph.width} ${graph.height}" role="group" aria-label="AHP host to agent to session topology" aria-describedby="map-instructions">
                  <defs><pattern id="topology-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 H 0 V 24" fill="none" stroke="#222" stroke-width=".5"></path></pattern></defs>
                  <rect class="map-grid" width="${graph.width}" height="${graph.height}" fill="url(#topology-grid)"></rect>
                  ${graph.edges.map((edge) => svg`<path class="edge ${edge.stale ? "stale" : ""} ${this.fleet.lastSignal && selected?.hostId === edge.hostId && selected?.uri === edge.sessionUri && this.fleet.lastSignal.uri === this.fleet.slots.chat?.uri ? "signal" : ""}" d="${edge.d}"></path>`)}
                  ${graph.nodes.map((node, index) => svg`
                    <g class="node ${node.kind} ${node.status} ${node.advertised === false ? "unadvertised" : ""} ${activeHost?.id === node.hostId && node.kind === "host" ? "active-host" : ""} ${selected?.hostId === node.hostId && selected?.uri === node.uri ? "chosen" : ""}"
                      role="button" tabindex="${node.id === focusedNode?.id ? "0" : "-1"}" data-node-index="${index}"
                      aria-label="${node.kind}: ${node.title}, ${node.subtitle}"
                      aria-pressed=${node.kind === "session" ? selected?.hostId === node.hostId && selected?.uri === node.uri : activeHost?.id === node.hostId}
                      @focus=${() => { this.focusedNodeId = node.id; this.requestUpdate(); }}
                      @click=${() => this.activateNode(node)}
                      @keydown=${(event) => this.onGraphKey(event, node, graph)}>
                      <title>${node.title} · ${node.subtitle}</title>
                      <rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}"></rect>
                      <rect class="node-accent" x="${node.x}" y="${node.y}" width="2" height="${node.h}"></rect>
                      <text class="node-name" x="${node.x + 13}" y="${node.y + 19}">${short(node.title, node.kind === "session" ? 34 : 25)}</text>
                      <text class="node-meta" x="${node.x + 13}" y="${node.y + 35}">${short(node.subtitle, 34)}</text>
                    </g>`)}
                </svg>
              ` : html`<div class="empty-map">${hosts.length ? "No nodes match this filter." : "No AHP hosts connected."}
                <span>${hosts.length ? "Adjust the search to inspect hosts and sessions." : "Connect a host to render its actual agent topology."}</span></div>`}
            </div>
            <p class="mobile-hint">Pan horizontally to inspect agents and sessions.</p>
            ${graph.total > graph.shown ? html`<p class="map-note">Topology displays the first ${graph.shown} of ${graph.total} matching sessions. Refine the search to locate a specific session.</p>` : nothing}
          </section>
          <section class="sessions-panel">
            <div class="section-head">
              <div><span class="eyebrow">02 / SESSION CATALOG</span><h2>Sessions</h2></div>
              <button class="small primary" @click=${() => this.toggleCreate()} aria-expanded=${this.createOpen}
                ?disabled=${!activeHost || activeHost.state.status !== "connected"}>+ New session</button>
            </div>
            ${this.createOpen && activeHost ? html`
              <form class="create-form" @submit=${this.create} @change=${this.createFormChanged}>
                <label>Agent<select name="provider" required>
                  ${activeHost.agents.map((agent) => html`<option value="${agent.provider}">${agent.displayName}</option>`)}
                </select></label>
                <label>Workspace (file URI)<input name="directory" type="text" spellcheck="false" placeholder="file:///home/user/workspace/project" .value=${activeHost.defaultDirectory || ""}></label>
                <button class="primary" ?disabled=${this.busy || !activeHost.agents.length}>Create session</button>
                <label class="workspace-trust"><input type="checkbox" name="trustWorkspace">
                  <span><strong>Trust this workspace for this browser tab</strong>
                    <small>Allow this ACP agent to load repository instructions and hooks. Only select for projects you trust.</small>
                  </span>
                </label>
                ${activeHost.agents.length ? html`<div class="host-options">
                  <div class="section-label">HOST SESSION OPTIONS
                    <button class="quiet small" type="button" ?disabled=${this.busy}
                      @click=${(event) => this.resolveCreateConfig(event.currentTarget.form, !this.sessionConfig)}>Refresh</button></div>
                  ${this.sessionConfig ? html`<div class="host-options-grid">
                    ${Object.entries(this.sessionConfig.schema?.properties || {}).map(([key, property]) =>
                      this.renderConfigField(key, property))}
                    ${!Object.keys(this.sessionConfig.schema?.properties || {}).length ? html`<p class="muted">No additional host options.</p>` : nothing}
                  </div>` : html`<p class="muted">Host options are not loaded. Refresh to request them.</p>`}
                </div>` : nothing}
                ${!activeHost.agents.length ? html`<p class="create-notice">The selected host currently advertises no agents.</p>` : nothing}
              </form>
            ` : nothing}
            <div class="catalog-summary">${filteredSessions.length} matching sessions across ${hosts.length} hosts</div>
            <div class="session-list">
              ${filteredSessions.slice(0, this.catalogLimit).map((s) => {
                const state = sessionState(s.summary, hosts.find((h) => h.id === s.hostId)?.state.status === "connected");
                return html`<button class="session-row ${selected?.hostId === s.hostId && selected?.uri === s.summary.resource ? "selected" : ""}" @click=${() => this.openSession(s.hostId, s.summary.resource)}>
                  <span class="state-bullet ${state}"></span>
                  <span class="session-name"><strong>${s.summary.title || "Untitled session"}</strong><small>${s.hostLabel} / ${s.summary.provider} · ${tail(s.summary.workingDirectories?.[0])}</small></span>
                  <span class="session-status ${state}">${state}</span>
                </button>`;
              })}
              ${filteredSessions.length > this.catalogLimit ? html`<button class="show-more" @click=${() => { this.catalogLimit += 100; this.requestUpdate(); }}>Show more · ${this.catalogLimit} / ${filteredSessions.length}</button>` : nothing}
              ${filteredSessions.length === 0 ? html`<p class="empty-row">${sessions.length ? "No sessions match this filter." : "No sessions yet. Create one on a connected host."}</p>` : nothing}
            </div>
          </section>
        </section>

        <aside class="inspector" aria-label="Session inspector">
          <div class="inspector-head"><span>INSPECTOR</span><div class="inspector-head-actions">
            <span class="mono">AHP / 1.0</span>
            <button class="quiet small" @click=${() => this.refreshSelected()}
              ?disabled=${!selected || !live || this.busy} aria-label="Refresh selected session from host">Refresh</button>
          </div></div>
          ${selected ? html`
            <div class="inspector-title">
              <button class="inspector-clear quiet small" aria-label="Clear session selection"
                @click=${() => this.run(() => this.fleet.select(null))}>Close ×</button>
              <span class="eyebrow">${this.fleet.currentHost()?.label || selected.hostId} / ${selectedSummary?.provider || detail?.provider || "SESSION"}</span>
              <h2>${selectedSummary?.title || detail?.title || (sessionLoadError ? "Session unavailable" : "Loading session")}</h2>
              <span class="state-text ${sessionLoadError ? "error" : sessionState(selectedSummary || detail, live)}">${sessionLoadError ? "UNAVAILABLE" : sessionState(selectedSummary || detail, live)}</span>
            </div>
            <dl class="details">
              <div><dt>Session</dt><dd title="${selected.uri}">${tail(selected.uri)}</dd></div>
              <div><dt>Workspace</dt><dd title="${detail?.workingDirectories?.[0] || selectedSummary?.workingDirectories?.[0] || ""}">${tail(detail?.workingDirectories?.[0] || selectedSummary?.workingDirectories?.[0])}</dd></div>
              <div><dt>Last activity</dt><dd>${when(selectedSummary?.modifiedAt)}</dd></div>
              <div><dt>Changes</dt><dd>${summaryStats(selectedSummary?.changes)}</dd></div>
            </dl>
            ${sessionLoadError ? html`<div class="attention-warning" role="status">
              The host may have restored this session under a new ID. Inspect the host session catalog.
            </div>` : nothing}
            ${!live ? html`<div class="attention-warning" role="status">Host disconnected. Published session summaries may be stale. Controls are unavailable.</div>` : nothing}
              ${attentionFor(detail).length ? html`<div class="attention-section">
              <div class="section-label">NEEDS ATTENTION <span>${attentionFor(detail).length}</span></div>
              ${attentionFor(detail).map((entry) => this.renderAttention(entry, live))}
            </div>` : nothing}
            ${changesets.length ? html`<section class="changes-panel" aria-labelledby="changes-title">
              <div class="transcript-head"><span id="changes-title">FILES / CHANGES</span><span>${changes?.status || "Awaiting host"}</span></div>
              ${staticChangesets.length > 1 ? html`<label class="changes-select">CHANGESET
                <select .value=${changeset?.uriTemplate || ""} ?disabled=${!live || this.busy}
                  @change=${(event) => { this.filePreview = null; void this.run(() => this.fleet.selectChangeset(event.target.value)); }}>
                  ${staticChangesets.map((entry) => html`<option value="${entry.uriTemplate}">${entry.label}</option>`)}
                </select>
              </label>` : nothing}
              <div class="changes-body">
                <div class="changes-description">
                  <strong>${changeset?.label || (staticChangesets.length ? "Loading changeset" : "Per-turn changesets")}</strong>
                  ${changeset?.description ? html`<p>${changeset.description}</p>` : nothing}
                </div>
                ${!staticChangesets.length
                  ? html`<p class="muted">This host advertises changesets scoped to individual turns. A session-wide view is unavailable.</p>`
                  : changesLoadError
                    ? html`<p class="change-error" role="alert">${changesLoadError}</p>`
                    : !changes
                      ? html`<p class="muted">${live ? "Subscribing to host changes…" : "Reconnect to inspect changes."}</p>`
                      : html`
                        ${changes.status === "error" ? html`<p class="change-error" role="alert">${changes.error?.message || "Changeset failed to load."}</p>` : nothing}
                        ${changes.status === "recomputing" ? html`<p class="muted">Recomputing. Displaying the previous result.</p>` : nothing}
                        <div class="changes-total">${changes.files.length} ${changes.files.length === 1 ? "file" : "files"}
                          ${canReviewChanges ? html`<span>${changes.files.filter((file) => file.reviewed).length} reviewed</span>` : nothing}
                        </div>
                        ${changes.files.map((file) => html`
                          <div class="change-file">
                            <div class="change-file-heading">
                              <strong title="${fileLabel(file)}">${tail(fileLabel(file))}</strong>
                              <span>${changeStats(file.edit?.diff)}</span>
                            </div>
                            <div class="change-file-meta"><span>${fileKind(file)}</span><span title="${fileLabel(file)}">${fileLabel(file)}</span></div>
                            ${fileKind(file) === "Renamed" ? html`<div class="change-file-from">From: ${file.edit.before.uri}</div>` : nothing}
                            <button class="change-inspect quiet small" type="button"
                              aria-expanded=${preview?.fileId === file.id}
                              ?disabled=${!live || this.busy || (this.filePreview?.loading && this.filePreview.fileId !== file.id)}
                              @click=${() => this.inspectFile(file.id)}>${preview?.fileId === file.id ? "Close preview" : "Inspect file"}</button>
                            ${preview?.fileId === file.id ? html`<div class="edit-preview" role="region" aria-label="File content preview">
                              ${preview.loading ? html`<p class="muted">Reading file content from the host…</p>`
                                : preview.error ? html`<p class="change-error" role="alert">${preview.error}</p>`
                                : html`<div class="edit-sides">
                                    <section><h3>Before</h3>${preview.before === null
                                      ? html`<p>No before content supplied.</p>`
                                      : html`<pre>${preview.before}</pre>`}</section>
                                    <section><h3>After</h3>${preview.after === null
                                      ? html`<p>No after content supplied.</p>`
                                      : html`<pre>${preview.after}</pre>`}</section>
                                  </div>`}
                            </div>` : nothing}
                            ${canReviewChanges ? html`<label class="review-file">
                              <input type="checkbox" .checked=${!!file.reviewed} ?disabled=${!live || this.busy}
                                @change=${(event) => this.run(() => this.fleet.reviewFile(file.id, event.target.checked))}>
                              <span>Reviewed</span>
                            </label>` : nothing}
                          </div>`)}
                        ${changes.status === "ready" && !changes.files.length ? html`<p class="muted">Host reports no changed files in this changeset.</p>` : nothing}
                      `}
                ${changesets.length > staticChangesets.length ? html`<p class="change-caveat">Additional per-turn views are advertised by the host.</p>` : nothing}
              </div>
            </section>` : nothing}
            ${detail?.chats?.length > 1 && selectableChats.length ? html`<label class="chat-select">CHAT
              <select .value=${this.fleet.slots.chat?.uri || ""} ?disabled=${!live || this.busy} @change=${(e) =>
                { this.explicitChatUri = e.target.value; this.historyOffset = 0; void this.run(() => this.fleet.selectChat(e.target.value)); }}>
                ${!selectableChats.some((entry) => entry.resource === this.fleet.slots.chat?.uri)
                  ? html`<option value="" disabled>Hidden chat selected</option>` : nothing}
                ${selectableChats.map((entry) => html`<option value="${entry.resource}">${entry.title || entry.resource}</option>`)}
              </select>
            </label>` : nothing}
            <div class="transcript-head"><span>CONVERSATION</span><span>${chat
              ? `${turns.length} loaded${chat.turnsNextCursor ? " · older on host" : ""}`
              : "Awaiting host"}</span></div>
            <div class="transcript" role="log" aria-live="off">
              ${chat ? html`
                ${historyStart > 0 || chat.turnsNextCursor ? html`
                  <button class="history-button quiet small" type="button" ?disabled=${!live || this.busy}
                    @click=${() => this.earlierTurns(chat)}>Load earlier turns</button>` : nothing}
                ${this.historyOffset ? html`<div class="history-nav">
                  <button class="quiet small" type="button" @click=${() => { this.historyOffset = Math.max(0, this.historyOffset - 40); this.requestUpdate(); }}>Newer turns</button>
                  <button class="quiet small" type="button" @click=${() => { this.historyOffset = 0; this.requestUpdate(); }}>Latest</button>
                </div>` : nothing}
                ${turns.length ? html`<p class="history-position">${historyStart + 1}–${historyEnd} of ${turns.length} loaded turns</p>` : nothing}
                ${[...turns.slice(historyStart, historyEnd),
                  ...(this.historyOffset === 0 && chat.activeTurn ? [chat.activeTurn] : [])].map((turn) => this.renderTurn(turn))}
                ${!turns.length && !chat.activeTurn ? html`<p class="muted">No turns in this chat.</p>` : nothing}
              ` : html`<p class="muted">${sessionLoadError || chatLoadError ||
                (!live ? "Chat requires a live host connection." : detail && !detail.chats?.length
                  ? "This session has no chats." : "Loading chat from the host…")}</p>`}
            </div>
            ${chat?.queuedMessages?.length ? html`<div class="queue-notice">${chat.queuedMessages.length} queued turn(s)</div>` : nothing}
            ${this.fleet.waiting.size ? html`<div class="queue-notice warning">Awaiting host echo for ${this.fleet.waiting.size} submission(s)</div>` : nothing}
            ${chat && !chatAllowsInput ? html`<div class="chat-restriction" role="status">
              ${promptPolicy.reason}
            </div>` : nothing}
            <form class="composer" @submit=${this.submitPrompt}>
              <label for="prompt">MESSAGE / QUEUED TURN</label>
              <textarea id="prompt" name="prompt" rows="4" placeholder="Describe the work to perform…" required ?disabled=${!live || !chat || !chatAllowsInput || this.busy}></textarea>
              ${models.length ? html`<label class="model-select">MODEL
                <select name="model" .value=${models.some((model) => model.id === this.modelId) ? this.modelId : ""}
                  ?disabled=${!live || !chatAllowsInput || this.busy} @change=${(event) => { this.modelId = event.target.value; this.requestUpdate(); }}>
                  <option value="">Host default</option>
                  ${models.map((model) => html`<option value="${model.id}" ?disabled=${model.policyState === "disabled"}>
                    ${model.name || model.id}${model.policyState === "unconfigured" ? " · Not configured" : ""}
                  </option>`)}
                </select>
              </label>` : nothing}
              <div class="composer-actions">
                <button class="quiet small" type="button" @click=${() => this.run(() => this.fleet.cancelTurn())} ?disabled=${!live || !chat?.activeTurn || this.busy}>Cancel turn</button>
                <button class="primary small" type="submit" ?disabled=${!live || !chat || !chatAllowsInput || this.busy}>Queue turn →</button>
              </div>
            </form>
            <div class="inspector-footer"><button class="danger small" @click=${() => { if (window.confirm("Dispose this AHP session? This cannot be undone.")) void this.run(() => this.fleet.disposeSession()); }} ?disabled=${!live || this.busy || !!sessionLoadError}>Dispose session</button></div>
          ` : html`
            <div class="inspector-empty"><span class="eyebrow">NO SELECTION</span><h2>Select a session</h2><p>Select a session in the topology or catalog to see authoritative state, conversation, and approval requests.</p></div>
          `}
        </aside>
      </main>
      <dialog class="shortcuts-dialog" aria-labelledby="shortcuts-title">
        <div class="shortcuts-head"><div><span class="eyebrow">OPERATOR REFERENCE</span><h2 id="shortcuts-title">Keyboard controls</h2></div>
          <button class="quiet small" @click=${() => this.querySelector(".shortcuts-dialog")?.close()}>Close</button></div>
        <dl class="shortcuts-grid">
          <div><dt><kbd>/</kbd></dt><dd>Focus fleet search</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Open this reference</dd></div>
          <div><dt><kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd></dt><dd>Move between topology nodes</dd></div>
          <div><dt><kbd>Home</kbd> <kbd>End</kbd></dt><dd>First host or last visible session</dd></div>
          <div><dt><kbd>Enter</kbd> <kbd>Space</kbd></dt><dd>Open selected topology node</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>Clear a topology selection or search, or close this dialog</dd></div>
        </dl>
      </dialog>
      <footer class="footer"><span>Relay / AHP client</span><span>No local session database · Host authority only</span></footer>
    `;
  }

  renderTurn(turn) {
    const parts = turn.responseParts || [];
    const noResponse = turn.state === "complete" && !parts.length;
    return html`<div class="turn">
      <div class="turn-meta"><span class="turn-kind">PROMPT</span><span>${when(turn.startedAt)}</span></div>
      <p class="turn-prompt">${turn.message?.text || "—"}</p>
      ${parts.map((part) =>
        part.kind === "markdown" ? html`<pre class="response-text">${part.content}</pre>` :
        part.kind === "toolCall" ? html`<div class="tool-event"><span>TOOL</span><b>${part.toolCall?.displayName || part.toolCall?.toolName}</b><small>${part.toolCall?.status}</small></div>` :
        part.kind === "error" ? html`<div class="alert">${part.error?.message || "Agent error"}</div>` :
        part.kind === "inputRequest" ? html`<div class="tool-event">Agent requested input · ${part.response || "pending"}</div>` : nothing)}
      <div class="turn-outcome">${noResponse ? "Host reports complete · no response recorded" : turn.state || "In progress"}${turn.usage?.totalTokens ? " · " + turn.usage.totalTokens + " tokens" : ""}</div>
    </div>`;
  }

  renderAttention(entry, live) {
    if (entry.kind === "toolConfirmation") {
      const call = entry.toolCall;
      const options = call.options || [];
      return html`<div class="attention-item">
        <strong>${labelText(call.confirmationTitle) || call.displayName || "Tool confirmation"}</strong>
        <p>${call.intention || labelText(call.invocationMessage) || call.toolName || "Review this tool request"}</p>
        <pre class="tool-input">${short(JSON.stringify(call.toolInput || {}), 700)}</pre>
        <div class="attention-actions">
          ${call.status === "pending-result-confirmation"
            ? html`
              <button class="primary small" ?disabled=${!live || this.busy}
                @click=${() => this.confirm(entry, true)}>Accept result</button>
              <button class="quiet small" ?disabled=${!live || this.busy}
                @click=${() => this.confirm(entry, false)}>Reject result</button>
            ` : options.length
              ? options.filter((option) => ["approve", "deny"].includes(option.kind)).map((option) => html`
                  <button class="${option.kind === "approve" ? "primary" : "quiet"} small"
                    ?disabled=${!live || this.busy}
                    @click=${() => this.confirm(entry, option.kind === "approve", option.id)}>${option.label}</button>`)
              : html`
                  <button class="primary small" ?disabled=${!live || this.busy}
                    @click=${() => this.confirm(entry, true)}>Approve once</button>
                  <button class="quiet small" ?disabled=${!live || this.busy}
                    @click=${() => this.confirm(entry, false)}>Deny</button>`}
        </div>
      </div>`;
    }
    if (entry.kind === "chatInput") {
      return html`<form class="attention-item" @submit=${(event) => this.answer(event, entry)}>
        <strong>${entry.request.message || "Agent requires input"}</strong>
        ${safeLink(entry.request.url) ? html`<a href="${safeLink(entry.request.url)}" target="_blank" rel="noopener noreferrer">Review requested link ↗</a>` : nothing}
        ${(entry.request.questions || []).map((q) => html`<fieldset class="question"><legend>${q.title || q.message}</legend>
          ${q.kind === "boolean" ? html`<select name="${q.id}" .value=${q.defaultValue === undefined ? "" : String(q.defaultValue)}
            ?required=${q.required}><option value="" disabled>Choose an answer</option><option value="true">Yes</option><option value="false">No</option></select>` :
            q.kind === "single-select" || q.kind === "multi-select" ? html`
              <select name="${q.id}" ?multiple=${q.kind === "multi-select"} ?required=${q.required && !q.allowFreeformInput}>
                ${q.kind === "single-select" ? html`<option value="">Choose an option</option>` : nothing}
                ${(q.options || []).map((choice) => html`<option value="${choice.id}">${choice.label}</option>`)}
              </select>
              ${q.allowFreeformInput ? html`<label class="freeform-label">Other response
                <input name="${q.id}:freeform" type="text" autocomplete="off" placeholder="Enter a response">
              </label>` : nothing}` :
            html`<input name="${q.id}" type="${q.kind === "integer" || q.kind === "number" ? "number" : "text"}" ?required=${q.required}
              step="${q.kind === "number" ? "any" : "1"}" min=${q.kind === "number" || q.kind === "integer" ? q.min ?? nothing : nothing}
              max=${q.kind === "number" || q.kind === "integer" ? q.max ?? nothing : nothing}
              minlength=${q.kind === "text" ? q.min ?? nothing : nothing}
              maxlength=${q.kind === "text" ? q.max ?? nothing : nothing}
              .value=${q.defaultValue == null ? "" : String(q.defaultValue)} placeholder="${q.message}">`}
        </fieldset>`)}
        <div class="attention-actions">
          <button type="submit" class="primary small" ?disabled=${!live || this.busy}>Answer</button>
          <button type="button" class="quiet small" ?disabled=${!live || this.busy} @click=${() => this.run(() => this.fleet.answerInput(entry, "decline"))}>Decline</button>
        </div>
      </form>`;
    }
    return html`<div class="attention-item"><strong>${entry.kind}</strong><p>Resolve the authentication request in the agent host.</p></div>`;
  }
}

customElements.define("relay-fleet", RelayFleet);
