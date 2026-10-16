import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../src/config.mjs";
import { authenticate, loadRegistry } from "../src/auth.mjs";
import { open } from "../src/relay.mjs";
import { privateFile, withTempDir } from "./network-helpers.mjs";

const paths = (parent) => ({ root: join(parent, ".local/store"), file: join(parent, ".local/relay.json") });
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("local startup creates a private real profile and reuses its identity and credentials", async () => {
  await withTempDir(async (parent) => {
    const { root, file } = paths(parent);
    const profile = await config.prepareLocalProfile(root, file);
    const selected = await config.readConfig(file);
    assert.equal(selected.role, "host");
    assert.equal(selected.mode, "local");
    assert.deepEqual(selected.listen, { host: "127.0.0.1", port: 4200 });
    assert.equal(selected.hub, null);
    assert.equal(selected.pool, null);
    assert.equal(selected.delivery.enabled, false);
    const relay = open({ root, readOnly: true });
    let device;
    try {
      device = relay.device;
      assert.equal(relay.snapshot().totals.agents, 0);
      assert.equal(relay.stats().messages.rows, 0);
    } finally { relay.close(); }
    const token = (await readFile(profile.tokenFile, "utf8")).trim();
    assert.equal(/^[A-Za-z0-9_-]{43}$/.test(token), true);
    const viewer = authenticate(await loadRegistry(selected.credentialsFile), `Bearer ${token}`);
    assert.equal(viewer.grant.inspect.topology, true);
    assert.deepEqual(viewer.grant.inboxRead, [`host:${device.id}`]);
    assert.deepEqual(viewer.grant.workRead, [`host:${device.id}`]);
    for (const name of ["workers", "register", "enroll", "recipients", "boardPost", "boardClaim"]) assert.deepEqual(viewer.grant[name], []);
    const files = [file, selected.credentialsFile, profile.tokenFile];
    const before = await Promise.all(files.map((path) => readFile(path)));
    if (process.platform !== "win32") {
      for (const path of files) assert.equal((await stat(path)).mode & 0o077, 0);
      assert.equal((await stat(join(parent, ".local"))).mode & 0o077, 0);
    }
    await config.prepareLocalProfile(root, file);
    const after = await Promise.all(files.map((path) => readFile(path)));
    assert.equal(before.every((value, i) => value.equals(after[i])), true);
    const reopened = open({ root, readOnly: true });
    try { assert.deepEqual(reopened.device, device); } finally { reopened.close(); }
  });
});

test("local startup refuses incomplete credential files without replacing them", async () => {
  await withTempDir(async (parent) => {
    const { root, file } = paths(parent);
    await mkdir(join(parent, ".local"), { mode: 0o700 });
    const tokenFile = await privateFile(join(parent, ".local/viewer.token"), "existing private file");
    await assert.rejects(config.prepareLocalProfile(root, file), { code: "active" });
    assert.equal(await readFile(tokenFile, "utf8"), "existing private file");
    await assert.rejects(stat(root), { code: "ENOENT" });
  });
});

test("local startup refuses a symlinked profile directory", async () => {
  await withTempDir(async (parent) => {
    const outside = join(parent, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(parent, ".local"), "dir");
    const { root, file } = paths(parent);
    await assert.rejects(config.prepareLocalProfile(root, file), { code: "denied" });
    await assert.rejects(stat(join(outside, "relay.json")), { code: "ENOENT" });
  });
});

test("local startup refuses an invalid viewer token without replacing it", async () => {
  await withTempDir(async (parent) => {
    const { root, file } = paths(parent);
    const profile = await config.prepareLocalProfile(root, file);
    const invalid = "not-a-bearer-token\n";
    await privateFile(profile.tokenFile, invalid);
    await assert.rejects(config.prepareLocalProfile(root, file), { code: "input" });
    const result = spawnSync(process.execPath, [cli, "serve", "--json"], {
      cwd: parent, encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 16_384,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "input");
    assert.equal(await readFile(profile.tokenFile, "utf8"), invalid);
  });
});

test("local startup refuses a revoked viewer without restoring credentials", async () => {
  await withTempDir(async (parent) => {
    const { root, file } = paths(parent);
    const profile = await config.prepareLocalProfile(root, file);
    const selected = await config.readConfig(file);
    const token = await readFile(profile.tokenFile);
    const revoked = JSON.stringify({ version: 1, credentials: [] });
    await privateFile(selected.credentialsFile, revoked);
    await assert.rejects(config.prepareLocalProfile(root, file), { code: "auth" });
    const result = spawnSync(process.execPath, [cli, "serve", "--json"], {
      cwd: parent, encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 16_384,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "auth");
    assert.equal(await readFile(selected.credentialsFile, "utf8"), revoked);
    assert.equal((await readFile(profile.tokenFile)).equals(token), true);
  });
});

for (const name of ["relay.json", "viewer.token"]) {
  test(`local startup rejects a writerless ${name} FIFO without hanging`, { skip: process.platform === "win32" }, async () => {
    await withTempDir(async (parent) => {
      const { root, file } = paths(parent);
      await config.prepareLocalProfile(root, file);
      const fifo = join(parent, ".local", name);
      await rm(fifo);
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 2_000 });
      assert.ifError(created.error);
      assert.equal(created.status, 0);
      const source = `import {prepareLocalProfile} from ${JSON.stringify(new URL("../src/config.mjs", import.meta.url).href)};
        try { await prepareLocalProfile(process.argv[1], process.argv[2]); process.exitCode = 1; }
        catch (error) { process.exitCode = error.code === "input" ? 0 : 2; }`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, root, file], {
        encoding: "utf8", timeout: 1_500, killSignal: "SIGKILL",
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0);
    });
  });
}
