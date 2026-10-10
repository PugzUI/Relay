import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { connect, open, serve, setup } from "../src/index.mjs";

const hubPort = port(process.env.RELAY_DEMO_HUB_PORT ?? "4200", "RELAY_DEMO_HUB_PORT");
const hostPort = port(process.env.RELAY_DEMO_HOST_PORT ?? "4201", "RELAY_DEMO_HOST_PORT");
const httpsPort = port(process.env.RELAY_DEMO_HTTPS_PORT ?? "4202", "RELAY_DEMO_HTTPS_PORT");
if (new Set([hubPort, hostPort, httpsPort]).size !== 3) throw new Error("demo ports must differ");

const parent = await mkdtemp(resolve(tmpdir(), "relay-network-demo-"));
const hubRoot = resolve(parent, "hub store");
const hostRoot = resolve(parent, "host store");
const hubConfigDir = resolve(parent, "hub config");
const hostConfigDir = resolve(parent, "host config");
const hubTokenFile = resolve(parent, "host-to-hub.token");
const hostTokenFile = resolve(parent, "host-local.token");
const hubCertFile = resolve(hubConfigDir, "loopback-cert.pem");
const hubKeyFile = resolve(hubConfigDir, "loopback-key.pem");
const hubWorker = "demo-hub:worker:prime";
const hostWorker = "demo-host:worker:001";
let hubDevice;
let hostDevice;
let hostBoard;
let hubRelay;
let hubBroker;
let hostBroker;
let httpsProxy;
let hubClient;
let hostClient;
let hubSid;
let hubWorkerSid;
let hostWorkerSid;
let failure;
const signals = new AbortController();
const timeout = setTimeout(() => {
  signals.abort(new Error("network demo exceeded 30 seconds"));
  for (const resource of [hubClient, hostClient, hostBroker, hubBroker]) {
    if (resource) void resource.close().catch(() => {});
  }
}, 30_000);
const onSignal = () => signals.abort(new Error("network demo interrupted"));
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  await Promise.all([mkdir(hubConfigDir, { mode: 0o700 }), mkdir(hostConfigDir, { mode: 0o700 })]);
  const hubToken = await saveToken(hubTokenFile);
  const hostToken = await saveToken(hostTokenFile);
  await createLoopbackCertificate(hubCertFile, hubKeyFile);
  hubDevice = setup({ root: hubRoot, device: "demo-hub", role: "hub" });
  hostDevice = setup({ root: hostRoot, device: "demo-host", role: "host" });
  hostBoard = `host:${hostDevice.id}`;
  hubRelay = open({ root: hubRoot });
  hubRelay.register("worker", { slot: "prime" });
  hubSid = hubRelay.join(hubWorker).id;

  await writeConfig(hubConfigDir, "credentials.json", { version: 1, credentials: [{
    principal: "demo-host",
    tokenDigest: digest(hubToken),
    grant: grant({
      enroll: [{ deviceId: hostDevice.id, deviceName: hostDevice.name }],
      register: [{ deviceId: hostDevice.id, deviceName: hostDevice.name, runtimes: ["worker"], allocate: false }],
      workers: [hostWorker], recipients: [hubWorker], boardPost: ["bounty"], boardClaim: ["bounty"],
      inboxRead: ["bounty"], workRead: ["bounty"], inspect: allInspect(), reportDevice: hostDevice.id,
    }),
  }] });
  await writeConfig(hubConfigDir, "relay.json", config("hub", hubPort));
  await writeConfig(hostConfigDir, "credentials.json", { version: 1, credentials: [{
    principal: "demo-local-worker",
    tokenDigest: digest(hostToken),
    grant: grant({
      enroll: [],
      register: [{ deviceId: hostDevice.id, deviceName: hostDevice.name, runtimes: ["worker"], allocate: false }],
      workers: [hostWorker], recipients: [hostWorker], boardPost: [hostBoard], boardClaim: [hostBoard],
      inboxRead: [hostBoard], workRead: [hostBoard], inspect: allInspect(), reportDevice: null,
    }),
  }] });
  await writeConfig(hostConfigDir, "relay.json", config("host", hostPort));

  hubBroker = await serve({ root: hubRoot, configFile: resolve(hubConfigDir, "relay.json") });
  hostBroker = await serve({ root: hostRoot, configFile: resolve(hostConfigDir, "relay.json") });
  httpsProxy = await startHttpsForwarder(hubCertFile, hubKeyFile, httpsPort, hubPort);
  hubClient = await connect({ url: `https://127.0.0.1:${httpsPort}`, tokenFile: hubTokenFile, caFile: hubCertFile });
  hostClient = await connect({ url: `http://127.0.0.1:${hostPort}`, tokenFile: hostTokenFile, mode: "local" });

  const enrolled = await hubClient.enroll(hostDevice);
  const hubSideWorker = await hubClient.register("worker", { slot: "001", caps: ["inspect"] });
  hubWorkerSid = (await hubClient.join(hubSideWorker.id)).id;
  const addressed = await hubClient.send(hubWorkerSid, hubWorker, { msg: "synthetic host-to-hub message" });
  const hubMessage = hubRelay.claim(hubSid, { kind: "msg" });
  if (!hubMessage) throw new Error("hub did not receive the admitted addressed message");
  const addressedReceipt = hubRelay.ack(hubSid, hubMessage.id, "done");

  const hubPost = await hubClient.post(hubWorkerSid, "bounty", { work: { task: "inspect", workspace: "synthetic-demo" } }, { needs: ["inspect"] });
  const hubLease = await hubClient.claim(hubWorkerSid, { board: "bounty" });
  if (!hubLease) throw new Error("hub worker did not claim its persisted bounty work");
  const hubWorkReceipt = await hubClient.ack(hubWorkerSid, hubLease.id, "done");

  const hostSideWorker = await hostClient.register("worker", { slot: "001", caps: ["inspect"] });
  hostWorkerSid = (await hostClient.join(hostSideWorker.id)).id;
  const localPost = await hostClient.post(hostWorkerSid, hostBoard, { work: { task: "verify", workspace: "synthetic-demo" } }, { needs: ["inspect"] });
  const localLease = await hostClient.claim(hostWorkerSid, { board: hostBoard });
  if (!localLease) throw new Error("host worker did not claim its local persisted work");
  const localReceipt = await hostClient.ack(hostWorkerSid, localLease.id, "done");
  const [hubStats, hostStats] = await Promise.all([hubClient.stats(), hostClient.stats()]);

  if (signals.signal.aborted) throw signals.signal.reason;
  process.stdout.write(`${JSON.stringify({
    authorities: { hub: hubClient.authority, host: hostClient.authority },
    transports: { hub: "HTTPS through owned loopback terminator", host: "HTTP loopback" },
    devices: [{ id: hubDevice.id, name: hubDevice.name }, { id: enrolled.id, name: enrolled.name }],
    workers: [hubWorker, hostWorker],
    receipts: {
      addressedAdmission: addressed.id,
      addressedAck: { mid: addressedReceipt.mid, lease: addressedReceipt.lease, outcome: addressedReceipt.outcome },
      bountyAdmission: hubPost.id,
      bountyAck: { mid: hubWorkReceipt.mid, lease: hubWorkReceipt.lease, outcome: hubWorkReceipt.outcome },
      localAdmission: localPost.id,
      localAck: { mid: localReceipt.mid, lease: localReceipt.lease, outcome: localReceipt.outcome },
    },
    messageCounts: { hub: hubStats.messages, host: hostStats.messages },
  }, null, 2)}\n`);
} catch (error) {
  failure = error;
  throw error;
} finally {
  clearTimeout(timeout);
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  const cleanup = [];
  if (hubClient && hubWorkerSid) try { await hubClient.leave(hubWorkerSid); } catch (error) { if (!new Set(["session", "expired"]).has(error.code)) cleanup.push(error); }
  if (hostClient && hostWorkerSid) try { await hostClient.leave(hostWorkerSid); } catch (error) { if (!new Set(["session", "expired"]).has(error.code)) cleanup.push(error); }
  if (hostClient) try { await hostClient.close(); } catch (error) { cleanup.push(error); }
  if (hubClient) try { await hubClient.close(); } catch (error) { cleanup.push(error); }
  if (httpsProxy) try { await closeServer(httpsProxy); } catch (error) { cleanup.push(error); }
  if (hostBroker) try { await hostBroker.close(); } catch (error) { cleanup.push(error); }
  if (hubBroker) try { await hubBroker.close(); } catch (error) { cleanup.push(error); }
  if (hubSid) try { hubRelay?.leave(hubSid); } catch (error) { if (!new Set(["session", "expired"]).has(error.code)) cleanup.push(error); }
  try { hubRelay?.close(); } catch (error) { cleanup.push(error); }
  if (!resolve(hubRoot).startsWith(resolve(parent) + sep) || !resolve(hostRoot).startsWith(resolve(parent) + sep)) cleanup.push(new Error("refusing to remove unowned demo stores"));
  else try { await rm(parent, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
  if (cleanup.length) {
    const message = cleanup.map((error) => error.message).join("; ");
    if (failure) process.stderr.write(`cleanup after primary failure: ${message}\n`);
    else throw new AggregateError(cleanup, "network demo cleanup failed");
  }
}

function port(raw, name) {
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 65_535) throw new Error(`${name} must be an explicit port from 1 to 65535`);
  return Number(raw);
}

async function saveToken(path) {
  const token = randomBytes(32).toString("base64url");
  await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" });
  return token;
}

async function createLoopbackCertificate(certFile, keyFile) {
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", keyFile, "-out", certFile,
  ], { shell: false, stdio: "ignore", timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error("OpenSSL could not create the disposable loopback TLS certificate");
  await chmod(keyFile, 0o600);
}

async function startHttpsForwarder(certFile, keyFile, portNumber, targetPort) {
  const [cert, key] = await Promise.all([readFile(certFile), readFile(keyFile)]);
  const server = createHttpsServer({ cert, key }, (incoming, outgoing) => {
    const path = incoming.url;
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
      outgoing.writeHead(400).end();
      return;
    }
    const upstream = httpRequest({
      host: "127.0.0.1", port: targetPort, path, method: incoming.method,
      headers: { ...incoming.headers, host: `127.0.0.1:${targetPort}` },
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
    outgoing.on("close", () => upstream.destroy());
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(portNumber, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  return server;
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function digest(token) { return createHash("sha256").update(token).digest("hex"); }

function grant(overrides) {
  return {
    enroll: [], register: [], workers: [], recipients: [], boardPost: [], boardClaim: [], inboxRead: [], workRead: [],
    inspect: allInspect(), reportDevice: null, ...overrides,
  };
}

function allInspect() { return { messages: true, receipts: true, audit: true, topology: true }; }

function config(role, portNumber, options = {}) {
  return { version: 1, role, mode: options.mode ?? "local", listen: { host: "127.0.0.1", port: portNumber }, tls: options.tls ?? null, allowedPeers: options.allowedPeers ?? [], credentialsFile: "./credentials.json", hub: null, pool: null, views: [] };
}

async function writeConfig(directory, name, value) {
  await writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
