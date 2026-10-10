import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import http from "node:http";
import https from "node:https";
import { createServer } from "node:net";
import { join } from "node:path";
import { open, serve, setup } from "../src/index.mjs";
import { dispatchRpc } from "../src/relay.mjs";
import { parseBoardPage, parseSnapshot } from "../ui/state.mjs";
import { credential, emptyGrant, privateFile, withTempDir } from "./network-helpers.mjs";

const execFile = promisify(execFileCallback);

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function tlsFiles(root) {
  const caKey = join(root, "view-ca.key"); const ca = join(root, "view-ca.pem");
  const key = join(root, "view.key"); const request = join(root, "view.csr");
  const cert = join(root, "view.pem"); const ext = join(root, "view.ext");
  await privateFile(ext, "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  await execFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "1", "-subj", "/CN=Relay test CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
  await execFile("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", request, "-subj", "/CN=127.0.0.1"]);
  await execFile("openssl", ["x509", "-req", "-in", request, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "1", "-extfile", ext]);
  return { ca, cert, key };
}

function viewGrant(board, { topology = true, inbox = false, work = false } = {}) {
  const grant = emptyGrant();
  grant.inspect.topology = topology;
  if (inbox) grant.inboxRead = [board];
  if (work) grant.workRead = [board];
  return grant;
}

