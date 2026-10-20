import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startDeliveryAdapter } from "../src/adapters/opencode.mjs";
import { callOpenCodeBridge } from "../src/adapters/opencode-bridge.mjs";

async function bridgeFixture(t, consume) {
  const root = await mkdtemp(join(tmpdir(), "relay-consumer-boundary-"));
  const calls = [];
  const controller = new AbortController();
  const adapter = await startDeliveryAdapter({
    client: "opencode",
    root,
    signal: controller.signal,
    onEvidence() {},
    bind: async () => ({
      close: async () => {},
      observe: async () => true,
      recipient: (op, args) => {
        calls.push({ op, args });
        if (op === "claim")
          return {
            id: "lease-large",
            mid: "message-large",
            sid: "fixture-relay-session",
            epoch: 1,
            until: Date.now() + 30_000,
            attempt: 1,
            kind: "work",
            work: { task: "x".repeat(60_000) },
          };
        return { id: "reply-large", repeat: false, init: Date.now() };
      },
    }),
  });
  t.after(async () => {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  });
  const binding = await callOpenCodeBridge(root, "delivery.bind", {
    authority: "fixture-authority",
    worker: "fixture:opencode:001",
    sid: "fixture-relay-session",
    epoch: 1,
    profile: "fixture",
    target: {
      runtimeInstance: "fixture-runtime",
      profile: "fixture",
      nativeSession: "ses_fixture_large",
      lifecycleGeneration: randomUUID(),
    },
    capabilities: { context: true, idle: true, launch: false },
    ...(consume ? { consume: true } : {}),
  });
  return { root, calls, bindingId: binding.bindingId };
}

test("notice-only bridge bindings cannot invoke recipient mutations", async (t) => {
  const fixture = await bridgeFixture(t, false);
  await assert.rejects(
    callOpenCodeBridge(fixture.root, "delivery.recipient", {
      bindingId: fixture.bindingId,
      op: "claim",
      args: { kind: "work" },
    }),
  );
  assert.equal(fixture.calls.length, 0);
});

test("recipient bridge carries valid large work and replies within bounded framing", async (t) => {
  const fixture = await bridgeFixture(t, true);
  const claim = await callOpenCodeBridge(fixture.root, "delivery.recipient", {
    bindingId: fixture.bindingId,
    op: "claim",
    args: { kind: "work" },
  });
  assert.equal(claim.work.task.length, 60_000);
  const result = await callOpenCodeBridge(fixture.root, "delivery.recipient", {
    bindingId: fixture.bindingId,
    op: "reply",
    args: { lease: claim.id, msg: "y".repeat(4096), key: "large-reply" },
  });
  assert.equal(result.id, "reply-large");
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[1].args.msg.length, 4096);
});

test("recipient reply framing allows bounded JSON escape expansion", async (t) => {
  const fixture = await bridgeFixture(t, true);
  const msg = "\u0001".repeat(4096);
  const result = await callOpenCodeBridge(fixture.root, "delivery.recipient", {
    bindingId: fixture.bindingId,
    op: "reply",
    args: { lease: "lease-escaped", msg, key: "escaped-reply" },
  });
  assert.equal(result.id, "reply-large");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].args.msg, msg);
  await assert.rejects(
    callOpenCodeBridge(fixture.root, "delivery.recipient", {
      bindingId: fixture.bindingId,
      op: "reply",
      args: { lease: "lease-escaped", msg: "x".repeat(4097), key: "oversized-reply" },
    }),
  );
  assert.equal(fixture.calls.length, 1);
});
