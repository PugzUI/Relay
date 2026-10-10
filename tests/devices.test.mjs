import test from "node:test";
import assert from "node:assert/strict";
import { dispatchRpc, open } from "../src/relay.mjs";
import { temporaryRoot } from "./core-helpers.mjs";

test("A31/A33 registered names persist and numbered slots increase", (t) => {
  const root = temporaryRoot(t); const relay = open({ root, device: "node-a" }); t.after(() => relay.close());
  const first = relay.register("worker"); const second = relay.register("worker");
  assert.equal(first.id, "node-a:worker:001"); assert.equal(second.id, "node-a:worker:002");
  const reopened = open({ root }); t.after(() => reopened.close());
  assert.equal(reopened.device.id, relay.device.id);
  assert.throws(() => open({ root, device: "renamed" }), { code: "device_conflict" });
});

test("A32 names and explicit slots are strict", (t) => {
  const relay = open({ root: temporaryRoot(t), device: "node-b" }); t.after(() => relay.close());
  assert.throws(() => relay.register("bad:runtime"), { code: "input" });
  assert.throws(() => relay.register("worker", { slot: "1" }), { code: "input" });
  assert.throws(() => relay.register("worker", { slot: "001", caps: ["x", "x"] }), { code: "input" });
});

test("A54 enrollment is exact and its grant does not authorize worker sessions", (t) => {
  const root = temporaryRoot(t); const hub = open({ root, device: "hub-a", role: "hub" }); t.after(() => hub.close());
  const authorization = { operation: "enroll", scopeKey: "enroll-scope", principal: { id: "enroller", grant: {
    enroll: [{ deviceId: "remote-id", deviceName: "remote" }], register: [], workers: [], recipients: [], boardPost: [], boardClaim: [],
    inboxRead: [], workRead: [], inspect: { messages: false, receipts: false, audit: false, topology: false }, reportDevice: null,
  } } };
  const device = { id: "remote-id", name: "remote", init: Date.now() };
  const first = dispatchRpc(hub, { authorization, rid: "enroll-1", op: "enroll", args: { device }, beforeCommit() {} });
  const repeat = dispatchRpc(hub, { authorization, rid: "enroll-1", op: "enroll", args: { device }, beforeCommit() {} });
  assert.equal(first.result.repeat, false); assert.equal(repeat.replayed, true);
  assert.throws(() => hub.enroll({ ...device, name: "other" }, authorization), { code: "denied" });
  const worker = "hub-a:worker:001";
  const joinAuth = { ...authorization, operation: "join" };
  assert.throws(() => dispatchRpc(hub, { authorization: joinAuth, rid: "join-1", op: "join", args: { worker }, beforeCommit() {} }), { code: "denied" });
});
