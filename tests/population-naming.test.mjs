// CARRIER: the check gate must name every population it counts.
//
// Rule under test: a gate datum that reports a count must NAME the population
// it counted, not merely print a count. A bare count is vacuous in exactly the
// trees a gate is meant to judge -- a git-archive extraction, a tree missing
// one file -- because the reader cannot tell what was counted.
//
// Subject: scripts/check.mjs, the published `npm run check` gate. It counts
// three populations: the JavaScript modules it syntax-checks (a filesystem
// walk over src/, scripts/, examples/ and ui/), the frozen runtime exports of
// src/index.mjs, and the files npm packs. This carrier measures each of them
// INDEPENDENTLY of the gate's own output and compares member for member, so
// the gate cannot pass by printing a count that happens to match.
//
// A hole is an exit code here: a gate that prints a bare count, or names a
// population that is not the one it counted, must make this file RED. The
// carrier never judges whether a datum is "good enough" -- it compares the
// named members with an independently enumerated population.
//
// Limits, stated rather than implied:
// - The exports population is re-derived by parsing the published src/index.mjs
//   with the same export-block shape the gate reads. The comparison is
//   independent of the gate's OUTPUT, not of the published source's shape.
// - The packaging population is enumerated from the published "files" allowlist
//   plus the three files npm always packs, and the enumeration is cross-checked
//   once against npm's own `npm pack --dry-run` listing. The cross-check runs
//   in the baseline test, so every mutant is judged against an enumeration
//   that was shown to agree with npm.
// - The carrier judges the gate's STDOUT datum. The gate's exit status is
//   reported, not asserted: a missing node_modules (gitignored, so a
//   git-archive extraction never carries it) makes the gate exit non-zero
//   without touching any population datum.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gateRelative = join("scripts", "check.mjs");
const sourceRoots = ["src", "scripts", "examples", "ui"];
const populations = ["syntax", "exports", "packaging"];
const counted = {
  syntax: /^syntax: .*?\b(\d+)\b/,
  exports: /^exports: .*?\b(\d+)\b/,
  packaging: /^packaging: .*?\b(\d+)\b/,
};

function npmCliCandidates() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try {
      const entry = join(directory, "npm");
      if (existsSync(entry)) candidates.push(realpathSync(entry));
    } catch {
      // an unreadable PATH entry is not this carrier's problem
    }
  }
  candidates.push(
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  );
  return candidates;
}

function resolveNpmCli() {
  for (const candidate of npmCliCandidates()) {
    if (candidate?.endsWith(".js") && existsSync(candidate)) return candidate;
  }
  return null;
}

const npmCli = resolveNpmCli();

async function walkSources(root) {
  const found = [];
  const walk = async (relativeDirectory) => {
    let entries;
    try {
      entries = await readdir(join(root, relativeDirectory), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else found.push(child);
    }
  };
  for (const directory of sourceRoots) await walk(directory);
  return found.filter((path) => path.endsWith(".mjs") || path.endsWith(".js")).sort();
}

async function parseExports(root) {
  const source = await readFile(join(root, "src", "index.mjs"), "utf8");
  return [...source.matchAll(/export\s*\{([^}]+)\}/g)]
    .flatMap((match) => match[1].split(","))
    .map((name) =>
      name
        .trim()
        .split(/\s+as\s+/)
        .at(-1),
    )
    .sort();
}

