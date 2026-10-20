import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDeliveryAdapter } from "../src/adapters/opencode.mjs";
import { callOpenCodeBridge } from "../src/adapters/opencode-bridge.mjs";
import { createOpenCodePlugin } from "../src/adapters/opencode-plugin-core.mjs";
import nativePlugin from "../src/adapters/index.mjs";
import { randomUUID } from "node:crypto";
import { setup } from "../src/index.mjs";
import { openForBroker, claimDeliveryOwner, listDeliveryAttempts } from "../src/relay.mjs";
import { createDeliverySupervisor } from "../src/delivery.mjs";
import freeProvider from "./spikes/003-opencode-native-delivery/free-provider.mjs";

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
          const value = queue.length
            ? queue.shift()
            : await new Promise((resolve) => waiters.push(resolve));
          if (value === stop) return;
          yield value;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function waitFor(predicate, describe = () => "") {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for the native observation ${describe()}`);
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
    bind: (input) => {
      bindings.push(input);
      return Promise.resolve(
        Object.freeze({
          close: () => Promise.resolve(),
          observe: (attemptId, observation) => {
            observations.push({ attemptId, ...observation });
            return Promise.resolve(true);
          },
        }),
      );
    },
  });
  t.after(() => adapter.close());
  assert.equal(statSync(join(root, "opencode-delivery.token")).mode & 0o077, 0);
  assert.equal(statSync(join(root, "opencode-delivery.sock")).mode & 0o077, 0);
  const unauthorizedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: join(root, "opencode-delivery.sock"),
        method: "POST",
        path: "/v1/call",
        headers: {
          authorization: `Relay ${"0".repeat(64)}`,
          "content-type": "application/json",
          "content-length": "2",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.once("error", reject);
    request.end("{}");
  });
  assert.equal(unauthorizedStatus, 401);

  const hooks = new Map();
  const prompts = [];
  const events = eventStream();
  let state = "idle";
  let waitCalls = 0;
  const busyWaits = [];
  let failNextPrompt = false;
  const native = {
    get: async ({ sessionID }) => (sessionID === sessionId ? { id: sessionID } : null),
    wait: async ({ sessionID }) => {
      waitCalls++;
      if (sessionID !== sessionId) throw new Error("wrong session");
      if (state === "unknown") throw new Error("Native idle check unavailable");
      if (state === "idle") return;
      await new Promise((resolve) => busyWaits.push(resolve));
    },
    prompt: (input) => {
      if (failNextPrompt) return Promise.reject(new Error("Native prompt failed"));
      prompts.push(input);
      return Promise.resolve({ id: input.id });
    },
    hook: (name, callback) => {
      hooks.set(name, callback);
      return Promise.resolve(() => hooks.delete(name));
    },
  };
  const plugin = createOpenCodePlugin();
  assert.equal(nativePlugin.id, "pugzui-relay-delivery");
  assert.equal(typeof nativePlugin.setup, "function");
  const relayBindings = [
    {
      authority: "host:relay",
      worker: "relay-device:opencode:prime",
      sid: "relay-session-local",
      epoch: 1,
    },
    {
      authority: "hub:relay",
      worker: "relay-device:opencode:prime",
      sid: "relay-session-hub",
      epoch: 2,
    },
  ];
  const options = {
    bindings: relayBindings,
    nativeSession: sessionId,
    profile: "default",
    relayRoot: root,
  };
  const refusedSetup = await plugin.setup({
    app: { version: "2.0.27" },
    options,
    session: { ...native, get: async () => ({ id: "ses_wrong_target" }) },
    event: { subscribe: events.subscribe },
  });
  assert.equal(refusedSetup, undefined);
  assert.equal(hooks.size, 0);
  assert.equal(bindings.length, 0);

  const cleanup = await plugin.setup({
    app: { version: "2.0.27" },
    options,
    session: native,
    event: { subscribe: events.subscribe },
  });
  assert.equal(
    typeof cleanup,
    "function",
    JSON.stringify({ hooks: [...hooks.keys()], bindings: bindings.length, evidence }),
  );
  assert.equal(bindings.length, 2);
  assert.equal(bindings[0].consumer, bindings[1].consumer);
  assert.deepEqual(bindings[0].target, bindings[1].target);
  assert.ok(evidence.includes("wired"));

  try {
    state = "busy";
    assert.deepEqual(await bindings[0].consumer.status(), { state: "busy" });
    state = "idle";
    for (const resolve of busyWaits) resolve();
    assert.deepEqual(await bindings[0].consumer.status(), { state: "idle" });

    const attemptId = "delivery-fixture-01";
    const admission = await bindings[0].consumer.submit({
      attemptId,
      notice: "Relay pending-state fixture notice",
    });
    assert.equal(admission.accepted, true);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].sessionID, sessionId);
    assert.equal(prompts[0].delivery, "queue");
    assert.equal(prompts[0].resume, true);
    assert.equal(prompts[0].id, admission.nativeRequestId);
    assert.equal(prompts[0].text, "Relay pending-state fixture notice");

    hooks.get("context")({ sessionID: sessionId, messages: [{ id: admission.nativeRequestId }] });
    await waitFor(() =>
      observations.some(
        (item) => item.attemptId === attemptId && item.state === "context_observed",
      ),
    );
    hooks.get("model.request")({
      sessionID: sessionId,
      kind: "title",
      agent: "build",
      model: { providerID: "fixture", id: "fixture" },
      headers: {},
    });
    assert.equal(
      observations.some((item) => item.state === "turn_started"),
      false,
    );
    hooks.get("model.request")({
      sessionID: sessionId,
      kind: "primary",
      agent: "build",
      model: { providerID: "fixture", id: "fixture" },
      headers: {},
    });
    await waitFor(() =>
      observations.some((item) => item.attemptId === attemptId && item.state === "turn_started"),
    );
    const previousWaitCalls = waitCalls;
    events.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_other_target" } });
    events.emit({ type: "session.step.ended", data: { sessionID: sessionId } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(waitCalls, previousWaitCalls);
    state = "unknown";
    events.emit({ type: "session.execution.succeeded", data: { sessionID: sessionId } });
    await waitFor(() => waitCalls > previousWaitCalls);
    assert.equal(
      observations.some((item) => item.state === "safe_idle"),
      false,
    );
    state = "idle";
    events.emit({ type: "session.execution.succeeded", data: { sessionID: sessionId } });
    await waitFor(() =>
      observations.some((item) => item.attemptId === attemptId && item.state === "safe_idle"),
    );
    assert.equal(
      new Set(observations.filter((item) => item.attemptId === attemptId).map((item) => item.state))
        .size,
      3,
    );

    failNextPrompt = true;
    await assert.rejects(
      bindings[0].consumer.submit({
        attemptId: "delivery-fixture-failure",
        notice: "Failure fixture",
      }),
    );
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

test("OpenCode plugin consumes the real supervisor's string notice without exposing message payloads", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-opencode-supervisor-"));
  const nativeSession = `ses_fixture_${randomUUID()}`;
  let local;
  let supervisor;
  let cleanup;
  let releaseIdle = () => {};
  t.after(async () => {
    releaseIdle();
    try {
      await cleanup?.();
    } finally {
      try {
        await supervisor?.close();
      } finally {
        try {
          local?.close();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });
  setup({ root, device: "fixture", role: "host" });
  local = openForBroker({ root, role: "host", ownerToken: "a".repeat(32) });
  const owner = claimDeliveryOwner(local);
  const worker = local.register("opencode");
  const session = local.join(worker.id);
  supervisor = createDeliverySupervisor({
    local,
    hub: null,
    pool: null,
    launchConfigured: false,
    ownerGeneration: owner.generation,
    clients: ["opencode"],
    pollMs: 250,
  });
  await supervisor.start();
  const prompts = [];
  const events = eventStream();
  const hooks = new Map();
  let nativeBusy = false;
  let idleReads = 0;
  let nativeIdle = new Promise((resolve) => {
    releaseIdle = resolve;
  });
  cleanup = await createOpenCodePlugin().setup({
    app: { version: "2.0.27" },
    options: {
      relayRoot: root,
      profile: "default",
      nativeSession,
      bindings: [
        { authority: local.authority, worker: worker.id, sid: session.id, epoch: session.epoch },
      ],
    },
    session: {
      get: async () => ({ id: nativeSession }),
      wait: async () => {
        if (nativeBusy) {
          idleReads++;
          await nativeIdle;
        }
      },
      hook: (name, callback) => {
        hooks.set(name, callback);
        return Promise.resolve(() => hooks.delete(name));
      },
      prompt: (input) => {
        prompts.push(input);
        return Promise.resolve({ id: input.id });
      },
    },
    event: { subscribe: events.subscribe },
  });
  assert.equal(typeof cleanup, "function");
  const payload = "Private work body must stay in the authoritative Relay queue";
  local.send(session.id, worker.id, { msg: payload });
  await supervisor.refresh();
  await waitFor(
    () => prompts.length === 1,
    () => JSON.stringify({ prompts: prompts.length, status: supervisor.status() }),
  );
  assert.match(prompts[0].text, /^Relay pending state changed\./);
  assert.match(prompts[0].text, /msg=1 work=0/);
  assert.equal(prompts[0].text.includes(payload), false);
  assert.equal(prompts[0].sessionID, nativeSession);
  assert.equal(prompts[0].delivery, "queue");
  assert.equal(prompts[0].resume, true);
  const attempts = listDeliveryAttempts(local, owner.generation);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, "admitted");
  assert.equal(attempts[0].nativeRequestId, prompts[0].id);
  assert.equal(local.pending(session.id).pending.msg, 1);
  hooks.get("context")({ sessionID: nativeSession, messages: [{ id: prompts[0].id }] });
  hooks.get("model.request")({ sessionID: nativeSession, kind: "primary" });
  nativeBusy = true;
  events.emit({ type: "session.execution.succeeded", data: { sessionID: nativeSession } });
  await waitFor(() => idleReads === 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(listDeliveryAttempts(local, owner.generation)[0].state, "turn_started");
  nativeBusy = false;
  releaseIdle();
  await waitFor(() => listDeliveryAttempts(local, owner.generation)[0]?.state === "safe_idle");
  assert.equal(idleReads, 1);
  assert.equal(supervisor.status().core.targets.locked, 0);
  assert.equal(local.pending(session.id).pending.msg, 1);

  local.send(session.id, worker.id, { work: "Additional pending work" });
  await supervisor.refresh();
  await waitFor(() => prompts.length === 2);
  const latest = () =>
    listDeliveryAttempts(local, owner.generation).find(
      (attempt) => attempt.nativeRequestId === prompts[1].id,
    );
  hooks.get("context")({ sessionID: nativeSession, messages: [{ id: prompts[1].id }] });
  hooks.get("model.request")({ sessionID: nativeSession, kind: "primary" });
  nativeIdle = new Promise((resolve) => {
    releaseIdle = resolve;
  });
  nativeBusy = true;
  events.emit({ type: "session.execution.succeeded", data: { sessionID: nativeSession } });
  await waitFor(() => idleReads === 2);
  for (let index = 0; index < 5; index++)
    events.emit({ type: "session.execution.succeeded", data: { sessionID: nativeSession } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idleReads, 2);
  await cleanup();
  nativeBusy = false;
  releaseIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(latest().state, "safe_idle");
  assert.equal(latest().safeIdleAt, null);
  assert.deepEqual(local.pending(session.id).pending, { msg: 1, work: 1 });
});

test("OpenCode bridge closes a late Relay binding when shutdown races startup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-opencode-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let started;
  let release;
  const bindingStarted = new Promise((resolve) => {
    started = resolve;
  });
  const pendingBind = new Promise((resolve) => {
    release = resolve;
  });
  let closedHandle = false;
  const adapter = await startDeliveryAdapter({
    client: "opencode",
    root,
    signal: new AbortController().signal,
    onEvidence: () => {},
    bind: () => {
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
    target: {
      runtimeInstance: "opencode-fixture",
      profile: "default",
      nativeSession: sessionId,
      lifecycleGeneration: "fixture-life",
    },
    capabilities: { context: true, idle: true, launch: false },
  });
  await bindingStarted;
  const stopping = adapter.close();
  release({
    close: () => {
      closedHandle = true;
      return Promise.resolve();
    },
    observe: () => Promise.resolve(true),
  });
  await assert.rejects(request);
  await stopping;
  assert.equal(closedHandle, true);
});

test("OpenCode bridge gates recipient forwarding on consume and keeps identity outside tool arguments", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-opencode-recipient-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const received = [];
  const controller = new AbortController();
  const adapter = await startDeliveryAdapter({
    client: "opencode",
    root,
    signal: controller.signal,
    onEvidence: () => {},
    bind: (input) => {
      assert.equal(
        Object.hasOwn(input, "consume"),
        false,
        "adapter-only opt-in is stripped before supervisor bind",
      );
      return Promise.resolve(
        Object.freeze({
          close: () => Promise.resolve(),
          observe: () => Promise.resolve(true),
          recipient: (op, args) => {
            received.push({ op, args });
            return Promise.resolve({ op, args });
          },
        }),
      );
    },
  });
  t.after(() => adapter.close());

  const target = {
    runtimeInstance: "opencode-fixture",
    profile: "default",
    nativeSession: sessionId,
    lifecycleGeneration: "lifecycle-fixture",
  };
  const base = {
    authority: "host:relay",
    worker: "relay-device:opencode:prime",
    sid: "relay-session-fixture",
    epoch: 4,
    profile: "default",
    target,
    capabilities: { context: true, idle: true, launch: false },
  };
  const consuming = await callOpenCodeBridge(root, "delivery.bind", { ...base, consume: true });
  const noticeOnly = await callOpenCodeBridge(root, "delivery.bind", base);

  const forwarded = await callOpenCodeBridge(root, "delivery.recipient", {
    bindingId: consuming.bindingId,
    op: "reply",
    args: { lease: "lease_fixture", msg: "response", key: "fixed-session-key" },
  });
  assert.deepEqual(forwarded, {
    op: "reply",
    args: { lease: "lease_fixture", msg: "response", key: "fixed-session-key" },
  });
  assert.deepEqual(received, [
    { op: "reply", args: { lease: "lease_fixture", msg: "response", key: "fixed-session-key" } },
  ]);
  await assert.rejects(
    callOpenCodeBridge(root, "delivery.recipient", {
      bindingId: noticeOnly.bindingId,
      op: "pending",
      args: {},
    }),
    /rejected/,
  );
  await assert.rejects(
    callOpenCodeBridge(root, "delivery.recipient", {
      bindingId: consuming.bindingId,
      op: "claim",
      args: { kind: "work", sid: "forged" },
    }),
    /rejected/,
  );

  await callOpenCodeBridge(root, "delivery.close", { bindingId: consuming.bindingId });
  await callOpenCodeBridge(root, "delivery.close", { bindingId: noticeOnly.bindingId });
  await adapter.close();
});

test("OpenCode status and cleanup stay bounded when SDK reads ignore abort", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-opencode-busy-"));
  const waits = [];
  const reads = [];
  const bindings = [];
  let state = "busy";
  let blockRead = false;
  let cleanup;
  let adapter;
  const events = eventStream();
  const idle = () => {
    state = "idle";
    for (const resolve of waits) resolve();
    for (const resolve of reads) resolve();
  };
  t.after(async () => {
    idle();
    try {
      await cleanup?.();
    } finally {
      try {
        await adapter?.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  adapter = await startDeliveryAdapter({
    client: "opencode",
    root,
    signal: new AbortController().signal,
    onEvidence: () => {},
    bind: (input) => {
      bindings.push(input);
      return Promise.resolve({
        close: () => Promise.resolve(),
        observe: () => Promise.resolve(true),
      });
    },
  });
  cleanup = await createOpenCodePlugin().setup({
    app: { version: "2.0.27" },
    options: {
      relayRoot: root,
      profile: "default",
      nativeSession: sessionId,
      bindings: [
        {
          authority: "host:fixture",
          worker: "fixture-device:opencode:prime",
          sid: "relay-session",
          epoch: 1,
        },
      ],
    },
    session: {
      get: async () => {
        if (blockRead) await new Promise((resolve) => reads.push(resolve));
        return { id: sessionId };
      },
      wait: async () => {
        if (state !== "idle") await new Promise((resolve) => waits.push(resolve));
      },
      hook: async () => ({ dispose: async () => {} }),
      prompt: async (input) => ({ id: input.id }),
    },
    event: { subscribe: events.subscribe },
  });
  assert.equal(typeof cleanup, "function");
  const boundedStatus = async (timeoutMs = 1000) => {
    let timer;
    try {
      return await Promise.race([
        bindings[0].consumer.status(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Status did not settle within the native observation bound")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  assert.deepEqual(await boundedStatus(), { state: "busy" });
  assert.deepEqual(await boundedStatus(), { state: "busy" });
  assert.deepEqual(await boundedStatus(), { state: "busy" });
  assert.equal(waits.length, 1);
  idle();
  assert.deepEqual(await boundedStatus(), { state: "idle" });
  blockRead = true;
  assert.deepEqual(await boundedStatus(1500), { state: "unknown" });
  assert.deepEqual(await boundedStatus(1500), { state: "unknown" });
  assert.equal(reads.length, 1);
  blockRead = false;
  idle();
  assert.deepEqual(await boundedStatus(), { state: "idle" });

  state = "busy";
  const pendingStatus = bindings[0].consumer.status();
  const disconnected = assert.rejects(pendingStatus);
  await waitFor(() => waits.length === 2);
  let timer;
  try {
    await Promise.race([
      cleanup(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cleanup awaited an uncancellable SDK read")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  await disconnected;
});

const FREE_PROVIDER_FAILURES = [
  "none",
  "hook-setup",
  "retry-dispose",
  "rollback-dispose",
  "both-dispose",
];

function freeProviderFixture(failure) {
  const calls = [];
  const hookError = new Error("retry hook failed");
  const providerError = new Error("provider disposal failed");
  const setupFails = failure === "hook-setup" || failure === "rollback-dispose";
  const providerDispose = () => {
    calls.push("provider");
    if (failure === "rollback-dispose" || failure === "both-dispose")
      return Promise.reject(providerError);
    return Promise.resolve();
  };
  const retryDispose = () => {
    calls.push("retry");
    if (failure === "retry-dispose" || failure === "both-dispose") return Promise.reject(hookError);
    return Promise.resolve();
  };
  const ctx = {
    options: {
      baseURL: "http://127.0.0.1:8080/v1",
      route: "openrouter/free",
      contextTokens: 2048,
      outputTokens: 1024,
    },
    provider: { transform: () => Promise.resolve({ dispose: providerDispose }) },
    session: {
      hook: () =>
        setupFails ? Promise.reject(hookError) : Promise.resolve({ dispose: retryDispose }),
    },
  };
  return { calls, ctx, hookError, providerError, setupFails };
}

function isAggregate(error, first, second) {
  return error instanceof AggregateError && error.errors[0] === first && error.errors[1] === second;
}

test("free inference helper disposes SDK registrations and rolls back failed setup", async (t) => {
  for (const failure of FREE_PROVIDER_FAILURES) {
    await t.test(failure, async () => {
      const { calls, ctx, hookError, providerError, setupFails } = freeProviderFixture(failure);
      if (setupFails) {
        await assert.rejects(freeProvider.setup(ctx), (error) =>
          failure === "rollback-dispose"
            ? isAggregate(error, hookError, providerError)
            : error === hookError,
        );
        assert.deepEqual(calls, ["provider"]);
        return;
      }
      const cleanup = await freeProvider.setup(ctx);
      if (failure === "both-dispose") {
        await assert.rejects(cleanup(), (error) => isAggregate(error, hookError, providerError));
      } else if (failure === "retry-dispose") {
        await assert.rejects(cleanup(), (error) => error === hookError);
      } else {
        await cleanup();
      }
      assert.deepEqual(calls, ["retry", "provider"]);
    });
  }
});
