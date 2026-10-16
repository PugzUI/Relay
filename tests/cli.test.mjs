import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, lstat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { CliInputError, parseArgs, parseStrictJson, readEnvelope } from "../src/cli.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("npm start uses the existing broker CLI", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts.start, "node src/cli.mjs serve");
});

test("bare serve selects the private local profile", () => {
  const parsed = parseArgs(["serve"]);
  assert.equal(parsed.flags.root, ".local/store");
  assert.equal(parsed.flags.config, ".local/relay.json");
  assert.equal(parsed.defaultLocal, true);
});

test("serve does not mix local defaults with partial custom selectors", () => {
  assert.throws(() => parseArgs(["serve", "--root", "custom"]), CliInputError);
  assert.throws(() => parseArgs(["serve", "--config", "custom.json"]), CliInputError);
  const parsed = parseArgs(["serve", "--root", "custom", "--config", "custom.json"]);
  assert.equal(parsed.defaultLocal, false);
  assert.equal(parsed.flags.root, "custom");
  assert.equal(parsed.flags.config, "custom.json");
});

test("A17 parses repeated caps and preserves spaces and Unicode in values", () => {
  const parsed = parseArgs(["register", "worker", "--root", "/tmp/a folder/雪", "--cap", "gpu", "--cap=inspect"]);
  assert.equal(parsed.flags.root, "/tmp/a folder/雪");
  assert.deepEqual(parsed.flags.cap, ["gpu", "inspect"]);
});

test("A17 rejects duplicate, unknown, malformed, and mixed selectors before dispatch", () => {
  for (const args of [
    ["stats", "--root", "one", "--root", "two"],
    ["stats", "--root", "one", "--url", "https://relay.example", "--token-file", "token"],
    ["join", "worker:runtime:001", "--root", "store", "--surprise"],
    ["claim", "--root", "store", "--sid", "sid", "--sid", "other"],
  ]) assert.throws(() => parseArgs(args), CliInputError);
  assert.throws(() => parseArgs(["setup", "--root", "hub", "--role", "hub"]), CliInputError);
  assert.throws(() => parseArgs(["join", "worker\0bad", "--root", "store"]), CliInputError);
});

test("A16 routes ordinary inspection through a read-only handle", () => {
  for (const [command, args] of [["get", ["message"]], ["list", []], ["stats", []], ["audit", []], ["snapshot", []]]) {
    assert.equal(parseArgs([command, ...args, "--root", "/tmp/read only"]).readOnly, true);
  }
});

test("A19 rejects remote credentials in URL and non-loopback cleartext before dispatch", () => {
  assert.throws(() => parseArgs(["stats", "--url", "https://user:secret@relay.example", "--token-file", "token"]), CliInputError);
  assert.throws(() => parseArgs(["stats", "--url", "http://relay.example", "--token-file", "token", "--mode", "local"]), CliInputError);
  assert.equal(parseArgs(["stats", "--url", "http://127.0.0.1:4200", "--token-file", "token", "--mode", "local"]).command, "stats");
});

test("A17 strict JSON keeps literal content and rejects duplicate keys and trailing values", () => {
  assert.deepEqual(parseStrictJson('{"work":{"text":"$HOME 100% \\\"quoted\\\" \\\\ path 雪"}}'), { work: { text: '$HOME 100% "quoted" \\ path 雪' } });
  assert.throws(() => parseStrictJson('{"msg":"first","msg":"second"}'), CliInputError);
  assert.throws(() => parseStrictJson('{"work":1} false'), CliInputError);
});

test("A17 stdin accepts one explicit envelope and rejects NUL, invalid UTF-8, and oversize", async () => {
  assert.deepEqual(await readEnvelope(Readable.from([' {"msg":"hello 雪"}\n'])), { msg: "hello 雪" });
  assert.deepEqual(await readEnvelope(Readable.from(['{"msg":"work: stays message text"}'])), { msg: "work: stays message text" });
  await assert.rejects(readEnvelope(Readable.from(['{"msg":"a","work":{}}'])), CliInputError);
  await assert.rejects(readEnvelope(Readable.from(['{"msg":"contains\u0000nul"}'])), CliInputError);
  await assert.rejects(readEnvelope(Readable.from(['{"work":{"task":"contains\\u0000nul"}}'])), CliInputError);
  await assert.rejects(readEnvelope(Readable.from([Buffer.from([0xff])])), CliInputError);
  await assert.rejects(readEnvelope(Readable.from([`{"work":"${"x".repeat(65_530)}"}`])), CliInputError);
});

test("A19 invalid selectors exit before loading the backend or creating a root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "relay-cli-a19-"));
  const root = resolve(parent, "missing root");
  try {
    const result = await runNode([cli, "stats", "--root", root, "--url", "https://relay.invalid", "--token-file", join(parent, "token")]);
    assert.equal(result.code, 2);
    await assert.rejects(lstat(root), { code: "ENOENT" });
  } finally {
    const resolvedParent = resolve(parent) + sep;
    assert.ok(root.startsWith(resolvedParent));
    await rm(parent, { recursive: true, force: true });
  }
});

function runNode(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stderr }));
  });
}
