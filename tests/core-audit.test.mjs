import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindDeliverySession,
  claimDeliveryOwner,
  dispatchRpc,
  listDeliveryAttempts,
  open,
  openForBroker,
  reserveDeliveryAttempt,
  transitionDeliveryAttempt,
} from "../src/relay.mjs";
import { Fault } from "../src/fault.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

function claimAuthorization(worker, principal = "claim-test") {
  return {
    operation: "claim",
    scopeKey: "claim-scope",
    principal: { id: principal, grant: { workers: [worker] } },
  };
}

function callClaim(relay, authorization, rid, sid, beforeCommit = () => {}) {
  return dispatchRpc(relay, {
    authorization,
    rid,
    op: "claim",
    args: { sid, options: {} },
    beforeCommit,
  });
}

test("retained claim replays bypass full-journal admission but keep live authorization and lease checks", (t) => {
  const empty = open({ root: temporaryRoot(t), device: "empty-replay" });
  const leased = open({ root: temporaryRoot(t), device: "lease-replay" });
  t.after(() => {
    empty.close();
    leased.close();
  });
  empty._store.policy.rpcRows = 1;
  leased._store.policy.rpcRows = 1;

  const emptyWorker = empty.register("worker");
  const emptySession = empty.join(emptyWorker.id);
  const emptyAuth = claimAuthorization(emptyWorker.id);
  empty._store.db
    .prepare("UPDATE sessions SET principal=? WHERE id=?")
    .run(emptyAuth.principal.id, emptySession.id);
  const firstEmpty = callClaim(empty, emptyAuth, "empty-claim", emptySession.id);
  assert.equal(firstEmpty.result, null);
  assert.deepEqual(callClaim(empty, emptyAuth, "empty-claim", emptySession.id), {
    ...firstEmpty,
    replayed: true,
  });
  assert.throws(() => callClaim(empty, emptyAuth, "new-empty-claim", emptySession.id), {
    code: "full",
  });
  assert.throws(
    () =>
      callClaim(empty, emptyAuth, "empty-claim", emptySession.id, () => {
        throw new Fault("auth", "revoked");
      }),
    { code: "auth" },
  );
  empty.join(emptyWorker.id, { replace: true });
  assert.throws(() => callClaim(empty, emptyAuth, "empty-claim", emptySession.id), {
    code: "session",
  });

  const worker = leased.register("worker");
  const session = leased.join(worker.id);
  const authorization = claimAuthorization(worker.id, "leased-claim-test");
  leased._store.db
    .prepare("UPDATE sessions SET principal=? WHERE id=?")
    .run(authorization.principal.id, session.id);
  const admission = leased.send(session.id, worker.id, { work: { task: "claim replay" } });
  const first = callClaim(leased, authorization, "live-claim", session.id);
  assert.equal(first.result.mid, admission.id);
  const replay = callClaim(leased, authorization, "live-claim", session.id);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.throws(() => callClaim(leased, authorization, "new-live-claim", session.id), {
    code: "full",
  });
  const wall = Date.now;
  try {
    Date.now = () => first.result.until;
    assert.throws(() => callClaim(leased, authorization, "live-claim", session.id), {
      code: "expired",
    });
  } finally {
    Date.now = wall;
  }
});

