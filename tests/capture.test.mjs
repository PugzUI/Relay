import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureUrl, readCaptureToken } from "../scripts/capture.mjs";

test("capture URL accepts only loopback origins", () => {
  assert.equal(captureUrl("http://127.0.0.1:4200"), "http://127.0.0.1:4200");
  assert.equal(captureUrl("https://[::1]:4200"), "https://[::1]:4200");
  for (const value of ["https://example.test", "http://127.0.0.1/path", "http://user@localhost", "http://localhost/?token=x"]) {
    assert.throws(() => captureUrl(value));
  }
});

test("capture token reader accepts a private token file and rejects unsafe forms", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-capture-test-"));
  const path = join(root, "token");
  const token = "A".repeat(43);
  try {
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    assert.equal(await readCaptureToken(path), token);
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await assert.rejects(readCaptureToken(path), /private file/);
      await chmod(path, 0o600);
      const link = join(root, "token-link");
      await symlink(path, link);
      await assert.rejects(readCaptureToken(link), /opened safely/);
    }
    await writeFile(path, `${token}extra`, { mode: 0o600 });
    await assert.rejects(readCaptureToken(path), /invalid size/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
