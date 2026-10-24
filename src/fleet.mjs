import { chatReducer, changesetReducer, sessionReducer } from "@microsoft/agent-host-protocol";
import { MultiHostClient } from "@microsoft/agent-host-protocol/hosts";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";

export function statusOf(value) {
  if (!Number.isInteger(value)) return "unknown";
  if ((value & 24) === 24) return "attention";
  if (value & 2) return "error";
  if (value & 8) return "working";
  if (value & 1) return "idle";
  return "unknown";
}

export function safeEndpoint(input) {
  const url = new URL(input.trim());
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password ||
      url.hash || url.search || !url.hostname) {
    throw Error("Enter a WebSocket URL without embedded credentials or query parameters");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "ws:" && !local) {
    throw Error("Remote hosts require encrypted wss://");
  }
  return url;
}

export function workspaceUri(input) {
  const value = input.trim();
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "file:" || url.host || url.search || url.hash ||
      !url.pathname || !url.pathname.startsWith("/")) {
    throw Error("Workspace must be an absolute file:/// URI on the selected host");
  }
  return url.href;
}

const MAX_PREVIEW_BYTES = 256 * 1024;

export function decodeResourceText(data) {
  if (!data || typeof data.data !== "string") throw Error("Host returned no file content");
  if (data.contentType && !/^(text\/|application\/(?:json|xml|javascript|.*\+json|.*\+xml))/.test(data.contentType)) {
    throw Error("The selected file is not text; use an editor for binary files");
  }
  let value;
  if (data.encoding === "utf-8") value = data.data;
  else if (data.encoding === "base64") {
    if (data.data.length > Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 + 8) {
      throw Error("File preview exceeds 256 KiB; inspect it in an editor");
    }
    const bytes = Uint8Array.from(atob(data.data), (character) => character.charCodeAt(0));
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } else throw Error("Unsupported file encoding from host");
  if (new TextEncoder().encode(value).byteLength > MAX_PREVIEW_BYTES) {
    throw Error("File preview exceeds 256 KiB; inspect it in an editor");
  }
  if (value.includes("\0")) throw Error("The selected file appears to be binary");
  return value;
}

export function sessionState(value, online = true) {
  return online ? statusOf(value?.status) : "offline";
}

export function attentionFor(session) {
  return (session?.inputNeeded || []).filter((entry) =>
    entry.kind === "toolConfirmation" || entry.kind === "chatInput" ||
    entry.kind === "toolAuthentication");
}

export function validateInputAnswers(request, answers) {
  const questions = request.questions || [];
  const known = new Map(questions.map((question) => [question.id, question]));
  for (const [id, answer] of Object.entries(answers)) {
    const question = known.get(id);
    if (!question) throw Error("Unknown input question: " + id);
    if (answer?.state === "skipped") {
      if (question.required) throw Error("Complete " + (question.title || question.message));
      continue;
    }
    if (answer?.state !== "submitted") throw Error("Input answer is not submitted: " + id);
    const value = answer.value;
    if (!value || typeof value !== "object") throw Error("Invalid input answer: " + id);
    const invalid = () => { throw Error("Invalid answer for " + (question.title || question.message)); };
    switch (question.kind) {
      case "text":
        if (value.kind !== "text" || typeof value.value !== "string" ||
            (question.min != null && value.value.length < question.min) ||
            (question.max != null && value.value.length > question.max)) invalid();
        break;
      case "number":
      case "integer":
        if (value.kind !== "number" || !Number.isFinite(value.value) ||
            (question.kind === "integer" && !Number.isInteger(value.value)) ||
            (question.min != null && value.value < question.min) ||
            (question.max != null && value.value > question.max)) invalid();
        break;
      case "boolean":
        if (value.kind !== "boolean" || typeof value.value !== "boolean") invalid();
        break;
      case "single-select":
      case "multi-select": {
        const multiple = question.kind === "multi-select";
        if (value.kind !== (multiple ? "selected-many" : "selected") ||
            (multiple ? !Array.isArray(value.value) : typeof value.value !== "string")) invalid();
        const selected = multiple ? value.value :
          (value.value === "" && question.allowFreeformInput ? [] : [value.value]);
        const freeform = value.freeformValues || [];
        if (!Array.isArray(freeform) ||
            (!question.allowFreeformInput && freeform.length > 0) ||
            !freeform.every((entry) => typeof entry === "string" && entry.trim()) ||
            !selected.every((choice) => typeof choice === "string" &&
              question.options.some((item) => item.id === choice)) ||
            (question.required && selected.length === 0 && freeform.length === 0) ||
            (multiple && ((question.min != null && selected.length + freeform.length < question.min) ||
              (question.max != null && selected.length + freeform.length > question.max) ||
              new Set(selected).size !== selected.length ||
              new Set(freeform).size !== freeform.length))) invalid();
        break;
      }
      default:
        throw Error("Unsupported input question kind: " + question.kind);
    }
  }
  for (const question of questions) {
    if (question.required && (answers[question.id] || request.answers?.[question.id])?.state !== "submitted") {
      throw Error("Complete " + (question.title || question.message));
    }
  }
}