test("A49 actual board HTTP pages match the native UI data contract", async () => {
  await withTempDir(async (root) => {
    const device = setup({ root, device: "board-http" });
    const relay = open({ root });
    const worker = relay.register("worker");
    const session = relay.join(worker.id);
    const board = `host:${device.id}`;
    relay.post(session.id, board, { msg: "board HTTP probe" });
    relay.post(session.id, board, { work: { input: "board HTTP probe" } });
    const authority = relay.authority;
    relay.close();
    const grant = emptyGrant();
    grant.inboxRead = [board]; grant.workRead = [board];
    const auth = credential({ grant });
    await privateFile(join(root, "credentials.json"), JSON.stringify({ version: 1, credentials: [auth.entry] }));
    const probe = createServer();
    await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const port = probe.address().port;
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const configFile = await privateFile(join(root, "config.json"), JSON.stringify({
      version: 1, role: "host", mode: "local", listen: { host: "127.0.0.1", port }, tls: null,
      allowedPeers: [], credentialsFile: "credentials.json", hub: null, pool: null, views: [],
    }));
    const broker = await serve({ root, configFile });
    try {
      for (const [kind, paneKind] of [["msg", "msg"], ["work", "work"]]) {
        const url = new URL(`/v1/board?board=${encodeURIComponent(board)}&kind=${kind}&limit=50&data=1`, `http://127.0.0.1:${port}`);
        const response = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}` }, redirect: "error", signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, 200);
        const page = parseBoardPage(await response.json(), board, paneKind, authority).page;
        assert.equal(page.total, 1);
        assert.equal(page.items[0].kind, kind);
      }
    } finally { await broker.close(); }
  });
});

test("fixed host views expose the owning authority to topology and forward pages through the UI parser", async () => {
  await withTempDir(async (root) => {
    const hubRoot = join(root, "hub"); const hostRoot = join(root, "host");
    setup({ root: hubRoot, device: "interop-hub", role: "hub" });
    const hostDevice = setup({ root: hostRoot, device: "interop-host" });
    const board = `host:${hostDevice.id}`;

    const hostRelay = open({ root: hostRoot });
    const hostWorker = hostRelay.register("worker");
    const hostSession = hostRelay.join(hostWorker.id);
    hostRelay.post(hostSession.id, board, { msg: "host inbox probe" });
    hostRelay.post(hostSession.id, board, { work: { task: "host work probe" } });
    const hostAuthority = hostRelay.authority;
    hostRelay.close();

    const hubRelay = open({ root: hubRoot });
    const reportGrant = emptyGrant();
    reportGrant.enroll = [{ deviceId: hostDevice.id, deviceName: hostDevice.name }];
    reportGrant.register = [{ deviceId: hostDevice.id, deviceName: hostDevice.name, runtimes: ["worker"], allocate: false }];
    reportGrant.workers = [`${hostDevice.name}:worker:001`];
    reportGrant.reportDevice = hostDevice.id;
    const reportAuth = { principal: { id: "host-reporter", grant: reportGrant }, scopeKey: "test-report-scope" };
    hubRelay.enroll(hostDevice, reportAuth);
    const hubWorker = hubRelay.register("worker", { slot: "001" }, reportAuth);
    const hubSession = dispatchRpc(hubRelay, {
      authorization: { ...reportAuth, operation: "join" }, rid: "interop-join", op: "join", args: { worker: hubWorker.id }, beforeCommit() {},
    }).result;
    dispatchRpc(hubRelay, {
      authorization: { ...reportAuth, operation: "report" }, rid: "interop-report", op: "report",
      args: { sid: hubSession.id, report: {
        seq: 1,
        agents: [{ worker: hubWorker.id, state: "ready", free: 1, assignmentCount: 0 }],
        board: { id: board, inbox: 1, pending: 1, claimed: 0, terminal: 0 },
      } }, beforeCommit() {},
    });
    const hubAuthority = hubRelay.authority;
    hubRelay.close();

    const hostView = credential({ principal: "fixed-host-view", grant: viewGrant(board, { inbox: true, work: true }) });
    await privateFile(join(hostRoot, "credentials.json"), JSON.stringify({ version: 1, credentials: [hostView.entry] }));
    const topologyOnly = credential({ principal: "topology-only", grant: viewGrant(board) });
    const boardViewer = credential({ principal: "board-viewer", grant: viewGrant(board, { inbox: true, work: true }) });
    const noTopology = credential({ principal: "no-topology", grant: viewGrant(board, { topology: false, inbox: true }) });
    await privateFile(join(hubRoot, "credentials.json"), JSON.stringify({ version: 1, credentials: [topologyOnly.entry, boardViewer.entry, noTopology.entry] }));

    let hostBroker;
    let tlsView;
    let hubBroker;
    try {
      const hostPort = await freePort();
      const hostConfig = join(hostRoot, "config.json");
      await privateFile(hostConfig, JSON.stringify({
        version: 1, role: "host", mode: "local", listen: { host: "127.0.0.1", port: hostPort }, tls: null,
        allowedPeers: [], credentialsFile: "credentials.json", hub: null, pool: null, views: [],
      }));
      hostBroker = await serve({ root: hostRoot, configFile: hostConfig });

      const tls = await tlsFiles(root);
      const forwardedAuth = [];
      let unavailableHealth = false;
      tlsView = https.createServer({ key: await readFile(tls.key), cert: await readFile(tls.cert) }, (req, res) => {
        forwardedAuth.push(req.headers.authorization);
        if (unavailableHealth && req.url === "/v1/health") {
          unavailableHealth = false;
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ fault: { code: "unavailable", message: "fixture unavailable" } }));
          return;
        }
        const upstream = http.request({ hostname: "127.0.0.1", port: hostPort, method: req.method, path: req.url, headers: req.headers }, (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        });
        upstream.on("error", () => { res.destroy(); });
        req.pipe(upstream);
      });
      await new Promise((resolve, reject) => tlsView.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
      const tlsPort = tlsView.address().port;

      const hubPort = await freePort();
      const hubConfig = join(hubRoot, "config.json");
      await privateFile(hubConfig, JSON.stringify({
        version: 1, role: "hub", mode: "local", listen: { host: "127.0.0.1", port: hubPort }, tls: null,
        allowedPeers: [], credentialsFile: "credentials.json", hub: null, pool: null,
        views: [{ deviceId: hostDevice.id, url: `https://127.0.0.1:${tlsPort}`, tokenFile: "host-view.token", caFile: "view-ca.pem", boards: [board] }],
      }));
      await privateFile(join(hubRoot, "host-view.token"), hostView.token);
      await privateFile(join(hubRoot, "view-ca.pem"), await readFile(tls.ca));
      hubBroker = await serve({ root: hubRoot, configFile: hubConfig });

      const origin = `http://127.0.0.1:${hubPort}`;
      const deniedTopology = await fetch(`${origin}/v1/topology`, { headers: { Authorization: `Bearer ${noTopology.token}` } });
      assert.equal(deniedTopology.status, 403);
      assert.equal(forwardedAuth.length, 0);

      const topologyResponse = await fetch(`${origin}/v1/topology`, { headers: { Authorization: `Bearer ${boardViewer.token}` } });
      assert.equal(topologyResponse.status, 200);
      const snapshot = parseSnapshot(await topologyResponse.json());
      assert.equal(snapshot.authority, hubAuthority);
      assert.equal(snapshot.boards.find((item) => item.id === board)?.authority, hostAuthority);
      assert.equal(snapshot.boards.find((item) => item.id === board)?.reported, true);

      const forwardedBeforeDeniedBoard = forwardedAuth.length;
      const deniedBoard = await fetch(`${origin}/v1/board?board=${encodeURIComponent(board)}&kind=msg`, { headers: { Authorization: `Bearer ${topologyOnly.token}` } });
      assert.equal(deniedBoard.status, 403);
      assert.equal(forwardedAuth.length, forwardedBeforeDeniedBoard);

      for (const [kind, paneKind] of [["msg", "msg"], ["work", "work"]]) {
        const pageResponse = await fetch(`${origin}/v1/board?board=${encodeURIComponent(board)}&kind=${kind}&data=1`, { headers: { Authorization: `Bearer ${boardViewer.token}` }, redirect: "error" });
        assert.equal(pageResponse.status, 200);
        const page = parseBoardPage(await pageResponse.json(), board, paneKind, hostAuthority).page;
        assert.equal(page.total, 1);
        assert.equal(page.items[0].kind, kind);
      }

      unavailableHealth = true;
      const offlineSnapshotResponse = await fetch(`${origin}/v1/topology`, { headers: { Authorization: `Bearer ${boardViewer.token}` } });
      assert.equal(offlineSnapshotResponse.status, 200);
      const offlineSnapshot = parseSnapshot(await offlineSnapshotResponse.json());
      const reportedBoard = offlineSnapshot.boards.find((item) => item.id === board);
      assert.equal(reportedBoard.reported, true);
      assert.equal(reportedBoard.authority, hubAuthority);
      const recoveredPageResponse = await fetch(`${origin}/v1/board?board=${encodeURIComponent(board)}&kind=msg&data=1`, { headers: { Authorization: `Bearer ${boardViewer.token}` }, redirect: "error" });
      assert.equal(recoveredPageResponse.status, 200);
      const recoveredPage = parseBoardPage(await recoveredPageResponse.json(), board, "msg");
      assert.equal(recoveredPage.page.total, 1);
      assert.equal(recoveredPage.authority, hostAuthority);
      assert.equal(recoveredPage.page.items[0].board, board);
      assert.ok(forwardedAuth.length >= 3);
      assert.ok(forwardedAuth.every((value) => value === `Bearer ${hostView.token}`));
      assert.ok(forwardedAuth.every((value) => value !== `Bearer ${boardViewer.token}` && value !== `Bearer ${topologyOnly.token}`));

      await closeServer(tlsView);
      const unavailable = await fetch(`${origin}/v1/topology`, { headers: { Authorization: `Bearer ${boardViewer.token}` } });
      assert.equal(unavailable.status, 200);
      assert.equal(parseSnapshot(await unavailable.json()).boards.find((item) => item.id === board)?.reported, true);
      const unavailableBody = await fetch(`${origin}/v1/board?board=${encodeURIComponent(board)}&kind=msg&data=1`, { headers: { Authorization: `Bearer ${boardViewer.token}` } });
      assert.equal(unavailableBody.status, 503);
      assert.equal((await unavailableBody.json()).fault.code, "unavailable");
    } finally {
      await hubBroker?.close();
      if (tlsView) await closeServer(tlsView);
      await hostBroker?.close();
    }
  });
});