test("message sequence high-water survives highest and full purge, reopen, and old cursors", (t) => {
  const root = temporaryRoot(t);
  let relay = open({ root, device: "sequence" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const board = `host:${relay.device.id}`;
  const first = relay.post(session.id, board, { msg: "one" });
  const firstSeq = relay.get(first.id).seq;
  relay.post(session.id, board, { msg: "two" });
  const highest = relay.post(session.id, board, { msg: "three" });
  const highestSeq = relay.get(highest.id).seq;
  const firstPage = relay.list({ board, kind: "msg", limit: 1 });
  assert.equal(firstPage.items[0].id, first.id);
  assert.ok(firstPage.next);

  const db = relay._store.db;
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
  db.prepare("DELETE FROM meta WHERE key='messageSeq'").run(); // Existing v2/v3 stores predate this additive metadata.
  db.prepare("UPDATE messages SET init=0 WHERE id=?").run(highest.id);
  assert.equal(relay.purge({ before: Date.now(), dry: true }).eligible, 1);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='messageSeq'").get(), undefined);
  assert.equal(relay.purge({ before: Date.now() }).removed, 1);
  assert.equal(
    JSON.parse(db.prepare("SELECT value FROM meta WHERE key='messageSeq'").get().value),
    highestSeq,
  );

  const afterHighestPurge = relay.post(session.id, board, { msg: "four" });
  const afterHighestSeq = relay.get(afterHighestPurge.id).seq;
  assert.equal(afterHighestSeq, highestSeq + 1);
  assert.deepEqual(
    relay
      .list({ board, kind: "msg", limit: 1, after: firstPage.next })
      .items.map((item) => item.seq),
    [firstSeq + 1],
  );

  db.prepare("UPDATE messages SET init=0,acked=0").run();
  assert.equal(relay.purge({ before: Date.now() }).removed, 3);
  assert.equal(
    JSON.parse(db.prepare("SELECT value FROM meta WHERE key='messageSeq'").get().value),
    afterHighestSeq,
  );
  relay.close();

  relay = open({ root, device: "sequence" });
  const afterReopen = relay.post(session.id, board, { msg: "five" });
  assert.equal(relay.get(afterReopen.id).seq, afterHighestSeq + 1);
  const oldCursorPage = relay.list({ board, kind: "msg", limit: 1, after: firstPage.next });
  assert.deepEqual(oldCursorPage.items, []);
  assert.equal(oldCursorPage.total, 0);

  relay._store.db.prepare("DELETE FROM meta WHERE key='messageSeq'").run();
  relay.close();
  const readOnly = open({ root, readOnly: true });
  t.after(() => readOnly.close());
  readOnly.list({ board, kind: "msg" });
  assert.equal(
    readOnly._store.db.prepare("SELECT value FROM meta WHERE key='messageSeq'").get(),
    undefined,
  );
});

test("list pages count only authorized metadata and keep cursor and first-sequence scope", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "list-page" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const board = `host:${relay.device.id}`;
  const first = relay.post(session.id, board, { msg: "visible inbox" });
  const firstSeq = relay.get(first.id).seq;
  relay.post(session.id, board, { work: { hidden: true } });
  const second = relay.post(session.id, board, { msg: "visible inbox two" });
  const authorization = {
    scopeKey: "inbox-only",
    principal: {
      id: "inbox-reader",
      grant: {
        workers: [],
        inboxRead: [board],
        workRead: [],
        inspect: { messages: false },
      },
    },
  };
  const options = { board, limit: 1, data: true };
  const page = relay.list(options, authorization);
  assert.equal(page.total, 2);
  assert.equal(page.firstSeq, firstSeq);
  assert.equal(page.items[0].id, first.id);
  assert.deepEqual(page.items[0].data, { msg: "visible inbox" });
  assert.ok(page.next);

  relay.post(session.id, board, { msg: "outside captured boundary" });
  const next = relay.list({ ...options, after: page.next }, authorization);
  assert.equal(next.total, 2);
  assert.equal(next.firstSeq, firstSeq);
  assert.equal(next.items[0].id, second.id);
  assert.equal(next.complete, true);
  assert.throws(
    () =>
      relay.list(
        { ...options, after: page.cursor },
        { ...authorization, scopeKey: "changed-grant" },
      ),
    { code: "cursor" },
  );
});

test("message inspector grant exposes addressed messages but still needs board-specific reads", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "message-inspector", role: "hub" });
  t.after(() => relay.close());
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const addressed = relay.send(session.id, worker.id, { msg: "addressed" });
  relay.post(session.id, "bounty", { msg: "bounty inbox" });
  relay.post(session.id, "bounty", { work: { task: "bounty work" } });
  const inspectOnly = {
    scopeKey: "inspect-only",
    principal: {
      id: "inspector",
      grant: {
        workers: [],
        inboxRead: [],
        workRead: [],
        inspect: { messages: true },
      },
    },
  };
  const page = relay.list({ data: true }, inspectOnly);
  assert.equal(page.total, 1);
  assert.deepEqual(
    page.items.map(({ id }) => id),
    [addressed.id],
  );
  assert.equal(page.firstSeq, null);
  for (const kind of ["msg", "work"]) {
    const bounty = relay.list({ board: "bounty", kind, data: true }, inspectOnly);
    assert.equal(bounty.total, 0);
    assert.deepEqual(bounty.items, []);
    assert.equal(bounty.firstSeq, null);
  }
  const inboxOnly = {
    ...inspectOnly,
    scopeKey: "inbox-only",
    principal: {
      id: "inspector",
      grant: {
        workers: [],
        inboxRead: ["bounty"],
        workRead: [],
        inspect: { messages: false },
      },
    },
  };
  assert.equal(relay.list({ board: "bounty", kind: "msg" }, inboxOnly).total, 1);
  assert.equal(relay.list({ board: "bounty", kind: "work" }, inboxOnly).total, 0);
});