export class Fleet {
  constructor(onChange, multi = new MultiHostClient()) {
    this.multi = multi;
    this.onChange = onChange;
    this.selected = null;
    this.slots = { session: null, chat: null, changes: null };
    this.waiting = new Map();
    // AHP workspace trust is deliberately scoped to this browser tab and each
    // host connection. Never infer it from the workspace path or persist it.
    this.trusted = new Map();
    this.lastSignal = null;
    this.error = "";
    this.sequence = 0;
    // Subscription changes must be serialized: unsubscribe on a stale selection
    // must never undo an overlapping subscribe on the same host/channel.
    this.subscriptionBarrier = Promise.resolve();
    this.closed = false;
    void this.listen();
  }

  serializeSubscription(operation) {
    const running = this.subscriptionBarrier.then(operation);
    this.subscriptionBarrier = running.catch(() => {});
    return running;
  }

  changed() {
    this.onChange?.();
  }

  hosts() {
    return this.multi.hostsSnapshot();
  }

  sessions() {
    const items = this.multi.aggregatedSessions();
    const selected = this.selected;
    const detail = this.session;
    if (!selected || !detail) return items;
    const host = this.multi.host(selected.hostId);
    if (host?.state.status !== "connected") return items;
    const index = items.findIndex((item) => item.hostId === selected.hostId &&
      item.summary.resource === selected.uri);
    // A freshly created session can be present on its subscribed channel before
    // the host includes it in listSessions. Project that authoritative channel,
    // never a fabricated local session record, into the currently selected view.
    const summary = index >= 0 ? items[index].summary : {
      resource: selected.uri,
      provider: detail.provider,
      title: detail.title,
      status: detail.status,
      workingDirectories: detail.workingDirectories,
      defaultChat: detail.defaultChat,
      chats: detail.chats,
    };
    const liveChat = detail.chats?.length === 1 ? this.chat : null;
    const projected = {
      ...summary,
      ...(liveChat ? {
        status: liveChat.status,
        activity: liveChat.activity,
        modifiedAt: liveChat.modifiedAt,
      } : {}),
    };
    const item = { hostId: selected.hostId, hostLabel: host.label, summary: projected };
    if (index >= 0) items[index] = item;
    else items.unshift(item);
    return items;
  }

  agents() {
    return this.multi.aggregatedAgents();
  }

  modelsFor(hostId, provider) {
    return this.multi.host(hostId)?.agents.find((agent) =>
      agent.provider === provider)?.models || [];
  }

  get session() {
    return this.slots.session?.ready ? this.slots.session.state : null;
  }

  get chat() {
    return this.slots.chat?.ready ? this.slots.chat.state : null;
  }

