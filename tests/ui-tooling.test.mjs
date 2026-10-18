import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { withTempDir } from "./network-helpers.mjs";

const project = dirname(dirname(fileURLToPath(import.meta.url)));

async function withBuildFixture(run) {
  return withTempDir(async (root) => {
    const assets = join(root, "ui/assets");
    const script = join(root, "scripts/build-ui.mjs");
    await Promise.all([mkdir(dirname(script), { recursive: true }), mkdir(assets, { recursive: true })]);
    for (const path of ["scripts/build-ui.mjs", "ui/console.mjs", "ui/filter.mjs", "package.json", "LICENSE"]) {
      await writeFile(join(root, path), await readFile(join(project, path), "utf8"));
    }
    await symlink(join(project, "node_modules"), join(root, "node_modules"), "dir");
    return run({ root, assets, script });
  });
}

test("UI build preserves published assets when staging a generated output fails", async () => {
  await withBuildFixture(async ({ root, assets, script }) => {
    const previous = { "console.mjs": "previous module", "console.mjs.LEGAL.txt": "previous notices", "licenses.txt": "previous licenses" };
    for (const [name, text] of Object.entries(previous)) await writeFile(join(assets, name), text);
    const hook = join(root, "failure.mjs");
    await writeFile(hook, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const write=fs.promises.writeFile;let outputs=0;
fs.promises.writeFile=async(path,...args)=>{if(/(?:console\\.mjs|console\\.mjs\\.LEGAL\\.txt|licenses\\.txt)$/.test(String(path))&&++outputs===2)throw new Error('injected asset write failure');return write(path,...args);};
syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ["--import", hook, script], { cwd: root, encoding: "utf8", timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /injected asset write failure/);
    for (const [name, text] of Object.entries(previous)) assert.equal(await readFile(join(assets, name), "utf8"), text);
    assert.deepEqual((await readdir(assets)).sort(), Object.keys(previous).sort());
    assert.equal((await readdir(root)).some((name) => name.startsWith(".relay-ui-build-")), false);
    execFileSync(process.execPath, [script], { cwd: root, timeout: 15_000 });
    const checked = execFileSync(process.execPath, [script, "--check"], { cwd: root, encoding: "utf8", timeout: 15_000 });
    assert.match(checked, /packaged bundle and licenses match source/);
    assert.deepEqual((await readdir(assets)).sort(), Object.keys(previous).sort());
    assert.equal((await readdir(root)).some((name) => name.startsWith(".relay-ui-build-")), false);
  });
});

test("interrupted UI build staging cannot enter the package", async () => {
  await withBuildFixture(async ({ root, script }) => {
    const hook = join(root, "interrupt.mjs");
    const record = join(root, "staged-path");
    await writeFile(hook, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const write=fs.promises.writeFile;
fs.promises.writeFile=async(path,...args)=>{await write(path,...args);if(/console\\.mjs(?:\\.LEGAL\\.txt)?$/.test(String(path))){await write(${JSON.stringify(record)},String(path));process.exit(73);}};
syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ["--import", hook, script], { cwd: root, encoding: "utf8", timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 73, result.stderr);
    const orphan = await readFile(record, "utf8");
    await access(orphan);
    const output = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: root, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
    }));
    const packages = Array.isArray(output) ? output : Object.values(output);
    assert.equal(packages.length, 1);
    assert.equal(packages[0].name, "@pugzui/relay");
    assert.equal(packages[0].entryCount, packages[0].files.length);
    const path = relative(root, orphan).split(sep).join("/");
    assert.equal(packages[0].files.some((file) => file.path === path), false, `staging leaked into package: ${path}`);
  });
});

test("overview verifier cleans its first workspace when evidence allocation fails", async () => {
  await withTempDir(async (root) => {
    const hook = join(root, "failure.mjs");
    const record = join(root, "owned-path");
    await writeFile(hook, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const create=fs.promises.mkdtemp;const write=fs.promises.writeFile;let calls=0;
fs.promises.mkdtemp=async(...args)=>{if(++calls===2)throw new Error('injected evidence allocation failure');const path=await create(...args);await write(${JSON.stringify(record)},path);return path;};
syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ["--import", hook, join(project, "tests/fixtures/ui/overview-qa.mjs")], {
      cwd: project, env: { ...process.env, TMPDIR: root }, encoding: "utf8", timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /injected evidence allocation failure/);
    const owned = await readFile(record, "utf8");
    await assert.rejects(access(owned), { code: "ENOENT" });
  });
});
