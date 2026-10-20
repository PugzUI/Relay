import assert from "node:assert/strict";
import test from "node:test";
import { createRecipientSession } from "../src/adapters/recipient-session.mjs";
import { LIMITS } from "../src/validate.mjs";

const binding = {
  id: "binding_fixture",
  authority: "host:fixture",
  worker: "fixture:opencode:prime",
  sid: "session_fixture",
  epoch: 4,
};

function session(now, value = binding) {
  return {
    id: value.sid,
    worker: value.worker,
    epoch: value.epoch,
    until: now + 60000,
    ended: null,
  };
}

function summary(value = binding) {
  return {
    v: 1,
    authority: value.authority,
    worker: value.worker,
    epoch: value.epoch,
    revision: "a".repeat(64),
    pending: { msg: 1, work: 0 },
    recoverable: { msg: 0, work: 0 },
  };
}

function lease(now, value = binding, fields = {}) {
  return {
    id: "lease_fixture",
    mid: "message_fixture",
    sid: value.sid,
    epoch: value.epoch,
    until: now + 90000,
    attempt: 1,
    kind: "msg",
    msg: "addressed body",
    ...fields,
  };
}

function receipt(value = binding, outcome = "done") {
  return {
    mid: "message_fixture",
    lease: "lease_fixture",
    sid: value.sid,
    epoch: value.epoch,
    outcome,
    time: Date.now(),
  };
}

function fakeClock() {
  let time = 1000;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule(callback, delay) {
      const timer = { id: ++sequence, due: time + delay, callback, unref() {} };
      timers.set(timer.id, timer);
      return timer;
    },
    cancel(timer) {
      timers.delete(timer.id);
    },
    async advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers.values()]
          .filter((timer) => timer.due <= end)
          .sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        time = next.due;
        timers.delete(next.id);
        next.callback();
        for (let index = 0; index < 8; index++) await Promise.resolve();
        await new Promise((resolve) => setImmediate(resolve));
      }
      time = end;
    },
    size: () => timers.size,
  };
}

test("recipient tools forward only pinned operations and return only the claimed envelope", async () => {
  const time = Date.now();
  const calls = [];
  const recipient = createRecipientSession({
    relayRoot: "/private/relay",
    bindings: [binding],
    now: () => time,
    bridge: (request) => {
      calls.push(request);
      if (request.op === "renew") return session(time);
      if (request.op === "pending") return summary();
      if (request.op === "claim") return lease(time);
      if (request.op === "reply") return { id: "reply_receipt", repeat: false, init: time };
      if (request.op === "ack") return receipt(binding, "done");
      throw new Error(`Unexpected ${request.op}`);
    },
  });
  await recipient.start();
  assert.deepEqual(await recipient.invoke("pending", {}), [
    { pending: { msg: 1, work: 0 }, recoverable: { msg: 0, work: 0 }, revision: "a".repeat(64) },
  ]);
  const claimed = await recipient.invoke("claim", { kind: "msg" });
  assert.deepEqual(claimed, {
    lease: "lease_fixture",
    kind: "msg",
    message: { msg: "addressed body" },
  });
  assert.deepEqual(Object.keys(claimed), ["lease", "kind", "message"]);
  assert.deepEqual(await recipient.invoke("reply", { lease: "lease_fixture", msg: "reply body" }), {
    sent: true,
  });
  await recipient.invoke("ack", { lease: "lease_fixture", outcome: "done" });
  assert.equal(
    calls.some(
      ({ args }) => "sid" in args || "authority" in args || "worker" in args || "to" in args,
    ),
    false,
  );
  const reply = calls.find((call) => call.op === "reply");
  assert.deepEqual(Object.keys(reply.args).sort(), ["key", "lease", "msg"]);
  assert.match(reply.args.key, /^relay-reply-[a-f0-9]{64}$/);
  await recipient.activationEnded();
  assert.equal(calls.filter((call) => call.op === "ack").length, 1);
  await recipient.close();
  assert.equal(recipient.state.activeLeases, 0);
});

