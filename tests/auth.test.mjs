import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { authorize, authorizeBoardRead, authenticate, loadRegistry } from "../src/auth.mjs";
import { Fault } from "../src/fault.mjs";
import { credential, emptyGrant, privateFile, withTempDir } from "./network-helpers.mjs";

test("registry rejects duplicate JSON keys before constructing a snapshot", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "credentials.json");
    await privateFile(path, '{"version":1,"version":1,"credentials":[]}');
    await assert.rejects(
      loadRegistry(path),
      (error) => error instanceof Fault && error.code === "input",
    );
  });
});

test("authentication uses the current complete grant and rejects duplicate Authorization", async () => {
  await withTempDir(async (root) => {
    const grant = emptyGrant();
    grant.workers = ["east:worker:001"];
    grant.register = [
      { deviceId: "east", deviceName: "east", runtimes: ["worker"], allocate: true },
    ];
    grant.recipients = ["hub:worker:prime"];
    grant.boardClaim = ["bounty"];
    const auth = credential({ grant });
    const path = join(root, "credentials.json");
    await privateFile(path, JSON.stringify({ version: 1, credentials: [auth.entry] }));
    const snapshot = await loadRegistry(path);
    const principal = authenticate(snapshot, `Bearer ${auth.token}`);
    assert.equal(principal.id, "worker");
    assert.equal(
      authorize(snapshot, principal, "send", {
        sid: "session",
        to: "hub:worker:prime",
        envelope: { msg: "hello" },
      }).scopeKey,
      principal.scopeKey,
    );
    assert.equal(
      authorize(snapshot, principal, "register", { runtime: "worker" }).operation,
      "register",
    );
    assert.throws(
      () => authenticate(snapshot, [`Bearer ${auth.token}`, `Bearer ${auth.token}`]),
      (error) => error.code === "auth",
    );
    assert.throws(
      () =>
        authorize(snapshot, principal, "send", {
          sid: "session",
          to: "other:worker:001",
          envelope: { msg: "hello" },
        }),
      (error) => error.code === "denied",
    );
  });
});

test("DEV_RELAY authenticates only the development topology grant", () => {
  const previous = process.env.DEV_RELAY;
  const token = "D".repeat(43);
  process.env.DEV_RELAY = token;
  try {
    const principal = authenticate({ version: 1, credentials: [] }, `Bearer ${token}`);
    assert.equal(principal.id, "dev-relay");
    assert.equal(principal.grant.inspect.topology, true);
    assert.equal(principal.grant.inspect.messages, false);
    assert.equal(
      authorize({ version: 1, credentials: [] }, principal, "snapshot", { options: {} }).operation,
      "snapshot",
    );
    assert.equal(
      authorizeBoardRead({ version: 1, credentials: [] }, principal, "bounty", "msg", false)
        .operation,
      "list",
    );
    assert.throws(
      () => authorize({ version: 1, credentials: [] }, principal, "stats", {}),
      (error) => error.code === "denied",
    );
    assert.throws(
      () => authenticate({ version: 1, credentials: [] }, `Bearer ${"E".repeat(43)}`),
      (error) => error.code === "auth",
    );
  } finally {
    if (previous === undefined) delete process.env.DEV_RELAY;
    else process.env.DEV_RELAY = previous;
  }
});

test("board reads require their own board and kind grant", async () => {
  await withTempDir(async (root) => {
    const grant = emptyGrant();
    grant.inboxRead = ["host:device-1"];
    const auth = credential({ grant });
    const path = join(root, "credentials.json");
    await privateFile(path, JSON.stringify({ version: 1, credentials: [auth.entry] }));
    const snapshot = await loadRegistry(path);
    const principal = authenticate(snapshot, `Bearer ${auth.token}`);
    assert.equal(
      authorizeBoardRead(snapshot, principal, "host:device-1", "msg", true).operation,
      "list",
    );
    assert.throws(
      () => authorizeBoardRead(snapshot, principal, "host:device-1", "work", false),
      (error) => error.code === "denied",
    );
  });
});

test("message inspection grants stats independently from topology snapshots", async () => {
  await withTempDir(async (root) => {
    const grant = emptyGrant();
    grant.inspect.messages = true;
    const auth = credential({ grant });
    const path = join(root, "credentials.json");
    await privateFile(path, JSON.stringify({ version: 1, credentials: [auth.entry] }));
    const snapshot = await loadRegistry(path);
    const principal = authenticate(snapshot, `Bearer ${auth.token}`);
    assert.equal(authorize(snapshot, principal, "stats", {}).operation, "stats");
    assert.throws(
      () => authorize(snapshot, principal, "snapshot", { options: {} }),
      (error) => error.code === "denied",
    );

    grant.inspect.messages = false;
    grant.inspect.topology = true;
    auth.entry.grant = grant;
    await privateFile(path, JSON.stringify({ version: 1, credentials: [auth.entry] }));
    const topologyOnly = await loadRegistry(path);
    const topologyPrincipal = authenticate(topologyOnly, `Bearer ${auth.token}`);
    assert.equal(
      authorize(topologyOnly, topologyPrincipal, "snapshot", { options: {} }).operation,
      "snapshot",
    );
    assert.throws(
      () => authorize(topologyOnly, topologyPrincipal, "stats", {}),
      (error) => error.code === "denied",
    );
  });
});

test("registry digest collisions and unknown grant keys fail closed", async () => {
  await withTempDir(async (root) => {
    const first = credential();
    const second = credential({ principal: "other", token: first.token });
    const path = join(root, "credentials.json");
    await privateFile(
      path,
      JSON.stringify({ version: 1, credentials: [first.entry, second.entry] }),
    );
    await assert.rejects(
      loadRegistry(path),
      (error) => error instanceof Fault && error.code === "input",
    );
    first.entry.grant.extra = true;
    await privateFile(path, JSON.stringify({ version: 1, credentials: [first.entry] }));
    await assert.rejects(
      loadRegistry(path),
      (error) => error instanceof Fault && error.code === "input",
    );
  });
});