async function packedFiles(root) {
  assert.ok(
    npmCli,
    "npm's CLI path could not be resolved; the packaging population cannot be measured",
  );
  const cache = await mkdtemp(join(tmpdir(), "relay-pack-"));
  try {
    const result = spawnSync(
      process.execPath,
      [npmCli, "pack", "--dry-run", "--ignore-scripts", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, npm_config_cache: cache, npm_config_logs_max: "0" },
      },
    );
    assert.equal(result.status, 0, `npm pack --dry-run failed in ${root}: ${result.stderr}`);
    const manifest = JSON.parse(result.stdout);
    const packages = Array.isArray(manifest)
      ? manifest
      : Object.values(manifest).filter((value) => Array.isArray(value?.files));
    assert.equal(packages.length, 1, `npm pack returned no single file manifest in ${root}`);
    assert.ok(packages[0].files, `npm pack returned no file manifest in ${root}`);
    return packages[0].files.map((file) => file.path).sort();
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

async function enumeratedPackagedFiles(root) {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const files = [];
  const walk = async (relativeDirectory) => {
    let entries;
    try {
      entries = await readdir(join(root, relativeDirectory), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else files.push(child);
    }
  };
  for (const entry of manifest.files ?? []) {
    if (entry.endsWith("/")) await walk(entry.slice(0, -1));
    else files.push(entry);
  }
  for (const entry of ["package.json", "README.md", "LICENSE"]) {
    if (!files.includes(entry)) files.push(entry);
  }
  return files.sort();
}

function runGate(root, script) {
  const env = { ...process.env };
  if (npmCli) env.npm_execpath = npmCli;
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    env,
  });
  const stdout = result.stdout ?? "";
  return {
    status: result.status,
    stdout,
    stderr: result.stderr ?? "",
    lines: stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function populationViolations(lines, expected) {
  const violations = [];
  for (const key of populations) {
    const datum = lines.find((line) => counted[key].test(line));
    if (!datum) {
      violations.push(`${key}: the gate reported no count for this population`);
      continue;
    }
    const count = Number(counted[key].exec(datum)[1]);
    const named = lines.find((line) => new RegExp(`^${key} population:`).test(line));
    if (!named) {
      violations.push(`${key}: counted ${count} but named no population`);
      continue;
    }
    const members = named
      .slice(named.indexOf(":") + 1)
      .trim()
      .split(",")
      .map((member) => member.trim())
      .filter(Boolean);
    if (members.length !== count) {
      violations.push(`${key}: counts ${count} but names ${members.length} member(s)`);
    }
    const missing = expected[key].filter((member) => !members.includes(member));
    const extra = members.filter((member) => !expected[key].includes(member));
    if (missing.length) {
      violations.push(`${key}: names ${members.length} member(s) but omits ${missing.join(", ")}`);
    }
    if (extra.length) {
      violations.push(`${key}: names member(s) outside the population: ${extra.join(", ")}`);
    }
  }
  return violations;
}

const mutants = [
  {
    id: "M1",
    population: "syntax",
    label: "the syntax population line is removed, leaving a bare count",
    anchor: `console.log(\`syntax population: \${[...sourceFiles].sort().join(", ")}\`);\n`,
    replacement: "",
    sites: 1,
  },
  {
    id: "M2",
    population: "syntax",
    label: "one named member is replaced by a path outside the population",
    anchor: '[...sourceFiles].sort().join(", ")',
    replacement:
      '[...sourceFiles].sort().map((path, index) => (index === 0 ? "src/not-in-the-population.mjs" : path)).join(", ")',
    sites: 1,
  },
  {
    id: "M3",
    population: "syntax",
    label: "one member is dropped while the count still reports the whole population",
    anchor: '[...sourceFiles].sort().join(", ")',
    replacement: '[...sourceFiles].sort().slice(1).join(", ")',
    sites: 1,
  },
  {
    id: "M4",
    population: "syntax",
    label: "the filesystem walk is replaced by a git index query",
    anchor:
      'const sourceFiles = (await Promise.all(["src", "scripts", "examples", "ui"].map(filesUnder)))\n  .flat()\n  .filter((path) => path.endsWith(".mjs") || path.endsWith(".js"));',
    replacement:
      'const sourceFiles = run("git", ["ls-files"])\n  .stdout.split("\\n")\n  .filter((path) => path.endsWith(".mjs") || path.endsWith(".js"));',
    sites: 1,
  },
  {
    id: "M5",
    population: "packaging",
    label: "the packaging population line is removed, leaving a bare count",
    anchor: `console.log(\`packaging population: \${[...packedPaths].sort().join(", ")}\`);\n`,
    replacement: "",
    sites: 1,
  },
  {
    id: "M6",
    population: "exports",
    label: "one named export is dropped while the count still reports the whole population",
    anchor: `console.log(\`exports population: \${actualExports.join(", ")}\`);`,
    replacement: `console.log(\`exports population: \${actualExports.filter((name) => name !== "LIMITS").join(", ")}\`);`,
    sites: 1,
  },
];

async function mirrorTree(destination) {
  for (const entry of ["src", "scripts", "examples", "ui"]) {
    await cp(join(repoRoot, entry), join(destination, entry), { recursive: true });
  }
  for (const file of ["package.json", "package-lock.json", "README.md", "LICENSE"]) {
    await cp(join(repoRoot, file), join(destination, file));
  }
  await symlink(join(repoRoot, "node_modules"), join(destination, "node_modules"), "dir");
}

async function measurePopulations(root) {
  return {
    syntax: await walkSources(root),
    exports: await parseExports(root),
    packaging: await enumeratedPackagedFiles(root),
  };
}

async function runMutant(mutant) {
  const scratch = await mkdtemp(join(tmpdir(), "relay-population-"));
  try {
    await mirrorTree(scratch);
    const script = join(scratch, gateRelative);
    const original = await readFile(script, "utf8");
    const sites = original.split(mutant.anchor).length - 1;
    assert.equal(
      sites,
      mutant.sites,
      `${mutant.id}: the anchor matched ${sites} site(s), expected ${mutant.sites}`,
    );
    const mutated = original.split(mutant.anchor).join(mutant.replacement);
    assert.notEqual(mutated, original, `${mutant.id}: the mutation did not change the source text`);
    await writeFile(script, mutated);
    const run = runGate(scratch, script);
    const expected = await measurePopulations(scratch);
    return { violations: populationViolations(run.lines, expected), run };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test("the check gate names every population it counts", async () => {
  const run = runGate(repoRoot, join(repoRoot, gateRelative));
  const expected = await measurePopulations(repoRoot);
  const packed = await packedFiles(repoRoot);
  assert.deepEqual(
    expected.packaging,
    packed,
    "the allowlist enumeration does not match npm's own packed file list",
  );
  const violations = populationViolations(run.lines, expected);
  assert.deepEqual(
    violations,
    [],
    `the gate datum does not name its populations:\n${violations.join("\n")}\ngate status: ${run.status}`,
  );
  for (const key of populations) {
    console.log(`population ${key}: ${expected[key].length} member(s) named by the gate datum`);
  }
  console.log(
    `population packaging: enumerated from the published allowlist, cross-checked against npm pack (${packed.length} member(s))`,
  );
  console.log(`gate status: ${run.status}`);
});

test("a gate that prints a bare count, or names the wrong population, is caught", async () => {
  // Sequential on purpose: three concurrent gate runs measured slower on this
  // host (65.8s at three workers versus 59s for the same table with one
  // worker), because every worker drives a compiler, a bundler and npm.
  const caught = [];
  for (const mutant of mutants) {
    const { violations } = await runMutant(mutant);
    assert.ok(
      violations.length > 0,
      `${mutant.id} (${mutant.label}) was not caught: the carrier found no violation`,
    );
    caught.push(`${mutant.id} ${mutant.population}: ${violations.join("; ")}`);
  }
  console.log(`mutants caught: ${caught.length}/${mutants.length}`);
  for (const line of caught) console.log(`  ${line}`);
});

test("the gate names its population in a tree with no git index", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "relay-population-"));
  try {
    await mirrorTree(scratch);
    assert.equal(
      existsSync(join(scratch, ".git")),
      false,
      "the mirrored tree must not carry a git index",
    );
    const run = runGate(scratch, join(scratch, gateRelative));
    const expected = await measurePopulations(scratch);
    const violations = populationViolations(run.lines, expected);
    assert.deepEqual(
      violations,
      [],
      `the gate datum does not name its populations without a git index:\n${violations.join("\n")}`,
    );
    for (const key of populations) {
      console.log(`population ${key}: ${expected[key].length} member(s) named without a git index`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("every population is attacked by a named mutant", () => {
  const attacked = new Set(mutants.map((mutant) => mutant.population));
  for (const key of populations) {
    assert.ok(
      attacked.has(key),
      `population ${key} is judged by the carrier but no mutant attacks it`,
    );
  }
  for (const mutant of mutants) {
    assert.ok(
      populations.includes(mutant.population),
      `${mutant.id} names population ${mutant.population}, which the carrier does not judge`,
    );
  }
  console.log(
    `populations attacked: ${[...attacked].sort().join(", ")} (${mutants.length} mutant(s))`,
  );
});