test("delivery reservation maintenance prunes obsolete terminal history and retains active dedupe and unresolved gates", (t) => {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "relay-core-audit-home-"));
  process.env.HOME = home;
  const root = temporaryRoot(t);
  let relay;
  t.after(() => {
    try {
      relay?.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  const initialized = open({ root, device: "delivery-audit" });
  initialized.close();
  relay = openForBroker({ root, role: "host", ownerToken: "A".repeat(32) });
  const worker = relay.register("worker");
  const session = relay.join(worker.id);
  const ownerGeneration = claimDeliveryOwner(relay).generation;
  const capabilities = { context: true, idle: false, launch: false };
  const bind = (target) =>
    bindDeliverySession(relay, {
      authority: relay.authority,
      worker: worker.id,
      sid: session.id,
      epoch: session.epoch,
      target,
      capabilities,
      ownerGeneration,
    });
  const targetA = {
    runtimeInstance: "runtime-a",
    profile: "default",
    nativeSession: "session-a",
    lifecycleGeneration: "life-1",
  };
  const bindingA = bind(targetA);
  const bindingB = bind({
    runtimeInstance: "runtime-b",
    profile: "default",
    nativeSession: "session-b",
    lifecycleGeneration: "life-1",
  });
  const bindingC = bind({
    runtimeInstance: "runtime-c",
    profile: "default",
    nativeSession: "session-c",
    lifecycleGeneration: "life-1",
  });
  const summary = relay.pending(session.id);
  const reserve = (id, binding) =>
    reserveDeliveryAttempt(relay, {
      id,
      ownerGeneration,
      bindings: [
        {
          binding: binding.id,
          generation: binding.generation,
          summary,
        },
      ],
    });
  const transition = (attempt, binding, from, to, fields = {}) =>
    transitionDeliveryAttempt(relay, {
      id: attempt.id,
      ownerGeneration,
      bindings: [{ binding: binding.id, generation: binding.generation }],
      from,
      to,
      ...fields,
    });

  const terminal = reserve("terminal-old", bindingA);
  transition(terminal, bindingA, "reserved", "submitting");
  transition(terminal, bindingA, "submitting", "refused", { reasonCode: "native-refused" });
  relay._store.db.prepare("UPDATE delivery_attempts SET changed=0 WHERE id=?").run(terminal.id);

  const unresolvedB = reserve("unresolved-b", bindingB);
  assert.ok(
    listDeliveryAttempts(relay, ownerGeneration).some((attempt) => attempt.id === terminal.id),
  );
  assert.equal(
    listDeliveryAttempts(relay, ownerGeneration).find((attempt) => attempt.id === terminal.id)
      .scopes[0].binding,
    bindingA.id,
  );
  relay._store.db.prepare("UPDATE delivery_attempts SET changed=0 WHERE id=?").run(unresolvedB.id);

  const rotatedA = bind({
    ...targetA,
    runtimeInstance: "runtime-a2",
    lifecycleGeneration: "life-2",
  });
  assert.equal(rotatedA.generation, bindingA.generation + 1);
  assert.ok(
    listDeliveryAttempts(relay, ownerGeneration).some((attempt) => attempt.id === terminal.id),
  );

  const unresolvedC = reserve("unresolved-c", bindingC);
  const retained = listDeliveryAttempts(relay, ownerGeneration);
  assert.equal(
    retained.some((attempt) => attempt.id === terminal.id),
    false,
  );
  assert.ok(
    retained.some((attempt) => attempt.id === unresolvedB.id && attempt.state === "reserved"),
  );
  assert.ok(
    retained.some((attempt) => attempt.id === unresolvedC.id && attempt.state === "reserved"),
  );

  transition(unresolvedB, bindingB, "reserved", "refused", { reasonCode: "cancelled" });
  transition(unresolvedC, bindingC, "reserved", "refused", { reasonCode: "cancelled" });
  relay._store.db.prepare("UPDATE delivery_attempts SET changed=0 WHERE id=?").run(unresolvedC.id);
  const retryC = reserve("retry-c", bindingC);
  const afterRetry = listDeliveryAttempts(relay, ownerGeneration);
  assert.equal(
    afterRetry.some((attempt) => attempt.id === unresolvedC.id),
    false,
  );
  assert.ok(afterRetry.some((attempt) => attempt.id === retryC.id && attempt.state === "reserved"));
  transition(retryC, bindingC, "reserved", "refused", { reasonCode: "cancelled" });
});