  get chatPromptPolicy() {
    const chat = this.chat;
    if (!chat) return { allowsInput: false, reason: "Chat is not ready" };
    if (!chat.interactivity || chat.interactivity === "full") {
      return { allowsInput: true, reason: "" };
    }
    return {
      allowsInput: false,
      reason: `This chat is ${chat.interactivity}. The host does not accept user prompts here.`,
    };
  }

  get changes() {
    return this.slots.changes?.ready ? this.slots.changes.state : null;
  }

  availableChangesets() {
    // Only a literal, subscribable URI has a defined meaning independent of a
    // chosen turn. Never guess URI-template expansions or synthesize file diffs.
    return [...(this.session?.changesets || []), ...(this.chat?.changesets || [])]
      .filter((entry) => typeof entry.uriTemplate === "string" &&
        !entry.uriTemplate.includes("{") && !entry.uriTemplate.includes("}"));
  }

  get changeset() {
    return this.availableChangesets().find((entry) =>
      entry.uriTemplate === this.slots.changes?.uri) || null;
  }

  currentHost() {
    return this.selected ? this.multi.host(this.selected.hostId) : null;
  }

  async addHost({ label, endpoint, token }) {
    const url = safeEndpoint(endpoint);
    const id = label.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    if (!id) throw Error("Host name is required");
    if (this.multi.host(id)) throw Error("Host name is already in use");
    // The secret lives exclusively in this closure and is never persisted or rendered.
    if (token) url.searchParams.set("tkn", token);
    await this.multi.addHost({
      id,
      label: label.trim(),
      transportFactory: async (_id, signal) =>
        WebSocketTransport.connect(url, { signal }),
    });
    this.changed();
  }

  async removeHost(id) {
    if (this.selected?.hostId === id) await this.select(null);
    await this.multi.removeHost(id);
    this.trusted.delete(id);
    this.changed();
  }

  trustWorkspace(hostId, directory) {
    const uri = workspaceUri(directory || "");
    if (!uri) throw Error("Select a workspace before trusting its project files");
    this.requireHost(hostId);
    const previous = this.trusted.get(hostId) || new Set();
    const next = new Set(previous);
    next.add(uri);
    this.trusted.set(hostId, next);
    this.publishTrust(hostId);
  }

  publishTrust(hostId) {
    const uris = [...(this.trusted.get(hostId) || [])];
    if (!uris.length) return;
    this.requireHost(hostId);
    // The AHP host interprets workspaceTrust on the root channel per client
    // connection. It discards that grant at disconnect; it is not host policy.
    this.multi.dispatch(hostId, "ahp-root://", {
      type: "root/configChanged",
      config: { workspaceTrust: { enabled: true, trustedUris: uris } },
    });
  }

  async reconnect(id) {
    await this.multi.reconnectHost(id);
  }

  async select(value) {
    const previous = Object.values(this.slots).filter(Boolean);
    const revision = ++this.sequence;
    if (this.waiting.size > 0) {
      this.error = "Queued submission was not confirmed before changing the view. Inspect host state before retrying.";
    }
    this.selected = value;
    this.slots = { session: null, chat: null, changes: null };
    this.waiting.clear();
    this.lastSignal = null;
    this.changed();
    await this.serializeSubscription(() => Promise.all(previous.map(({ hostId, uri }) =>
      this.multi.unsubscribe(hostId, uri).catch(() => {}))));
    if (!value || revision !== this.sequence) return;
    await this.watch("session", value.hostId, value.uri, revision);
  }