test("recipient lifetime maintenance touches a live lease independently and serializes settlement", async () => {
  const clock = fakeClock();
  const calls = [];
  let beginTouch;
  let finishTouch;
  const touching = new Promise((resolve) => {
    beginTouch = resolve;
  });
  const touchResult = new Promise((resolve) => {
    finishTouch = resolve;
  });
  const recipient = createRecipientSession({
    relayRoot: "/private/relay",
    bindings: [binding],
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    bridge: (request) => {
      calls.push(request.op);
      if (request.op === "renew") return session(clock.now());
      if (request.op === "claim") return lease(clock.now(), binding, { until: clock.now() + 90 });
      if (request.op === "touch") {
        beginTouch();
        return touchResult;
      }
      if (request.op === "ack") return receipt(binding, "done");
      throw new Error(`Unexpected ${request.op}`);
    },
  });
  await recipient.start();
  await recipient.invoke("claim", { kind: "msg" });
  const turn = new Promise(() => {}); // Simulates inference that remains pending while the runtime owns the lease.
  await clock.advance(30);
  await touching;
  assert.equal(calls.includes("touch"), true);
  let settled = false;
  const ack = recipient.invoke("ack", { lease: "lease_fixture", outcome: "done" }).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(calls.includes("ack"), false);
  finishTouch(lease(clock.now(), binding, { until: clock.now() + 90 }));
  await ack;
  assert.equal(settled, true);
  assert.equal(calls.indexOf("touch") < calls.indexOf("ack"), true);
  void turn;
  await recipient.close();
  assert.equal(clock.size(), 0);
});

test("an uncertain claim blocks all further local claims", async () => {
  let claims = 0;
  const recipient = createRecipientSession({
    relayRoot: "/private/relay",
    bindings: [binding],
    bridge: ({ op }) => {
      if (op === "renew") return session(Date.now());
      if (op === "claim") {
        claims++;
        throw new Error("connection lost after acceptance");
      }
      throw new Error(`Unexpected ${op}`);
    },
  });
  await recipient.start();
  await assert.rejects(recipient.invoke("claim", { kind: "work" }), /local processing is stopped/);
  await assert.rejects(recipient.invoke("claim", { kind: "work" }), /ownership is unavailable/);
  assert.equal(claims, 1);
  assert.equal(recipient.state.uncertain, true);
  await recipient.close();
});

test("malformed accepted claims and ownership receipts fail closed", async (t) => {
  await t.test("malformed claim", async () => {
    let claims = 0;
    const recipient = createRecipientSession({
      relayRoot: "/private/relay",
      bindings: [binding],
      bridge: ({ op }) => {
        if (op === "renew") return session(Date.now());
        if (op === "claim") {
          claims++;
          return { id: "lease_fixture", sid: "other_session" };
        }
        throw new Error(`Unexpected ${op}`);
      },
    });
    await recipient.start();
    await assert.rejects(recipient.invoke("claim", { kind: "msg" }), /invalid addressed lease/);
    await assert.rejects(recipient.invoke("claim", { kind: "msg" }), /ownership is unavailable/);
    assert.equal(claims, 1);
    assert.equal(recipient.state.uncertain, true);
    await recipient.close();
  });

  await t.test(
    "active lease touch precedes renewal and invalid renewal stops processing",
    async () => {
      const clock = fakeClock();
      const calls = [];
      let renewals = 0;
      const renewal = () => {
        renewals += 1;
        const value = session(clock.now());
        if (renewals === 1) return { ...value, until: clock.now() + 90 };
        return { ...value, worker: "other:opencode:prime" };
      };
      const recipient = createRecipientSession({
        relayRoot: "/private/relay",
        bindings: [binding],
        now: clock.now,
        schedule: clock.schedule,
        cancel: clock.cancel,
        bridge: ({ op }) => {
          calls.push(op);
          if (op === "renew") return renewal();
          if (op === "claim") return lease(clock.now(), binding, { until: clock.now() + 90 });
          if (op === "touch") return lease(clock.now(), binding, { until: clock.now() + 90 });
          throw new Error(`Unexpected ${op}`);
        },
      });
      await recipient.start();
      await recipient.invoke("claim", { kind: "msg" });
      await clock.advance(30);
      assert.deepEqual(calls.slice(-2), ["touch", "renew"]);
      assert.equal(recipient.state.lost, true);
      assert.equal(recipient.state.activeLeases, 1);
      await recipient.close();
    },
  );

  await t.test("invalid lease touch retains uncertainty", async () => {
    const clock = fakeClock();
    const recipient = createRecipientSession({
      relayRoot: "/private/relay",
      bindings: [binding],
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      bridge: ({ op }) => {
        if (op === "renew") return session(clock.now());
        if (op === "claim") return lease(clock.now(), binding, { until: clock.now() + 90 });
        if (op === "touch") return lease(clock.now(), binding, { mid: "different_message" });
        throw new Error(`Unexpected ${op}`);
      },
    });
    await recipient.start();
    await recipient.invoke("claim", { kind: "msg" });
    await clock.advance(30);
    assert.equal(recipient.state.lost, true);
    assert.equal(recipient.state.uncertain, true);
    await assert.rejects(
      recipient.invoke("ack", { lease: "lease_fixture", outcome: "done" }),
      /ownership is unavailable/,
    );
    await recipient.close();
  });

  await t.test("invalid settlement receipt retains uncertainty", async () => {
    const recipient = createRecipientSession({
      relayRoot: "/private/relay",
      bindings: [binding],
      bridge: ({ op }) => {
        if (op === "renew") return session(Date.now());
        if (op === "claim") return lease(Date.now());
        if (op === "ack") return { ...receipt(binding), mid: "different_message" };
        throw new Error(`Unexpected ${op}`);
      },
    });
    await recipient.start();
    await recipient.invoke("claim", { kind: "msg" });
    await assert.rejects(
      recipient.invoke("ack", { lease: "lease_fixture", outcome: "done" }),
      /settlement result is invalid/,
    );
    assert.equal(recipient.state.uncertain, true);
    await assert.rejects(recipient.invoke("claim", { kind: "msg" }), /ownership is unavailable/);
    await recipient.close();
  });
});

