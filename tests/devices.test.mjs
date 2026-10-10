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

test("CORE registration allocates locally and resolves an enrolled remote namespace exactly", (t) => {
  const host = open({ root: temporaryRoot(t), device: "east" }); t.after(() => host.close());
  const hub = open({ root: temporaryRoot(t), device: "hub-b", role: "hub" }); t.after(() => hub.close());
  const hostAgent = host.register("worker", { slot: "007" });
  const device = host.device;
  const authorization = (operation, id, grant) => ({ operation, scopeKey: id, principal: { id, grant: {
    enroll: [], register: [], workers: [], recipients: [], boardPost: [], boardClaim: [], inboxRead: [], workRead: [],
    inspect: { messages: false, receipts: false, audit: false, topology: false }, reportDevice: null, ...grant,
  } } });
  const run = (auth, rid, op, args) => dispatchRpc(hub, { authorization: auth, rid, op, args, beforeCommit() {} });
  const enrollmentGrant = authorization("enroll", "enroller", { enroll: [{ deviceId: device.id, deviceName: device.name }] });
  run(enrollmentGrant, "enroll-east", "enroll", { device });
  const remoteGrant = authorization("register", "remote", { register: [{ deviceId: device.id, deviceName: device.name, runtimes: ["worker"], allocate: false }] });
  const remoteAgent = run(remoteGrant, "register-east-007", "register", { runtime: "worker", options: { slot: "007" } }).result;
  assert.equal(remoteAgent.id, hostAgent.id);
  assert.equal(remoteAgent.device, device.id);
  assert.equal(run(remoteGrant, "register-east-007-repeat", "register", { runtime: "worker", options: { slot: "007" } }).result.id, hostAgent.id);

  const localGrant = authorization("register", "local", { register: [{ deviceId: hub.device.id, deviceName: hub.device.name, runtimes: ["worker"], allocate: true }] });
  const localAgent = run(localGrant, "register-hub-auto", "register", { runtime: "worker" }).result;
  assert.equal(localAgent.id, "hub-b:worker:001");
  assert.equal(hub.register("worker").id, "hub-b:worker:002");
  assert.equal(host.join(hostAgent.id).worker, remoteAgent.id);
  const remoteSession = run(authorization("join", "remote", { workers: [remoteAgent.id] }), "join-east", "join", { worker: remoteAgent.id }).result;
  assert.equal(remoteSession.worker, hostAgent.id);
  assert.notEqual(remoteSession.id, host.join(hostAgent.id, { replace: true }).id);

  const denied = (id, bound, options) => assert.throws(() => run(authorization("register", id, { register: [bound] }), `deny-${id}`, "register", { runtime: "worker", ...(options === undefined ? {} : { options }) }), { code: "denied" });
  denied("remote-allocate", { deviceId: device.id, deviceName: device.name, runtimes: ["worker"], allocate: true });
  denied("remote-no-slot", { deviceId: device.id, deviceName: device.name, runtimes: ["worker"], allocate: false });
  denied("remote-prime", { deviceId: device.id, deviceName: device.name, runtimes: ["worker"], allocate: false }, { slot: "prime" });
  denied("remote-unenrolled", { deviceId: "absent", deviceName: "absent", runtimes: ["worker"], allocate: false }, { slot: "001" });
  denied("remote-name-mismatch", { deviceId: device.id, deviceName: "other", runtimes: ["worker"], allocate: false }, { slot: "001" });
  assert.throws(() => run(remoteGrant, "remote-runtime", "register", { runtime: "controller", options: { slot: "008" } }), { code: "denied" });
  assert.throws(() => run(remoteGrant, "remote-caps", "register", { runtime: "worker", options: { slot: "007", caps: ["different"] } }), { code: "device_conflict" });
});

test("CORE report scope follows the current session device and host boards stay host-local", (t) => {
  const hub = open({ root: temporaryRoot(t), device: "hub-c", role: "hub" }); t.after(() => hub.close());
  const device = { id: "host-id", name: "host", init: Date.now() };
  const base = { enroll: [], register: [{ deviceId: device.id, deviceName: device.name, runtimes: ["worker"], allocate: false }], workers: [], recipients: [], boardPost: ["host:host-id"], boardClaim: ["host:host-id"], inboxRead: [], workRead: [], inspect: { messages: false, receipts: false, audit: false, topology: false }, reportDevice: device.id };
  const auth = (operation, id, grant = base) => ({ operation, scopeKey: id, principal: { id, grant } });
  dispatchRpc(hub, { authorization: auth("enroll", "enroll", { ...base, enroll: [{ deviceId: device.id, deviceName: device.name }], register: [] }), rid: "enroll-report", op: "enroll", args: { device }, beforeCommit() {} });
  const worker = "host:worker:001";
  dispatchRpc(hub, { authorization: auth("register", "registrar"), rid: "register-report", op: "register", args: { runtime: "worker", options: { slot: "001" } }, beforeCommit() {} });
  const joinGrant = { ...base, workers: [worker] };
  const session = dispatchRpc(hub, { authorization: auth("join", "reporter", joinGrant), rid: "join-report", op: "join", args: { worker }, beforeCommit() {} }).result;
  const report = { seq: 1, agents: [{ worker, state: "ready", free: 1, assignmentCount: 0 }], board: { id: "host:host-id", inbox: 0, pending: 0, claimed: 0, terminal: 0 } };
  const accepted = dispatchRpc(hub, { authorization: auth("report", "reporter", joinGrant), rid: "report-east", op: "report", args: { sid: session.id, report }, beforeCommit() {} });
  assert.equal(accepted.result.accepted, true);
  assert.throws(() => dispatchRpc(hub, { authorization: auth("report", "wrong-device", { ...joinGrant, reportDevice: hub.device.id }), rid: "report-wrong", op: "report", args: { sid: session.id, report: { ...report, seq: 2 } }, beforeCommit() {} }), { code: "denied" });

  hub._store.db.prepare("INSERT INTO boards(id,kind,device,init) VALUES(?,?,?,?)").run("host:host-id", "host", device.id, Date.now());
  const postAuth = auth("post", "reporter", joinGrant);
  assert.throws(() => dispatchRpc(hub, { authorization: postAuth, rid: "post-foreign-host", op: "post", args: { sid: session.id, board: "host:host-id", envelope: { work: { task: "must stay on host" } } }, beforeCommit() {} }), { code: "denied" });
  assert.throws(() => dispatchRpc(hub, { authorization: auth("claim", "reporter", joinGrant), rid: "claim-foreign-host", op: "claim", args: { sid: session.id, options: { board: "host:host-id" } }, beforeCommit() {} }), { code: "denied" });
  assert.equal(hub.stats().messages.rows, 0);
});
