import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDeliveryAdapter } from "../src/adapters/opencode.mjs";
import { callOpenCodeBridge } from "../src/adapters/opencode-bridge.mjs";
import { createOpenCodePlugin } from "../src/adapters/opencode-plugin-core.mjs";
import nativePlugin from "../src/adapters/opencode-plugin.mjs";

const sessionId = "ses_relay_fixture_01";

function eventStream() {
  const queue = [];
  const waiters = [];
  const stop = Symbol("stop");
  return {
    emit(value) {
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else queue.push(value);
    },
    async *subscribe({ signal }) {
      const onAbort = () => {
        while (waiters.length) waiters.shift()(stop);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (!signal.aborted) {
          const value = queue.length ? queue.shift() : await new Promise((resolve) => waiters.push(resolve));
          if (value === stop) return;
          yield value;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for the native observation");
}

test("OpenCode bridge authenticates, shares local/hub bindings, and observes admission, context, turn, and safe idle", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-opencode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evidence = [];
  const bindings = [];
  const observations = [];
  const controller = new AbortController();
  const adapter = await startDeliveryAdapter({
    client: "opencode",
    root,
    signal: controller.signal,
    onEvidence: (value) => evidence.push(value),
    bind: async (input) => {
      bindings.push(input);
      return Object.freeze({
        close: async () => {},
        observe: async (attemptId, observation) => {
          observations.push({ attemptId, ...observation });
          return true;
        },
      });
    },
  });
  t.after(() => adapter.close());
  assert.equal(statSync(join(root, "opencode-delivery.token")).mode & 0o077, 0);
  assert.equal(statSync(join(root, "opencode-delivery.sock")).mode & 0o077, 0);
  const unauthorizedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath: join(root, "opencode-delivery.sock"),
      method: "POST",
      path: "/v1/call",
      headers: { authorization: `Relay ${"0".repeat(64)}`, "content-type": "application/json", "content-length": "2" },
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once("error", reject);
    request.end("{}");
  });
  assert.equal(unauthorizedStatus, 401);

  const hooks = new Map();
  const prompts = [];
  const events = eventStream();
  let state = "idle";
  let failNextPrompt = false;
  const native = {
    get: async ({ sessionID }) => sessionID === sessionId ? { id: sessionID } : null,
    wait: async ({ sessionID }, { signal }) => {
      if (sessionID !== sessionId) throw new Error("wrong session");
      if (state === "idle") return;
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("wait deadline")), { once: true });
      });
    },
    prompt: async (input) => {
      if (failNextPrompt) throw new Error("Native prompt failed");
      prompts.push(input);
      return { id: input.id };
    },
    hook: async (name, callback) => {
      hooks.set(name, callback);
      return () => hooks.delete(name);
    },
  };
  const plugin = createOpenCodePlugin();
  assert.equal(nativePlugin.id, "pugzui-relay-delivery");
  assert.equal(typeof nativePlugin.setup, "function");
  const relayBindings = [
    { authority: "host:relay", worker: "relay-device:opencode:prime", sid: "relay-session-local", epoch: 1 },
    { authority: "hub:relay", worker: "relay-device:opencode:prime", sid: "relay-session-hub", epoch: 2 },
  ];
  const options = { bindings: relayBindings, nativeSession: sessionId, profile: "default", relayRoot: root };
  const refusedSetup = await plugin.setup({
    app: { version: "2.0.26" },
    options,
    session: { ...native, get: async () => ({ id: "ses_wrong_target" }) },
    event: { subscribe: events.subscribe },
  });
  assert.equal(refusedSetup, undefined);
  assert.equal(hooks.size, 0);
  assert.equal(bindings.length, 0);

  const cleanup = await plugin.setup({
    app: { version: "2.0.26" },
    options,
    session: native,
    event: { subscribe: events.subscribe },
  });
  assert.equal(typeof cleanup, "function", JSON.stringify({ hooks: [...hooks.keys()], bindings: bindings.length, evidence }));
  assert.equal(bindings.length, 2);
  assert.equal(bindings[0].consumer, bindings[1].consumer);
  assert.deepEqual(bindings[0].target, bindings[1].target);
  assert.ok(evidence.includes("wired"));

  try {
    state = "busy";
    assert.deepEqual(await bindings[0].consumer.status(), { state: "busy" });
    state = "idle";
    assert.deepEqual(await bindings[0].consumer.status(), { state: "idle" });

    const attemptId = "delivery-fixture-01";
    const admission = await bindings[0].consumer.submit({ attemptId, notice: { text: "Relay pending-state fixture notice" } });
    assert.equal(admission.accepted, true);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].sessionID, sessionId);
    assert.equal(prompts[0].delivery, "queue");
    assert.equal(prompts[0].resume, true);
    assert.equal(prompts[0].id, admission.nativeRequestId);

    hooks.get("context")({ sessionID: sessionId, messages: [{ id: admission.nativeRequestId }] });
    await waitFor(() => observations.some((item) => item.attemptId === attemptId && item.state === "context_observed"));
    hooks.get("model.request")({ sessionID: sessionId, messages: [{ id: admission.nativeRequestId }] });
    await waitFor(() => observations.some((item) => item.attemptId === attemptId && item.state === "turn_started"));
    events.emit({ type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } });
    await waitFor(() => observations.some((item) => item.attemptId === attemptId && item.state === "safe_idle"));
    assert.equal(new Set(observations.filter((item) => item.attemptId === attemptId).map((item) => item.state)).size, 3);

    failNextPrompt = true;
    await assert.rejects(bindings[0].consumer.submit({ attemptId: "delivery-fixture-failure", notice: { text: "Failure fixture" } }));
    await waitFor(() => evidence.at(-1) === "pending");
    assert.equal(hooks.size, 0);
  } finally {
    await cleanup();
    await adapter.close();
  }

  assert.equal(evidence.at(-1), "pending");
  assert.equal(existsSync(join(root, "opencode-delivery.sock")), false);
  assert.equal(existsSync(join(root, "opencode-delivery.token")), false);
});

test("OpenCode bridge closes a late Relay binding when shutdown races startup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-opencode-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let started;
  let release;
  const bindingStarted = new Promise((resolve) => { started = resolve; });
  const pendingBind = new Promise((resolve) => { release = resolve; });
  let closedHandle = false;
  const adapter = await startDeliveryAdapter({
    client: "opencode",
    root,
    signal: new AbortController().signal,
    onEvidence: () => {},
    bind: async () => {
      started();
      return pendingBind;
    },
  });
  t.after(() => adapter.close());
  const request = callOpenCodeBridge(root, "delivery.bind", {
    authority: "host:fixture",
    worker: "fixture-device:opencode:prime",
    sid: "relay-session",
    epoch: 1,
    profile: "default",
    target: { runtimeInstance: "opencode-fixture", profile: "default", nativeSession: sessionId, lifecycleGeneration: "fixture-life" },
    capabilities: { context: true, idle: true, launch: false },
  });
  await bindingStarted;
  const stopping = adapter.close();
  release({ close: async () => { closedHandle = true; }, observe: async () => true });
  await assert.rejects(request);
  await stopping;
  assert.equal(closedHandle, true);
});