test("closing releases accepted claims and never infers acknowledgement from turn completion", async () => {
  const calls = [];
  const recipient = createRecipientSession({
    relayRoot: "/private/relay",
    bindings: [binding],
    bridge: (request) => {
      calls.push(request.op);
      if (request.op === "renew") return session(Date.now());
      if (request.op === "claim") return lease(Date.now());
      if (request.op === "release") return receipt(binding, "released");
      throw new Error(`Unexpected ${request.op}`);
    },
  });
  await recipient.start();
  await recipient.invoke("claim", { kind: "msg" });
  await recipient.activationEnded();
  assert.equal(calls.includes("ack"), false);
  await recipient.close();
  assert.equal(calls.includes("release"), true);
  assert.equal(calls.includes("ack"), false);
});

test("closing cancels a hung recipient call and clears its deadline timer", async () => {
  const clock = fakeClock();
  let claimStarted;
  const started = new Promise((resolve) => {
    claimStarted = resolve;
  });
  const recipient = createRecipientSession({
    relayRoot: "/private/relay",
    bindings: [binding],
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    bridge: ({ op }) => {
      if (op === "renew") return session(clock.now());
      if (op === "pending") return summary();
      if (op === "claim") {
        claimStarted();
        return new Promise(() => {});
      }
      throw new Error(`Unexpected ${op}`);
    },
  });
  await recipient.start();
  const claim = recipient.invoke("claim", { kind: "msg" });
  await started;
  const closing = recipient.close();
  await closing;
  await assert.rejects(claim, /local processing is stopped/);
  assert.equal(recipient.state.lost, true);
  assert.equal(recipient.state.uncertain, true);
  assert.equal(clock.size(), 0);
});

test("a late accepted claim after shutdown remains unresolved and is never released locally", async () => {
  const clock = fakeClock();
  let finishClaim;
  let claimStarted;
  const started = new Promise((resolve) => {
    claimStarted = resolve;
  });
  const lateClaim = new Promise((resolve) => {
    finishClaim = resolve;
  });
  let releases = 0;
  const recipient = createRecipientSession({
    relayRoot: "/private/relay",
    bindings: [binding],
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    bridge: ({ op }) => {
      if (op === "renew") return session(clock.now());
      if (op === "pending") return summary();
      if (op === "claim") {
        claimStarted();
        return lateClaim;
      }
      if (op === "release") {
        releases++;
        return receipt(binding, "released");
      }
      throw new Error(`Unexpected ${op}`);
    },
  });
  await recipient.start();
  const claim = recipient.invoke("claim", { kind: "msg" });
  await started;
  await recipient.close();
  await assert.rejects(claim, /local processing is stopped/);
  finishClaim(lease(clock.now()));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recipient.state.uncertain, true);
  assert.equal(recipient.state.activeLeases, 0);
  assert.equal(releases, 0);
  assert.equal(clock.size(), 0);
});