  async watch(kind, hostId, uri, revision = this.sequence) {
    return this.serializeSubscription(async () => {
      if (!uri || revision !== this.sequence || this.selected?.hostId !== hostId) return;
      const old = this.slots[kind];
      if (old?.hostId === hostId && old.uri === uri) return;
      if (old) {
        this.slots[kind] = null;
        await this.multi.unsubscribe(old.hostId, old.uri).catch(() => {});
      }
      if (revision !== this.sequence || this.selected?.hostId !== hostId) return;
      const slot = { hostId, uri, kind, ready: false, state: null, seq: -1, buffer: [] };
      this.slots[kind] = slot;
      this.changed();
      try {
        const result = await this.multi.subscribe(hostId, uri);
        if (revision !== this.sequence || this.slots[kind] !== slot) {
          await this.multi.unsubscribe(hostId, uri).catch(() => {});
          return;
        }
        slot.state = result.snapshot?.state || null;
        slot.seq = result.snapshot?.fromSeq ?? -1;
        slot.ready = true;
        slot.buffer.sort((a, b) => a.serverSeq - b.serverSeq);
        for (const event of slot.buffer) this.apply(slot, event);
        slot.buffer.length = 0;
        if (kind === "session") {
          void this.findChat(revision);
          void this.findChanges(revision);
        }
        if (kind === "chat") void this.findChanges(revision);
        this.changed();
      } catch (error) {
        if (revision !== this.sequence || this.slots[kind] !== slot) return;
        slot.error = error?.message || "Session data unavailable";
        this.error = slot.error;
        this.changed();
      }
    });
  }

  async findChat(revision = this.sequence) {
    const session = this.session;
    if (session?.chats?.some((entry) => entry.resource === this.slots.chat?.uri)) return;
    const summary = this.sessions().find((row) => row.hostId === this.selected?.hostId &&
      row.summary.resource === this.selected?.uri)?.summary;
    const uri = session?.defaultChat || summary?.defaultChat ||
      session?.chats?.[0]?.resource || summary?.chats?.[0]?.resource;
    if (uri && this.selected) await this.watch("chat", this.selected.hostId, uri, revision);
  }

  async selectChat(uri) {
    if (!this.selected || !this.session?.chats?.some((chat) => chat.resource === uri)) {
      throw Error("Chat is not part of the selected session");
    }
    await this.watch("chat", this.selected.hostId, uri);
  }

  async loadOlderTurns() {
    const slot = this.slots.chat;
    const cursor = this.chat?.turnsNextCursor;
    if (!slot?.ready || !cursor) throw Error("No older turns available");
    const client = this.requireHost(slot.hostId);
    await client.request("fetchTurns", { channel: slot.uri, cursor });
    // The host sends chat/turnsLoaded as a channel action, never as a second
    // transcript in the RPC response. A stale page must not be appended here.
  }

  async findChanges(revision = this.sequence) {
    const options = this.availableChangesets();
    const current = this.slots.changes?.uri;
    if (current && options.some((entry) => entry.uriTemplate === current)) return;
    if (!options.length) {
      const old = this.slots.changes;
      if (old) {
        this.slots.changes = null;
        await this.serializeSubscription(() => this.multi.unsubscribe(old.hostId, old.uri).catch(() => {}));
        this.changed();
      }
      return;
    }
    const preferred = options.find((item) => item.changeKind === "session") ||
      options.find((item) => item.changeKind === "uncommitted") || options[0];
    await this.selectChangeset(preferred.uriTemplate, revision);
  }

  async selectChangeset(uriTemplate, revision = this.sequence) {
    if (!this.selected || !this.availableChangesets().some((entry) => entry.uriTemplate === uriTemplate)) {
      throw Error("Changeset is not advertised by the selected session");
    }
    await this.watch("changes", this.selected.hostId, uriTemplate, revision);
  }

  reviewFile(fileId, reviewed) {
    const changeset = this.changeset;
    if (!changeset || !Object.hasOwn(changeset.capabilities || {}, "review") ||
      !this.changes?.files?.some((file) => file.id === fileId)) {
      throw Error("Host does not allow reviewing this file");
    }
    this.dispatch(this.slots.changes.uri, {
      type: "changeset/filesReviewChanged", files: [fileId], reviewed: Boolean(reviewed),
    });
  }

