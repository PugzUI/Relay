import test from "node:test";
import assert from "node:assert/strict";
import { readLinuxProcessStart } from "../src/process-identity.mjs";

test("Linux process identity distinguishes a missing process from an unknown identity", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux /proc identity is platform-specific");
  assert.match(await readLinuxProcessStart(process.pid), /^[0-9a-f-]{36}:\d+$/i);
  assert.equal(await readLinuxProcessStart(0), null);
  assert.equal(await readLinuxProcessStart(2_147_483_647), false);
});
