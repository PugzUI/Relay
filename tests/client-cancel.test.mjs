import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { connect } from "../src/client.mjs";
import { credential, privateFile, withTempDir } from "./network-helpers.mjs";

test("transport fixture: closing after a mutation was sent preserves uncertain outcome", async () => {
  await withTempDir(async (root) => {
    const auth = credential();
    const tokenFile = await privateFile(join(root, "token"), auth.token);
    let received;
    const sent = new Promise((resolve) => {
      received = resolve;
    });
    const server = createServer(async (req, res) => {
      if (req.url === "/v1/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ v: 1, authority: "cancel-fixture", time: 1 }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received(JSON.parse(Buffer.concat(chunks).toString("utf8")).rid);
    });
    await new Promise((resolve, reject) =>
      server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())),
    );
    let client;
    try {
      client = await connect({
        url: `http://127.0.0.1:${server.address().port}`,
        tokenFile,
        mode: "local",
      });
      const outcome = client.post("fixture-session", "bounty", { work: { input: "fixture" } }).then(
        () => {
          throw new Error("a withheld response cannot prove success");
        },
        (error) => error,
      );
      const rid = await Promise.race([
        sent,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("mutation request was not observed")),
            2000,
          );
          timer.unref();
        }),
      ]);
      await client.close();
      const error = await outcome;
      assert.equal(error.code, "uncertain");
      assert.equal(error.context.id, rid);
    } finally {
      await client?.close();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