  async readEdit(fileId) {
    const slot = this.slots.changes;
    if (!slot?.ready || !this.changeset) throw Error("Select a host changeset first");
    const file = this.changes?.files?.find((entry) => entry.id === fileId);
    if (!file) throw Error("File is no longer in the current changeset");
    const client = this.requireHost(slot.hostId);
    const read = async (side) => {
      const ref = file.edit?.[side]?.content;
      if (!ref?.uri) return null;
      if (ref.sizeHint > MAX_PREVIEW_BYTES) {
        throw Error("File preview exceeds 256 KiB; inspect it in an editor");
      }
      const response = await client.request("resourceRead", {
        channel: "ahp-root://", uri: ref.uri, encoding: "utf-8",
      });
      return decodeResourceText(response);
    };
    // Authoritative ContentRefs are provided by the host changeset itself.
    // There is no filesystem proxy, arbitrary URI input or persistent diff cache.
    const [before, after] = await Promise.all([read("before"), read("after")]);
    const latest = this.changes?.files?.find((entry) => entry.id === fileId);
    const sameRef = (side) => {
      const one = file.edit?.[side]?.content;
      const other = latest?.edit?.[side]?.content;
      return one?.uri === other?.uri && one?.nonce === other?.nonce;
    };
    if (this.slots.changes !== slot || !latest || !sameRef("before") || !sameRef("after")) {
      throw Error("File or changeset changed while reading; reopen the file");
    }
    return { fileId, before, after };
  }

  async refreshSelection() {
    if (!this.selected || this.currentHost()?.state.status !== "connected") return;
    // Re-seeding from AHP snapshots is also a recovery point for dropped SDK
    // event-buffer entries while a browser tab was suspended.
    const selection = this.selected;
    await this.select(selection);
  }

  apply(slot, envelope) {
    if (!slot.state || envelope.serverSeq <= slot.seq) return;
    if (envelope.rejectionReason) {
      if (envelope.action.type === "chat/pendingMessageSet") {
        this.waiting.delete(envelope.action.id);
      }
      this.error = envelope.rejectionReason;
      slot.seq = envelope.serverSeq;
      return;
    }
    // Events before a subscribe snapshot are replayed only if newer than fromSeq.
    const activeTurnBefore = slot.kind === "chat" ? slot.state.activeTurn?.id : null;
    slot.state = slot.kind === "session" ? sessionReducer(slot.state, envelope.action)
      : slot.kind === "changes" ? changesetReducer(slot.state, envelope.action)
      : chatReducer(slot.state, envelope.action);
    slot.seq = envelope.serverSeq;
    const kind = envelope.action.type;
    if (kind === "chat/pendingMessageSet") this.waiting.delete(envelope.action.id);
    if (kind === "chat/turnStarted") this.waiting.delete(envelope.action.queuedMessageId);
    if ((kind === "chat/turnComplete" || kind === "chat/turnCancelled") &&
        activeTurnBefore === envelope.action.turnId && !slot.state.activeTurn) {
      const pulse = { uri: slot.uri, at: Date.now(), kind };
      this.lastSignal = pulse;
      setTimeout(() => {
        if (this.lastSignal === pulse) {
          this.lastSignal = null;
          this.changed();
        }
      }, 1400);
    }
    if (kind === "session/chatAdded" || kind === "session/defaultChatChanged") {
      void this.findChat();
    }
    if (kind === "session/changesetsChanged" || kind === "chat/changesetsChanged") {
      void this.findChanges();
    }
  }

