import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SOURCE_DIRS = ["src", "ui", "scripts"];
const EXPECTED_DIST = ["dist/app.js", "dist/index.html", "dist/style.css"];

function collectJsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    console.error(`check failed: source directory missing: ${dir}`);
    process.exit(1);
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function fail(message) {
  console.error(`check failed: ${message}`);
  process.exit(1);
}

const files = SOURCE_DIRS.flatMap((dir) => collectJsFiles(dir)).sort();
if (files.length === 0) fail("no authored JavaScript modules found");
console.log(`checking syntax for ${files.length} module(s)`);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "pipe" });
  if (result.status !== 0) {
    const detail = (result.stderr?.toString() ?? "").trim();
    fail(`syntax error in ${file}${detail ? `: ${detail}` : ""}`);
  }
}

console.log("running browser build (scripts/build.mjs)");
const build = spawnSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
if (build.status !== 0) fail("browser build exited non-zero");

for (const artifact of EXPECTED_DIST) {
  let size;
  try {
    size = statSync(artifact).size;
  } catch {
    fail(`missing build artifact: ${artifact}`);
  }
  if (size === 0) fail(`empty build artifact: ${artifact}`);
  console.log(`ok: ${artifact} (${size} bytes)`);
}

console.log("check passed");
