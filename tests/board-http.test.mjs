import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { open, serve, setup } from "../src/index.mjs";
import { parseBoardPage } from "../ui/state.mjs";
import { credential, emptyGrant, privateFile, withTempDir } from "./network-helpers.mjs";

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
        const page = parseBoardPage(await response.json(), board, paneKind, authority);
        assert.equal(page.total, 1);
        assert.equal(page.items[0].kind, kind);
      }
    } finally { await broker.close(); }
  });
});