  async listen() {
    void (async () => {
      try {
        for await (const event of this.multi.events()) {
          if (event.event.type === "action") {
            for (const slot of Object.values(this.slots)) {
              if (!slot || slot.hostId !== event.hostId || slot.uri !== event.channel) continue;
              if (!slot.ready) slot.buffer.push(event.event.params);
              else this.apply(slot, event.event.params);
            }
            if (event.event.params.rejectionReason) this.error = event.event.params.rejectionReason;
          } else if (event.event.type === "sessionSummaryChanged") {
            if (!this.chat && this.selected?.hostId === event.hostId) void this.findChat();
          }
          this.changed();
        }
      } catch (error) {
        if (!this.closed) {
          this.error = "AHP event stream stopped: " + (error?.message || String(error));
          this.changed();
        }
      }
    })();
    try {
      for await (const event of this.multi.hostEvents()) {
        if (event.type === "connected" && this.trusted.has(event.hostId)) {
          try {
            this.publishTrust(event.hostId);
          } catch (error) {
            this.error = "Could not restore workspace trust: " +
              (error?.message || String(error));
          }
        }
        if (event.type === "connected" && this.selected?.hostId === event.hostId) {
          const target = this.selected;
          // Re-seed from authoritative snapshots after reconnect; cached state is stale.
          const revision = ++this.sequence;
          const stale = Object.values(this.slots).filter(Boolean);
          this.slots = { session: null, chat: null, changes: null };
          if (this.waiting.size > 0) {
            this.error = "Connection changed before queued submissions were confirmed. Inspect the host session before retrying.";
          }
          this.waiting.clear();
          this.lastSignal = null;
          void (async () => {
            await this.serializeSubscription(() => Promise.all(stale.map(({ hostId, uri }) =>
              this.multi.unsubscribe(hostId, uri).catch(() => {}))));
            if (this.sequence === revision) {
              await this.watch("session", target.hostId, target.uri, revision);
            }
          })().catch((error) => {
            if (!this.closed && this.sequence === revision) {
              this.error = "Could not restore AHP selection: " + (error?.message || String(error));
              this.changed();
            }
          });
        }
        this.changed();
      }
    } catch (error) {
      if (!this.closed) {
        this.error = "AHP connection updates stopped: " + (error?.message || String(error));
        this.changed();
      }
    }
  }

  requireHost(hostId) {
    const host = this.multi.host(hostId);
    if (host?.state.status !== "connected") throw Error("Host is not connected");
    return this.multi.client(hostId);
  }

  async resolveSessionConfig({ hostId, provider, directory, config = {} }) {
    const client = this.requireHost(hostId);
    if (!this.multi.host(hostId)?.agents.some((agent) => agent.provider === provider)) {
      throw Error("Provider is not advertised by the selected host");
    }
    const where = workspaceUri(directory || "");
    return client.request("resolveSessionConfig", {
      channel: "ahp-root://", provider,
      ...(where ? { workingDirectory: where } : {}),
      config,
    });
  }

  async createSession({ hostId, provider, directory, config, trust = false }) {
    const client = this.requireHost(hostId);
    if (!this.multi.host(hostId)?.agents.some((agent) => agent.provider === provider)) {
      throw Error("Provider is not advertised by the selected host");
    }
    const dir = workspaceUri(directory || "");
    if (trust) this.trustWorkspace(hostId, directory);
    // ahpd keeps sessions under the provider-qualified canonical URI. Sending
    // an ahp-session alias works but creates a second URI absent from its root
    // catalog; use the canonical spelling from the outset when URI-safe.
    const scheme = /^[a-z][a-z0-9+.-]*$/i.test(provider) ? provider : "ahp-session";
    const uri = scheme + ":/" + crypto.randomUUID();
    await client.request("createSession", {
      channel: uri,
      provider,
      ...(dir ? { workingDirectories: [dir] } : {}),
      ...(config ? { config } : {}),
    });
    await this.select({ hostId, uri });
    return uri;
  }

  dispatch(chat, action) {
    if (!this.selected) throw Error("Select a session");
    this.requireHost(this.selected.hostId);
    if (chat !== this.slots.chat?.uri && chat !== this.slots.changes?.uri &&
      !this.session?.inputNeeded?.some((request) => request.chat === chat)) {
      throw Error("Channel is not owned by the selected session");
    }
    this.multi.dispatch(this.selected.hostId, chat, action);
    this.changed();
  }