test("an unresponsive claim reaches its deadline without requiring shutdown", async () => {
  const clock = fakeClock();
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const recipient = createRecipientSession({
    relayRoot: "/private/relay",
    bindings: [binding],
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    bridge: ({ op }) => {
      if (op === "renew") return session(clock.now());
      if (op === "claim") {
        entered();
        return new Promise(() => {});
      }
      throw new Error(`Unexpected ${op}`);
    },
  });
  await recipient.start();
  const rejected = assert.rejects(
    recipient.invoke("claim", { kind: "msg" }),
    /local processing is stopped/,
  );
  await started;
  await clock.advance(LIMITS.deliveryDeadlineMs);
  await rejected;
  assert.equal(recipient.state.uncertain, true);
  assert.equal(clock.size(), 0);
  await recipient.close();
});

test("cleanup release has a deadline and retains an uncertain outcome", async () => {
  const clock = fakeClock();
  let entered;
  const releasing = new Promise((resolve) => {
    entered = resolve;
  });
  const recipient = createRecipientSession({
    relayRoot: "/private/relay",
    bindings: [binding],
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    bridge: ({ op }) => {
      if (op === "renew") return session(clock.now());
      if (op === "claim") return lease(clock.now());
      if (op === "release") {
        entered();
        return new Promise(() => {});
      }
      throw new Error(`Unexpected ${op}`);
    },
  });
  await recipient.start();
  await recipient.invoke("claim", { kind: "msg" });
  const closing = recipient.close();
  await releasing;
  await clock.advance(LIMITS.deliveryDeadlineMs);
  await closing;
  assert.equal(recipient.state.lost, true);
  assert.equal(recipient.state.uncertain, true);
  assert.equal(clock.size(), 0);
});

test("closing before dispatch prevents even an abort-ignoring bridge from being called", async () => {
  const clock = fakeClock();
  let calls = 0;
  const recipient = createRecipientSession({
    relayRoot: "/private/relay",
    bindings: [binding],
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    bridge: () => {
      calls++;
      return session(clock.now());
    },
  });
  const rejected = assert.rejects(recipient.start(), /local processing is stopped/);
  await recipient.close();
  await rejected;
  assert.equal(calls, 0);
  assert.equal(clock.size(), 0);
});

test("work claims cannot send message replies", async () => {
  const calls = [];
  const recipient = createRecipientSession({
    relayRoot: "/private/relay",
    bindings: [binding],
    bridge: ({ op }) => {
      calls.push(op);
      if (op === "renew") return session(Date.now());
      if (op === "claim") {
        const value = lease(Date.now(), binding, { kind: "work", work: "do task" });
        delete value.msg;
        return value;
      }
      if (op === "release") return receipt(binding, "released");
      throw new Error(`Unexpected ${op}`);
    },
  });
  await recipient.start();
  const claimed = await recipient.invoke("claim", { kind: "work" });
  assert.deepEqual(claimed.message, { work: "do task" });
  await assert.rejects(
    recipient.invoke("reply", { lease: claimed.lease, msg: "not a work reply" }),
    /addressed message claim/,
  );
  assert.equal(calls.includes("reply"), false);
  await recipient.close();
});

test("work claims preserve every valid JSON value, including large nested payloads", async (t) => {
  const values = [
    { task: "x".repeat(60000), nested: [1, true, null] },
    ["array", 3, false, null],
    null,
    42,
    true,
  ];
  for (const work of values)
    await t.test(Array.isArray(work) ? "array" : work === null ? "null" : typeof work, async () => {
      const recipient = createRecipientSession({
        relayRoot: "/private/relay",
        bindings: [binding],
        bridge: ({ op }) => {
          if (op === "renew") return session(Date.now());
          if (op === "claim")
            return {
              id: "lease_fixture",
              mid: "message_fixture",
              sid: binding.sid,
              epoch: binding.epoch,
              until: Date.now() + 60000,
              attempt: 1,
              kind: "work",
              work,
            };
          if (op === "release") return receipt(binding, "released");
          throw new Error(`Unexpected ${op}`);
        },
      });
      await recipient.start();
      const claimed = await recipient.invoke("claim", { kind: "work" });
      assert.equal(claimed.message.work, work);
      assert.equal(claimed.message.work === work, true);
      await recipient.close();
    });
});
