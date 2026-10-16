import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { connect } from "../src/client.mjs";
import { serve } from "../src/broker.mjs";
import { createPool } from "../src/pool.mjs";
import { open, setup } from "../src/relay.mjs";
import { credential, emptyGrant, privateFile, withTempDir } from "./network-helpers.mjs";

const loopbackPort = await (async () => {
  const probe = createNetServer();
  try {
    return await listen(probe);
  } catch (error) {
    if (error.code === "EPERM") return null;
    throw error;
  } finally {
    if (probe.listening) await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  }
})();

function listen(server) {
  return new Promise((resolve, reject) => {
    const failed = (error) => { server.removeListener("listening", ready); reject(error); };
    const ready = () => { server.removeListener("error", failed); resolve(server.address().port); };
    server.once("error", failed); server.once("listening", ready);
    server.listen(0, "127.0.0.1");
  });
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function claimPastRate(pool, input) {
  for (;;) {
    const item = await pool.claim(input);
    if (item?.state !== "rate") return item;
    await pause(1100);
  }
}

test("Pool rotates local addressed messages and host work without starvation", async () => {
  await withTempDir(async (root) => {
    const device = setup({ root, device: "east", role: "host" });
    const local = open({ root }); const agent = local.register("worker"); const session = local.join(agent.id);
    const pool = createPool({ local, hub: null, maxAgents: 1, maxJobs: 1, pollMs: 100, minBackoffMs: 100, maxBackoffMs: 1000, launch: null });
    try {
      for (let i = 0; i < 2; i++) {
        local.send(session.id, agent.id, { msg: `local-${i}` });
        local.post(session.id, `host:${device.id}`, { work: { task: `local-${i}` } });
      }
      const observed = [];
      for (let i = 0; i < 4; i++) {
        const item = await pool.claim({ worker: agent.id, localSid: session.id });
        assert.equal(item?.state, "claimed");
        observed.push(item.kind === "msg" ? "local-msg" : "host-work");
        if (item.kind === "work") await pool.settle({ worker: agent.id, item, outcome: "done" });
        else local.ack(item.lease.sid, item.lease.id, "done");
      }
      assert.deepEqual(observed, ["local-msg", "host-work", "local-msg", "host-work"]);
    } finally { await pool.close(); local.close(); }
  });
});

test("Pool rotates fairly across all six local and hub message and work sources", { skip: loopbackPort ? false : "loopback sockets are unavailable in this sandbox" }, async () => {
  await withTempDir(async (root) => {
    const localRoot = join(root, "local"); const hubRoot = join(root, "hub");
    const device = setup({ root: localRoot, device: "east", role: "host" });
    const local = open({ root: localRoot });
    const agent = local.register("worker", { slot: "001" }); const localSession = local.join(agent.id);
    setup({ root: hubRoot, device: "hub", role: "hub" });
    const grant = emptyGrant();
    grant.enroll = [{ deviceId: device.id, deviceName: device.name }];
    grant.register = [{ deviceId: device.id, deviceName: device.name, runtimes: ["worker"], allocate: false }];
    grant.workers = [agent.id]; grant.recipients = [agent.id];
    grant.boardPost = ["bounty"]; grant.boardClaim = ["bounty"];
    const auth = credential({ principal: "east-worker", grant });
    const tokenFile = await privateFile(join(root, "hub.token"), auth.token);
    await privateFile(join(hubRoot, "credentials.json"), JSON.stringify({ version: 1, credentials: [auth.entry] }));
    const configFile = join(hubRoot, "relay.json");
    await privateFile(configFile, JSON.stringify({ version: 1, role: "hub", mode: "local", listen: { host: "127.0.0.1", port: loopbackPort }, tls: null, allowedPeers: [], credentialsFile: "./credentials.json", hub: null, pool: null, views: [] }));
    let broker; let hub; let pool;
    try {
      broker = await serve({ root: hubRoot, configFile });
      hub = await connect({ url: `http://127.0.0.1:${loopbackPort}`, tokenFile, mode: "local" });
      await hub.enroll(device);
      const hubAgent = await hub.register("worker", { slot: "001" });
      const hubSession = await hub.join(hubAgent.id);
      assert.equal(hubAgent.id, agent.id);
      pool = createPool({ local, hub, maxAgents: 2, maxJobs: 1, pollMs: 100, minBackoffMs: 100, maxBackoffMs: 1000, launch: null });

      local.send(localSession.id, agent.id, { msg: "local-msg" });
      await pause(115); await hub.send(hubSession.id, agent.id, { msg: "hub-msg" });
      local.send(localSession.id, agent.id, { work: { task: "local-direct" } });
      await pause(115); await hub.send(hubSession.id, agent.id, { work: { task: "hub-direct" } });
      local.post(localSession.id, `host:${device.id}`, { work: { task: "host-work" } });
      await pause(115); await hub.post(hubSession.id, "bounty", { work: { task: "hub-work" } });
      await pause(1100);

      const observed = [];
      for (let i = 0; i < 6; i++) {
        const item = await claimPastRate(pool, { worker: agent.id, localSid: localSession.id, hubSid: hubSession.id });
        assert.equal(item?.state, "claimed");
        observed.push(item.kind === "msg"
          ? item.authority === local.authority ? "local-msg" : "hub-msg"
          : item.board === null ? item.authority === local.authority ? "local-direct" : "hub-direct"
            : item.authority === local.authority ? "host-work" : "hub-work");
        if (item.kind === "work") await pool.settle({ worker: agent.id, item, outcome: "done" });
        else if (item.authority === local.authority) local.ack(item.lease.sid, item.lease.id, "done");
        else { await pause(115); await hub.ack(item.lease.sid, item.lease.id, "done"); }
      }
      assert.deepEqual(observed, ["local-msg", "hub-msg", "local-direct", "hub-direct", "host-work", "hub-work"]);
    } finally {
      if (pool) await pool.close();
      if (hub) await hub.close();
      if (broker) await broker.close();
      local.close();
    }
  });
});
