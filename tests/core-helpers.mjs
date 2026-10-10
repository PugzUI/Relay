import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function temporaryRoot(t) {
  const parent = mkdtempSync(join(tmpdir(), "relay-core-"));
  const root = join(parent, "store");
  t.after(() => {
    if (!resolve(root).startsWith(`${resolve(parent)}/`)) throw new Error("Refusing unsafe test cleanup");
    rmSync(parent, { recursive: true, force: true });
  });
  return root;
}