  queueTurn(text, modelId) {
    const policy = this.chatPromptPolicy;
    if (!policy.allowsInput) {
      throw Error(policy.reason || "This chat does not accept user prompts");
    }
    if (!text.trim()) throw Error("A prompt is required");
    const provider = this.session?.provider;
    const chosen = modelId && this.modelsFor(this.selected.hostId, provider)
      .find((model) => model.id === modelId);
    if (modelId && !chosen) throw Error("Model is not advertised by this session's provider");
    if (chosen?.policyState === "disabled") throw Error("Model is disabled by host policy");
    const id = crypto.randomUUID();
    this.waiting.set(id, text.trim());
    try {
      this.dispatch(this.slots.chat.uri, {
        type: "chat/pendingMessageSet",
        kind: "queued",
        id,
        message: { text: text.trim(), origin: { kind: "user" },
          ...(modelId ? { model: { id: modelId } } : {}) },
      });
    } catch (error) {
      this.waiting.delete(id);
      throw error;
    }
  }

  cancelTurn() {
    if (!this.chat?.activeTurn || !this.slots.chat) throw Error("No active turn");
    // This is a cancellation REQUEST: the required duration is deliberately 0,
    // not invented latency telemetry. The host produces the actual end event.
    this.dispatch(this.slots.chat.uri, {
      type: "chat/turnCancelled",
      turnId: this.chat.activeTurn.id,
      duration: 0,
    });
  }

  confirmTool(entry, approved, selectedOptionId) {
    if (entry.kind !== "toolConfirmation") throw Error("Not a tool confirmation");
    const current = this.requireAttention(entry);
    const call = current.toolCall;
    // A result confirmation has a separate action without an option ID; the
    // tool may still carry options from its earlier invocation approval.
    if (call.status !== "pending-result-confirmation" && call.options?.length) {
      const option = call.options.find((item) => item.id === selectedOptionId);
      if (!option || (option.kind === "approve") !== approved) {
        throw Error("Select an approval option from the host");
      }
    }
    const basic = { turnId: current.turnId, toolCallId: call.toolCallId };
    const action = call.status === "pending-result-confirmation"
      ? { type: "chat/toolCallResultConfirmed", ...basic, approved }
      : approved
        ? { type: "chat/toolCallConfirmed", ...basic, approved: true,
            confirmed: "user-action", ...(selectedOptionId ? { selectedOptionId } : {}) }
        : { type: "chat/toolCallConfirmed", ...basic, approved: false, reason: "denied",
            ...(selectedOptionId ? { selectedOptionId } : {}) };
    this.dispatch(current.chat, action);
  }

  answerInput(entry, response, answers = {}) {
    if (entry.kind !== "chatInput") throw Error("Not an input request");
    const current = this.requireAttention(entry);
    if (!["accept", "decline", "cancel"].includes(response)) throw Error("Invalid input response");
    if (response === "accept") validateInputAnswers(current.request, answers);
    this.dispatch(current.chat, {
      type: "chat/inputCompleted",
      requestId: current.request.id,
      response,
      ...(response === "accept" ? { answers } : {}),
    });
  }

  requireAttention(entry) {
    const current = this.session?.inputNeeded?.find((item) => item.id === entry.id);
    if (!current || current.chat !== entry.chat || current.kind !== entry.kind) {
      throw Error("This request is no longer current");
    }
    if (entry.kind === "toolConfirmation" &&
      (current.turnId !== entry.turnId || current.toolCall.toolCallId !== entry.toolCall.toolCallId ||
       current.toolCall.status !== entry.toolCall.status)) {
      throw Error("Tool confirmation changed; review its current state");
    }
    if (entry.kind === "chatInput" && current.request.id !== entry.request.id) {
      throw Error("Input request changed; review its current state");
    }
    return current;
  }

  async disposeSession() {
    if (!this.selected) throw Error("Select a session");
    const { hostId, uri } = this.selected;
    await this.requireHost(hostId).request("disposeSession", { channel: uri });
    await this.select(null);
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    await this.multi.shutdown();
  }
}
