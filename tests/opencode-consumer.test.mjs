import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCodePlugin } from "../src/adapters/opencode-plugin-core.mjs";

const nativeSession = "ses_consumer_fixture";
const binding = { authority: "host:relay", worker: "relay-device:opencode:prime", sid: "relay_session_fixture", epoch: 3 };

function eventStream() {
  const queue = [];
  const waiters = [];
  const stop = Symbol("stop");
  return {
    emit(value) { const waiter = waiters.shift(); if (waiter) waiter(value); else queue.push(value); },
    async *subscribe({ signal }) {
      const onAbort = () => { while (waiters.length) waiters.shift()(stop); };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (!signal.aborted) {
          const value = queue.length ? queue.shift() : await new Promise((resolve) => waiters.push(resolve));
          if (value === stop) return;
          yield value;
        }
      } finally { signal.removeEventListener("abort", onAbort); }
    },
  };
}

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("Timed out waiting for fixture state"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("consume opt-in registers native tools and forwards exact recipient calls through the bridge", async () => {
  const root = "/tmp/relay-opencode-consumer-fixture";
  const bridgeBindings = [];
  const forwarded = [];
  const nativeEvents = eventStream();
  const nativeHooks = new Map();
  const tools = new Map();
  let claims = 0;
  const recipient = async (op, args) => {
    forwarded.push({ op, args });
    const time = Date.now();
    if (op === "renew") return { id: binding.sid, worker: binding.worker, epoch: binding.epoch, until: time + 60000, ended: null };
    if (op === "pending") return { v: 1, authority: binding.authority, worker: binding.worker, epoch: binding.epoch,
      revision: "b".repeat(64), pending: { msg: 1, work: 0 }, recoverable: { msg: 0, work: 0 } };
    if (op === "claim") {
      claims++;
      return claims === 1 ? { id: "lease_consumer_fixture", mid: "message_consumer_fixture", sid: binding.sid,
        epoch: binding.epoch, until: time + 60000, attempt: 1, kind: args.kind, msg: "fixture addressed body" } : null;
    }
    if (op === "touch") return { id: "lease_consumer_fixture", mid: "message_consumer_fixture", sid: binding.sid,
      epoch: binding.epoch, until: time + 60000, attempt: 1, kind: "msg", msg: "fixture addressed body" };
    if (op === "reply") return { id: "reply_receipt", repeat: false, init: time };
    if (op === "ack") return { mid: "message_consumer_fixture", lease: args.lease, sid: binding.sid,
      epoch: binding.epoch, outcome: args.outcome, time };
    if (op === "release") return { mid: "message_consumer_fixture", lease: args.lease, sid: binding.sid,
      epoch: binding.epoch, outcome: "released", time };
    throw new Error(`Unexpected recipient operation: ${op}`);
  };
  const callBridge = async (_root, op, args, signal) => {
    if (op === "delivery.bind") { bridgeBindings.push(args); return { bindingId: "bridge_binding_fixture" }; }
    if (op === "delivery.recipient") return recipient(args.op, args.args);
    if (op === "delivery.close") return { closed: true };
    if (op === "delivery.observe" || op === "delivery.complete") return { applied: true };
    if (op === "delivery.next") return new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(new Error("bridge wait stopped"));
      signal.addEventListener("abort", () => reject(new Error("bridge wait stopped")), { once: true });
    });
    throw new Error(`Unexpected bridge operation: ${op}`);
  };

  const context = {
    app: { version: "2.0.27" },
    options: { relayRoot: root, profile: "default", nativeSession, bindings: [binding], consume: true },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID }),
      wait: async () => {},
      prompt: async (input) => ({ id: input.id }),
      hook: async (name, callback) => { nativeHooks.set(name, callback); return { dispose: async () => nativeHooks.delete(name) }; },
    },
    event: { subscribe: nativeEvents.subscribe },
    tool: {
      transform: async (edit) => {
        const staged = new Map(tools);
        edit({
          list: () => [...staged.values()],
          add: (tool) => staged.set(tool.name, { ...tool, id: tool.name }),
        });
        tools.clear();
        for (const [name, tool] of staged) tools.set(name, tool);
        return { dispose: async () => { for (const [name] of staged) tools.delete(name); } };
      },
      list: async () => [...tools.values()],
    },
  };
  const cleanup = await createOpenCodePlugin({ callBridge }).setup(context);
  assert.equal(typeof cleanup, "function");
  assert.equal(bridgeBindings.length, 1);
  assert.equal(bridgeBindings[0].consume, true);
  assert.deepEqual([...tools.keys()].sort(), ["relay_ack", "relay_claim", "relay_pending", "relay_release", "relay_reply"]);
  for (const tool of tools.values()) {
    assert.equal(tool.options.codemode, false);
    assert.equal(tool.options.permission, tool.name);
  }

  const signal = new AbortController().signal;
  const run = (name, input) => tools.get(name).execute(input, { sessionID: nativeSession, signal });
  const pending = JSON.parse((await run("relay_pending", {})).content);
  assert.deepEqual(pending[0].pending, { msg: 1, work: 0 });
  assert.equal(JSON.stringify(pending).includes(binding.authority), false);
  const claim = JSON.parse((await run("relay_claim", { kind: "msg" })).content);
  assert.deepEqual(claim, { lease: "lease_consumer_fixture", kind: "msg", message: { msg: "fixture addressed body" } });
  await assert.rejects(run("relay_claim", { kind: "msg" }), /claim|activation/);
  await assert.rejects(tools.get("relay_pending").execute({ sid: binding.sid }, { sessionID: nativeSession, signal }), /invocation refused/);
  await assert.rejects(tools.get("relay_pending").execute({}, { sessionID: "ses_other", signal }), /invocation refused/);

  nativeEvents.emit({ type: "session.execution.succeeded", data: { sessionID: nativeSession } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.some(({ op }) => op === "ack"), false, "turn completion does not settle a claim");
  await run("relay_reply", { lease: claim.lease, msg: "fixture reply" });
  await run("relay_ack", { lease: claim.lease, outcome: "done" });
  const reply = forwarded.find(({ op }) => op === "reply");
  assert.deepEqual(Object.keys(reply.args).sort(), ["key", "lease", "msg"]);
  assert.equal(reply.args.msg, "fixture reply");
  assert.equal(forwarded.some(({ args }) => args && ("sid" in args || "authority" in args || "worker" in args || "to" in args)), false);
  assert.deepEqual(forwarded.filter(({ op }) => op === "ack").map(({ args }) => args), [{ lease: claim.lease, outcome: "done" }]);

  nativeEvents.emit({ type: "session.execution.failed", data: { sessionID: nativeSession } });
  await new Promise((resolve) => setImmediate(resolve));
  await run("relay_claim", { kind: "work" });
  await waitFor(() => claims === 2);
  assert.equal(forwarded.filter(({ op }) => op === "claim").length, 2);
  await cleanup();
  assert.equal(tools.size, 0);
});

