import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export async function withTempDir(run) {
  const path = resolve(await mkdtemp(`${tmpdir()}${sep}relay-network-`));
  const root = resolve(tmpdir());
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error("Refusing to remove a path outside the temporary directory");
  }
  try {
    return await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

export async function privateFile(path, contents) {
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

export function credential({
  principal = "worker",
  token = randomBytes(32).toString("base64url"),
  grant = emptyGrant(),
} = {}) {
  return {
    token,
    entry: { principal, tokenDigest: createHash("sha256").update(token).digest("hex"), grant },
  };
}

export function emptyGrant() {
  return {
    enroll: [],
    register: [],
    workers: [],
    recipients: [],
    boardPost: [],
    boardClaim: [],
    inboxRead: [],
    workRead: [],
    inspect: { messages: false, receipts: false, audit: false, topology: false },
    reportDevice: null,
  };
}
