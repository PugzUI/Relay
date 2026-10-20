// CORPUS VALIDATION - apply the comparator to every tracked source file in the repository
// and assert the comment-stripped output still parses.
//
// WHY THIS EXISTS: the acceptance set and the oracle were shaped by the same reasoning, so
// the set structurally cannot find the oracle's own blind spot. It passed the set while the
// oracle corrupted first-party code. Only a whole-corpus parse check can see that, so the
// corpus check is not a supplement to the acceptance set - it is the check that closes the
// class of defect the set cannot reach.
//
// AN EXCEPTION INSIDE THE CORPUS LOOP IS A COUNTED FAILURE WITH ITS FILE NAME, NEVER A
// SKIP. A swallowed exception shrinks the denominator and yields a smaller green. The file
// count IS the denominator: `processed + failed == expected` is asserted, and a moved
// denominator is a visible, non-zero-exit condition.
//
// THE DETECTION PATH IS PROVEN LIVE BY A POSITIVE CONTROL: a deliberately naive
// `//`-to-EOL comparator is run through the SAME check and MUST be reported, and the
// comparator under test is asserted not to mis-lex a nested template inside an
// interpolation. Without those two controls the script could report green because it
// cannot see anything.
//
// THE REPOSITORY ROOT IS DERIVED FROM THIS MODULE'S OWN LOCATION (the nearest ancestor
// holding a package.json); no path is hardcoded and the script works from any working
// directory.
//
// THE SOURCE POPULATION IS A FILESYSTEM POPULATION, COUNTED FROM THE TREE THAT IS BEING
// TESTED: a recursive walk of the JavaScript files present in this checkout, with the
// exclusions read from the repository's own .gitignore file (node_modules, coverage, the
// generated build output). Nothing here asks git for the file list, so the population is
// the same set in a checkout and in an index-free extraction - a `git ls-files` based
// population would name a DIFFERENT set (the tracked files) and would fail outright where
// there is no index. THE WALKED SET AND THE TRACKED SET ARE NOT THE SAME BY
// CONSTRUCTION - an untracked, non-ignored JavaScript file joins the population - and in
// this checkout the two are identical (the same 112 names), so the corpus is the
// published set. The population is NAMED in full, its count is printed, and the
// denominator of the sweep is the enumerated set. A population that cannot be enumerated
// is a hard error, never an empty list that would let the denominator hold against zero.
//
// Usage: node corpus-validation.mjs [--self-test]
//
// Writes only to a temporary directory; never mutates the repository.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { comparePair, stripCommentsStringAware } from "./string-aware-comparator.mjs";
import { evaluateCase } from "./acceptance-cases.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/** The repository root: the nearest ancestor of this module that holds a package.json. */
function findRepoRoot(start) {
  let current = start;
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("no package.json found above this module");
    current = parent;
  }
}

const repoRoot = findRepoRoot(moduleDirectory);

/** The name of the population the corpus sweep counts, stated in full. */
export const POPULATION_NAME =
  "the JavaScript files (.mjs, .js, .cjs) of the checked-out tree, recursively, " +
  "excluding the git metadata and the paths the repository's own .gitignore excludes " +
  "(node_modules, coverage, the generated build output)";

/** The ignore rules of the repository, read from the .gitignore file IN THE TREE. */
function ignoreRules(root) {
  const file = join(root, ".gitignore");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map(compileRule);
}

/** One ignore rule: whether it is negated, whether it is anchored at the root, its pattern. */
function compileRule(line) {
  const negated = line.startsWith("!");
  const pattern = negated ? line.slice(1) : line;
  const directoryOnly = pattern.endsWith("/");
  const body = directoryOnly ? pattern.slice(0, -1) : pattern;
  const anchored = body.startsWith("/");
  const bare = anchored ? body.slice(1) : body;
  if (bare.includes("**")) {
    throw new Error(`the ignore rule "${line}" uses a '**' pattern this matcher cannot read`);
  }
  return { negated, anchored, pattern: globToRegExp(bare) };
}