test("consume:false is not an opt-in alias and missing native tool support fails closed", async () => {
  const plugin = createOpenCodePlugin();
  let sessionReads = 0;
  const base = { app: { version: "2.0.27" }, options: { relayRoot: "/tmp/relay", profile: "default", nativeSession,
    bindings: [binding], consume: false }, session: {
      get: async () => { sessionReads++; return { id: nativeSession }; },
      wait: async () => {}, prompt: async () => ({}), hook: async () => ({ dispose: async () => {} }),
    }, event: { subscribe: async function* () {} } };
  assert.equal(await plugin.setup(base), undefined);
  assert.equal(sessionReads, 0);
  await assert.rejects(plugin.setup({ ...base, options: { ...base.options, consume: true }, tool: undefined }), /native tool API is unavailable/);
});

test("bridge recovery rebinds a fresh lifecycle and retains an uncertain native submission ID", async () => {
  const hooks = new Map();
  const targets = [];
  const prompts = [];
  const observations = [];
  let nextCalls = 0;
  let completeCalls = 0;
  const events = eventStream();
  const callBridge = async (_root, op, args, signal) => {
    if (op === "delivery.bind") {
      targets.push(args.target);
      return { bindingId: `bridge_binding_${targets.length}` };
    }
    if (op === "delivery.close") return { closed: true };
    if (op === "delivery.next") {
      nextCalls++;
      if (nextCalls === 1) return { command: { callId: "call_uncertain", method: "submit", args: { attemptId: "delivery-uncertain", notice: "Fixture notice" } } };
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    }
    if (op === "delivery.complete") {
      completeCalls++;
      throw new Error("Bridge lost after native admission");
    }
    if (op === "delivery.observe") { observations.push(args); return { applied: true }; }
    throw new Error(`Unexpected bridge operation: ${op}`);
  };
  const cleanup = await createOpenCodePlugin({ callBridge }).setup({
    app: { version: "2.0.27" },
    options: { relayRoot: "/tmp/relay-reconnect-fixture", profile: "default", nativeSession,
      bindings: [binding] },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID }),
      wait: async () => {},
      prompt: async (input) => { prompts.push(input); return { id: input.id }; },
      hook: async (name, callback) => { hooks.set(name, callback); return { dispose: async () => hooks.delete(name) }; },
    },
    event: { subscribe: events.subscribe },
  });
  assert.equal(typeof cleanup, "function");
  await waitFor(() => targets.length === 2 && completeCalls === 1 && prompts.length === 1);
  assert.notEqual(targets[0].lifecycleGeneration, targets[1].lifecycleGeneration);
  const acceptedId = prompts[0].id;
  assert.equal(acceptedId, `msg_${(await import("node:crypto")).createHash("sha256").update("relay:delivery-uncertain").digest("hex").slice(0, 32)}`);
  hooks.get("context")({ sessionID: nativeSession, messages: [{ id: acceptedId }] });
  await waitFor(() => observations.some((item) => item.attemptId === "delivery-uncertain"));
  assert.equal(observations[0].observation.state, "context_observed");
  assert.equal(observations[0].observation.nativeRequestId, acceptedId);
  assert.equal(prompts.length, 1, "recovery reports the accepted ID and never resubmits the prompt");
  await cleanup();
});

