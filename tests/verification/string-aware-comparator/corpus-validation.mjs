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
// holding a package.json), and the tracked files are enumerated with `git ls-files`; no
// path is hardcoded and the script works from any working directory.
//
// Usage: node corpus-validation.mjs [--self-test]
//
// Writes only to a temporary directory; never mutates the repository.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/** Every tracked source file in the repository. */
export function trackedSources() {
  return execFileSync("git", ["ls-files", "*.mjs", "*.js", "*.cjs"], { cwd: repoRoot })
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
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
export function corruptedFiles(sources, strip = stripCommentsStringAware) {
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
      } catch (error) {
        failed.push({ file, error: error.message });
        continue;
      }
      processed += 1;
      if (stripped === original) continue;
      const out = join(work, file.replace(/[\\/]/g, "__"));
      writeFileSync(out, stripped);
      if (parses(absolute) && !parses(out)) bad.push(file);
    }
    return { bad, failed, processed, expected: sources.length };
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
  console.log(`tracked source files expected: ${result.expected}`);
  console.log(`tracked source files processed: ${result.processed}`);
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
    // POSITIVE CONTROL 1: the DETECTION path must be live. A deliberately naive comparator
    // (strip `//` to end of line) is run through the SAME check and MUST be reported.
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
    const detected = corruptedFiles(trackedSources(), naive.stripCommentsStringAware);
    console.log(
      `SELF-TEST 1: a deliberately naive comparator is reported on ${detected.bad.length} file(s) - the detection path is ${detected.bad.length > 0 ? "LIVE" : "DEAD"}`,
    );

    // POSITIVE CONTROL 2: the comparator under test must not mis-lex a nested template inside
    // an interpolation - the shape that produced the live corruption in this repository.
    const nested = `const s = \`\${JSON.stringify({ url: \`http://127.0.0.1:\${port}\` })}\`;\n`;
    const broken = stripCommentsStringAware(nested);
    const misLexed = broken !== nested && !parsesText(broken);
    console.log(
      `SELF-TEST 2: the comparator under test mis-lexes a nested template inside an interpolation: ${misLexed ? "YES (defect)" : "no"}`,
    );
    process.exit(detected.bad.length > 0 && !misLexed ? 0 : 1);
  }

  const sources = trackedSources();
  const corpus = corruptedFiles(sources);
  const corpusOk = reportCorpus(corpus);
  const shapeResults = await runShapes();
  const shapesOk = reportShapes(shapeResults);
  console.log(`corpus validation: ${corpusOk ? "PASS" : "FAIL"}`);
  process.exit(corpusOk && shapesOk ? 0 : 1);
}

// The script runs only when it is invoked directly; importing it exposes the detection
// path so the SAME code can be pointed at a different comparator and measured.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