/** A regular expression for one ignore pattern: '*' and '?' never cross a path separator. */
function globToRegExp(pattern) {
  let source = "";
  for (const character of pattern) {
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * True when the relative path is excluded by the rules. The LAST matching rule wins, so a
 * negated rule re-includes a path, and a rule that matches a directory excludes everything
 * under it.
 */
function isIgnored(rules, path) {
  const segments = path.split("/");
  let ignored = false;
  for (const rule of rules) {
    for (let index = 1; index <= segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      const candidate = rule.anchored ? prefix : segments[index - 1];
      if (rule.pattern.test(candidate)) {
        ignored = !rule.negated;
        break;
      }
    }
  }
  return ignored;
}

/**
 * The JavaScript source files of the tree, relative to the repository root. The walk reads
 * the tree that is being tested, so the population is the same set in a checkout and in an
 * index-free extraction; nothing here asks git for the file list.
 */
function walkSources(root, rules) {
  const files = [];
  collectDirectory(root, root, rules, files);
  return files.sort();
}

/** Collect the source files of one directory, descending into the directories it enters. */
function collectDirectory(directory, root, rules, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isDirectory()) {
      if (entry.name !== ".git" && !isIgnored(rules, path)) {
        collectDirectory(absolute, root, rules, files);
      }
      continue;
    }
    if (isSourceFile(entry, path, rules)) files.push(path);
  }
}

/** True when the directory entry is a JavaScript source file that is not ignored. */
function isSourceFile(entry, path, rules) {
  if (!entry.isFile()) return false;
  if (!/\.(?:mjs|js|cjs)$/.test(entry.name)) return false;
  return !isIgnored(rules, path);
}

/**
 * The source population of the corpus sweep: a FILESYSTEM population, counted from the
 * tree that is being tested. A population that cannot be enumerated is a hard error, never
 * an empty list that would let the denominator hold against zero.
 */
export function sourcePopulation() {
  const files = walkSources(repoRoot, ignoreRules(repoRoot));
  if (files.length === 0) {
    throw new Error(`the source population is empty: ${POPULATION_NAME}`);
  }
  return { name: POPULATION_NAME, files };
}