test("delivery.next transport recovery rebinds and resumes consuming commands", async () => {
  const targets = [];
  const completed = [];
  const hooks = new Map();
  let nextCalls = 0;
  let prompts = 0;
  const callBridge = async (_root, op, args, signal) => {
    if (op === "delivery.bind") { targets.push(args.target); return { bindingId: `bridge_binding_${targets.length}` }; }
    if (op === "delivery.close") return { closed: true };
    if (op === "delivery.next") {
      nextCalls++;
      if (nextCalls === 1) throw new Error("one-time bridge outage");
      if (nextCalls === 2) return { command: { callId: "status-after-reconnect", method: "status", args: {} } };
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    }
    if (op === "delivery.complete") { completed.push(args); return { completed: true }; }
    if (op === "delivery.observe") return { applied: true };
    throw new Error(`Unexpected bridge operation: ${op}`);
  };
  const cleanup = await createOpenCodePlugin({ callBridge }).setup({
    app: { version: "2.0.27" },
    options: { relayRoot: "/tmp/relay-next-reconnect", profile: "default", nativeSession, bindings: [binding] },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID }), wait: async () => { prompts++; },
      prompt: async () => { throw new Error("status must not submit"); },
      hook: async (name, callback) => { hooks.set(name, callback); return { dispose: async () => hooks.delete(name) }; },
    },
    event: { subscribe: eventStream().subscribe },
  });
  await waitFor(() => completed.length === 1);
  assert.equal(targets.length, 2);
  assert.notEqual(targets[0].lifecycleGeneration, targets[1].lifecycleGeneration);
  assert.equal(completed[0].callId, "status-after-reconnect");
  assert.deepEqual(completed[0].result, { state: "idle" });
  assert.equal(prompts, 1);
  await cleanup();
});

test("native prompt failure stops with uncertain admission and does not reconnect or resend", async () => {
  const targets = [];
  const hooks = new Map();
  let nextCalls = 0;
  let prompts = 0;
  const callBridge = async (_root, op, args, signal) => {
    if (op === "delivery.bind") { targets.push(args.target); return { bindingId: `bridge_binding_${targets.length}` }; }
    if (op === "delivery.close") return { closed: true };
    if (op === "delivery.next") {
      nextCalls++;
      if (nextCalls === 1) return { command: { callId: "uncertain-submit", method: "submit", args: { attemptId: "uncertain-native", notice: "notice" } } };
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    }
    throw new Error(`Unexpected bridge operation: ${op}`);
  };
  const cleanup = await createOpenCodePlugin({ callBridge }).setup({
    app: { version: "2.0.27" },
    options: { relayRoot: "/tmp/relay-native-failure", profile: "default", nativeSession, bindings: [binding] },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID }), wait: async () => {},
      prompt: async () => { prompts++; throw new Error("native admission outcome unknown"); },
      hook: async (name, callback) => { hooks.set(name, callback); return { dispose: async () => hooks.delete(name) }; },
    },
    event: { subscribe: eventStream().subscribe },
  });
  await waitFor(() => prompts === 1 && hooks.size === 0);
  assert.equal(targets.length, 1);
  assert.equal(prompts, 1);
  await cleanup();
});

test("closing during rebind closes a late binding instead of installing it", async () => {
  const targets = [];
  const closed = [];
  let bindStarted;
  let finishBind;
  const rebinding = new Promise((resolve) => { bindStarted = resolve; });
  const lateBinding = new Promise((resolve) => { finishBind = resolve; });
  let nextCalls = 0;
  const callBridge = async (_root, op, args) => {
    if (op === "delivery.bind") {
      targets.push(args.target);
      if (targets.length === 1) return { bindingId: "bridge_binding_1" };
      bindStarted();
      return lateBinding;
    }
    if (op === "delivery.close") { closed.push(args.bindingId); return { closed: true }; }
    if (op === "delivery.next") { nextCalls++; throw new Error("bridge unavailable"); }
    throw new Error(`Unexpected bridge operation: ${op}`);
  };
  const cleanup = await createOpenCodePlugin({ callBridge }).setup({
    app: { version: "2.0.27" },
    options: { relayRoot: "/tmp/relay-close-backoff", profile: "default", nativeSession, bindings: [binding] },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID }), wait: async () => {}, prompt: async () => ({}),
      hook: async () => ({ dispose: async () => {} }),
    },
    event: { subscribe: eventStream().subscribe },
  });
  await waitFor(() => nextCalls === 1);
  await rebinding;
  const stopping = cleanup();
  finishBind({ bindingId: "bridge_binding_late" });
  await stopping;
  assert.equal(targets.length, 2);
  assert.deepEqual(closed, ["bridge_binding_1", "bridge_binding_late"]);
});
