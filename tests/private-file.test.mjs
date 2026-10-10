import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "../src/client.mjs";
import { Fault } from "../src/fault.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("malformed UTF-8 token files return the stable input fault before connecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-token-encoding-"));
  try {
    const tokenFile = join(root, "token");
    await writeFile(tokenFile, Buffer.from([0xff]), { mode: 0o600 });
    await assert.rejects(connect({ url: "https://127.0.0.1:1", tokenFile }), (error) =>
      error instanceof Fault && error.code === "input" && error.message === "Token file has invalid contents");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("client and capture token readers reject a writerless FIFO without blocking", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-fifo-test-"));
  const fifo = join(root, "token-fifo");
  try {
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 1000 });
    assert.equal(created.status, 0, created.stderr);

    const clientUrl = new URL("../src/client.mjs", import.meta.url).href;
    const captureUrl = new URL("../scripts/capture.mjs", import.meta.url).href;
    const script = `
      const [{ connect }, { readCaptureToken }] = await Promise.all([import(process.argv[1]), import(process.argv[2])]);
      const outcomes = [];
      for (const read of [() => connect({ url: "https://127.0.0.1", tokenFile: process.argv[3], mode: "tailscale" }), () => readCaptureToken(process.argv[3])]) {
        try { await read(); outcomes.push("accepted"); }
        catch (error) {
          outcomes.push(error.code === "input" && /owned private regular file/.test(error.message)
            || error.message === "capture token file must be an owned, regular, private file" ? "rejected-fifo" : "wrong-error");
        }
      }
      process.stdout.write(JSON.stringify(outcomes));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, clientUrl, captureUrl, fifo], {
      encoding: "utf8", timeout: 3000, maxBuffer: 1024,
    });
    if (result.error?.code === "EPERM") {
      t.skip("sandbox does not permit the bounded subprocess regression");
      return;
    }
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["rejected-fifo", "rejected-fifo"]);
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