/** True when the file at `path` parses as a module. */
export function parses(path) {
  try {
    execFileSync("node", ["--check", path], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/** True when the given text parses as a module. */
export function parsesText(text) {
  const work = mkdtempSync(join(tmpdir(), "relay-corpus-probe-"));
  try {
    const file = join(work, "probe.mjs");
    writeFileSync(file, text);
    return parses(file);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The tracked files whose comment-stripped text is syntactically invalid although the
 * original is valid. A transform that throws is a FAILURE carrying its file name, never a
 * skip, and the processed count is returned so the denominator can be asserted.
 */
export function corruptedFiles(population, strip = stripCommentsStringAware) {
  const sources = population.files;
  const work = mkdtempSync(join(tmpdir(), "relay-corpus-"));
  const failed = [];
  const bad = [];
  let processed = 0;
  try {
    for (const file of sources) {
      const absolute = join(repoRoot, file);
      let original;
      let stripped;
      try {
        original = readFileSync(absolute, "utf8");
        stripped = strip(original);
        if (stripped !== original) {
          // The candidate is checked and REMOVED before the next file, so the sweep holds
          // one temporary file at a time instead of one per source file.
          const candidate = join(work, file.replace(/[\\/]/g, "__"));
          writeFileSync(candidate, stripped);
          const invalid = parses(absolute) && !parses(candidate);
          rmSync(candidate, { force: true });
          if (invalid) bad.push(file);
        }
        processed += 1;
      } catch (error) {
        failed.push({ file, error: error.message });
      }
    }
    return { bad, failed, processed, expected: sources.length, population: population.name };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// THE ADVERSARIAL SHAPES. The list is the shape register of this lane and it is
// deliberately larger than the minimum: a shape that is dropped is a silent weakening,
// and the corpus figure cannot see a shape that is no longer probed. The first three are
// the nested-template false cleans: the comparator must report a difference, and against
// the unpatched reference it reported "same" for each of them, because the rest of the
// line was deleted as a line comment. The others are the shapes that must keep working:
// real comments are still stripped and real differences are still reported.
export const shapes = [
  [
    "S1",
    "difference after a nested template inside an interpolation",
    `const s = \`\${JSON.stringify({ url: \`http://127.0.0.1:\${port}\` })}\`; const w = 1;`,
    `const s = \`\${JSON.stringify({ url: \`http://127.0.0.1:\${port}\` })}\`; const w = 2;`,
    "flag",
  ],
  [
    "S2",
    "difference inside a nested template inside an interpolation",
    `const s = \`\${JSON.stringify({ url: \`http://127.0.0.1:\${port}\` })}\`;`,
    `const s = \`\${JSON.stringify({ url: \`http://127.0.0.1:\${port2}\` })}\`;`,
    "flag",
  ],
  [
    "S3",
    "difference after a nested template inside an interpolation that continues afterwards",
    `const s = \`a\${JSON.stringify({ url: \`http://127.0.0.1:\${port}\` })}b\`; const w = 1;`,
    `const s = \`a\${JSON.stringify({ url: \`http://127.0.0.1:\${port}\` })}b\`; const w = 2;`,
    "flag",
  ],
  [
    "S4",
    "a real comment inside an interpolation is stripped",
    `const s = \`\${x// note\n}\`;`,
    `const s = \`\${x\n}\`;`,
    "ignore",
  ],
  [
    "S5",
    "a real difference after a comment inside an interpolation is reported",
    `const s = \`\${x// note\n}\`; const w = 1;`,
    `const s = \`\${x\n}\`; const w = 2;`,
    "flag",
  ],
  ["S6", "a real trailing comment is stripped", "const a = 1; // note", "const a = 1;", "ignore"],
  ["S7", "a real full-line comment is stripped", "// note\nconst a = 1;", "const a = 1;", "ignore"],
  [
    "S8",
    "a real difference inside a string literal is reported",
    'const s = "a//b";',
    'const s = "a//c";',
    "flag",
  ],
  [
    "S9",
    "a real difference after a regex literal is reported",
    "const re = /\\/\\//; const w = 1;",
    "const re = /\\/\\//; const w = 2;",
    "flag",
  ],
  [
    "S10",
    "a backtick inside a string inside an interpolation does not end the template",
    `const s = \`\${"a\`b"} tail\`; const w = 1;`,
    `const s = \`\${"a\`b"} tail\`; const w = 2;`,
    "flag",
  ],
  [
    "S11",
    "a line comment inside an interpolation does not swallow the rest of the source",
    `const s = \`\${x // note\n} tail\`; const w = 1;`,
    `const s = \`\${x // note\n} tail\`; const w = 2;`,
    "flag",
  ],
  [
    "S12",
    "a block comment inside an interpolation is removed and the difference after it is reported",
    `const s = \`\${x /* note */} tail\`; const w = 1;`,
    `const s = \`\${x /* note */} tail\`; const w = 2;`,
    "flag",
  ],
  [
    "S13",
    "a regex literal containing a quote inside an interpolation",
    `const s = \`\${/'a'/.test(x)} tail\`; const w = 1;`,
    `const s = \`\${/'a'/.test(x)} tail\`; const w = 2;`,
    "flag",
  ],
  [
    "S14",
    "a regex literal containing a backtick inside an interpolation",
    `const s = \`\${/\`/.test(x)} tail\`; const w = 1;`,
    `const s = \`\${/\`/.test(x)} tail\`; const w = 2;`,
    "flag",
  ],
  [
    "S15",
    "a template nested two deep",
    `const s = \`a\${b\${c\`d\`}}e\`; const w = 1;`,
    `const s = \`a\${b\${c\`d\`}}e\`; const w = 2;`,
    "flag",
  ],
  [
    "S16",
    "an object literal containing a nested template",
    `const o = { u: \`http://x\${port}\` }; const w = 1;`,
    `const o = { u: \`http://x\${port}\` }; const w = 2;`,
    "flag",
  ],
  [
    "S17",
    "a real block comment inside an interpolation is stripped",
    `const s = \`\${x /* note */} tail\`;`,
    `const s = \`\${x /* other */} tail\`;`,
    "ignore",
  ],
];

/** Run the adversarial shapes through the module's own case evaluator. */
export async function runShapes() {
  const results = [];
  for (const shape of shapes) results.push(await evaluateCase(comparePair, shape));
  return results;
}

export function reportCorpus(result) {
  console.log(`population: ${result.population}, ${result.expected} JavaScript file(s)`);
  console.log(`source files expected: ${result.expected}`);
  console.log(`source files processed: ${result.processed}`);
  console.log(`transform failures: ${result.failed.length}`);
  for (const failure of result.failed) console.log(`   FAILED ${failure.file}: ${failure.error}`);
  console.log(`files whose stripped output is syntactically invalid: ${result.bad.length}`);
  for (const file of result.bad) console.log(`   ${file}`);
  const denominatorHolds = result.processed + result.failed.length === result.expected;
  console.log(
    `denominator holds (processed + failed == expected): ${denominatorHolds ? "yes" : "NO"}`,
  );
  return denominatorHolds && result.failed.length === 0 && result.bad.length === 0;
}

export function reportShapes(results) {
  console.log(`adversarial shapes in the module-level list: ${shapes.length}`);
  console.log(`adversarial shape ids: ${shapes.map((shape) => shape[0]).join(", ")}`);
  for (const result of results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"} ${result.id} [${result.direction}] ${result.description}`,
    );
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`adversarial shapes passed: ${results.length - failed.length}/${results.length}`);
  return failed.length === 0 && results.length === shapes.length;
}

async function main() {
  if (process.argv.includes("--self-test")) {
    process.exit((await selfTest()) ? 0 : 1);
  }

  const corpus = corruptedFiles(sourcePopulation());
  const corpusOk = reportCorpus(corpus);
  const shapeResults = await runShapes();
  const shapesOk = reportShapes(shapeResults);
  console.log(`corpus validation: ${corpusOk ? "PASS" : "FAIL"}`);
  process.exit(corpusOk && shapesOk ? 0 : 1);
}

/**
 * The positive controls of the sweep: the DETECTION path must be live, the sweep itself
 * must be able to measure, and the comparator under test must not mis-lex a nested
 * template inside an interpolation - the shape that produced the live corruption in this
 * repository.
 */
async function selfTest() {
  // POSITIVE CONTROL 1: a deliberately naive comparator (strip `//` to end of line) is run
  // through the SAME check and MUST be reported.
  const naiveSource = [
    "export function stripCommentsStringAware(source) {",
    "  return String(source)",
    '    .split("\\n")',
    "    .map((line) => {",
    '      const at = line.indexOf("//");',
    "      return at === -1 ? line : line.slice(0, at);",
    "    })",
    '    .join("\\n");',
    "}",
  ].join("\n");
  const naive = await import(`data:text/javascript,${encodeURIComponent(naiveSource)}`);
  const detected = corruptedFiles(sourcePopulation(), naive.stripCommentsStringAware);
  console.log(
    `SELF-TEST 1: a deliberately naive comparator is reported on ${detected.bad.length} file(s) - the detection path is ${detected.bad.length > 0 ? "LIVE" : "DEAD"}`,
  );
  console.log(
    `SELF-TEST 1b: the sweep itself failed on ${detected.failed.length} file(s) - the control only counts when the sweep could measure`,
  );
  for (const failure of detected.failed) {
    console.log(`   FAILED ${failure.file}: ${failure.error}`);
  }

  // POSITIVE CONTROL 2: the comparator under test must not mis-lex a nested template.
  const nested = `const s = \`\${JSON.stringify({ url: \`http://127.0.0.1:\${port}\` })}\`;\n`;
  const broken = stripCommentsStringAware(nested);
  const misLexed = broken !== nested && !parsesText(broken);
  console.log(
    `SELF-TEST 2: the comparator under test mis-lexes a nested template inside an interpolation: ${misLexed ? "YES (defect)" : "no"}`,
  );
  return detected.bad.length > 0 && detected.failed.length === 0 && !misLexed;
}

// The script runs only when it is invoked directly; importing it exposes the detection
// path so the SAME code can be pointed at a different comparator and measured.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
