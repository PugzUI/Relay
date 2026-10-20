// TOP-LEVEL ENTRY for the string-aware comment-stripping comparator verification unit.
//
// The unit itself lives under tests/verification/string-aware-comparator/, and the
// "tests/*.test.mjs" glob that `npm test` runs does not reach into that directory - a
// verification unit nobody runs is not verification. This file is the CI-visible door to
// the unit: it runs the SAME module-level case list, the SAME mutant set and the SAME
// corpus sweep that the unit's own scripts run, as node:test assertions.
//
// The corpus sweep stays inside ONE test so its counts stay visible in the test output,
// and the sweep's own denominator assertion is kept: the processed and the failed counts
// must add up to the enumerated file count, or the sweep is looking at a different
// population than the one it reports. The positive control stays with it: a sweep that
// cannot see anything would also be green.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECTIONS,
  EXPECTED_DIRECTIONS,
  cases,
  evaluateAll,
  evaluateCase,
  validateExpectations,
} from "./verification/string-aware-comparator/acceptance-cases.mjs";
import { comparePair } from "./verification/string-aware-comparator/string-aware-comparator.mjs";
import { mutants } from "./verification/string-aware-comparator/mutant-comparators.mjs";
import {
  corruptedFiles,
  reportCorpus,
  reportShapes,
  runShapes,
  shapes,
  sourcePopulation,
} from "./verification/string-aware-comparator/corpus-validation.mjs";

/**
 * The sizes of the three populations this entry checks, pinned so that a silent removal is
 * a failing test rather than a smaller green. A deliberate change updates them here.
 */
const CASE_COUNT = 21;
const MUTANT_COUNT = 10;
const SHAPE_COUNT = 17;

/** The naive comparator of the positive control: cut from the first `//` to end of line. */
function naiveStrip(source) {
  return source
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

test("acceptance: the module-level case list passes against the reference comparator", async (t) => {
  const results = await evaluateAll(comparePair);
  t.diagnostic(`cases evaluated: ${results.length}`);
  t.diagnostic(`case ids: ${results.map((result) => result.id).join(", ")}`);
  assert.equal(results.length, cases.length, "the runner and the module-level list disagree");
  assert.equal(results.length, CASE_COUNT, "the case list changed size");
  const failed = results.filter((result) => !result.ok);
  assert.deepEqual(
    failed.map((result) => `${result.id} (${result.direction})`),
    [],
    "cases failed against the reference comparator",
  );
});

test("acceptance: the direction gate is driven by the direction field", async (t) => {
  const flipped = [];
  for (const [id, description, left, right, direction] of cases) {
    const other = direction === "flag" ? "ignore" : "flag";
    const result = await evaluateCase(comparePair, [id, description, left, right, other]);
    flipped.push(`${id} -> ${other}`);
    assert.equal(result.ok, false, `case ${id} still passed with its direction label flipped`);
  }
  t.diagnostic(`direction labels flipped: ${flipped.length}`);
  await assert.rejects(
    () =>
      evaluateCase(comparePair, [
        "A1",
        "outside the closed set",
        cases[0][2],
        cases[0][3],
        "maybe",
      ]),
    /direction must be one of/,
    "a direction label outside the closed set was accepted",
  );
  const mislabelled = cases.map((item) => [
    item[0],
    item[1],
    item[2],
    item[3],
    item[4] === "flag" ? "ignore" : "flag",
  ]);
  assert.throws(
    () => validateExpectations(mislabelled),
    /disagrees with the recorded expectation/,
    "a valid but wrong direction label was accepted",
  );
  for (const item of cases)
    assert.ok(DIRECTIONS.includes(item[4]), `case ${item[0]} has an unknown label`);
  assert.deepEqual(
    Object.keys(EXPECTED_DIRECTIONS).sort(),
    cases.map((item) => item[0]).sort(),
    "the recorded expectation map and the case list disagree on their ids",
  );
});

test("liveness: every mutant comparator is caught by the case list", async (t) => {
  const entries = Object.entries(mutants);
  assert.equal(entries.length, MUTANT_COUNT, "the mutant population changed size");
  const uncaught = [];
  for (const [id, mutant] of entries) {
    const results = await evaluateAll(mutant.comparePair);
    const caught = results.filter((result) => !result.ok).map((result) => result.id);
    t.diagnostic(
      `mutant ${id} (${mutant.label}): ${caught.length}/${results.length} cases caught (${caught.join(", ") || "none"})`,
    );
    if (caught.length === 0) uncaught.push(id);
  }
  assert.deepEqual(uncaught, [], "a mutant comparator got through the case list");

  // A comparator that strips nothing at all must be caught by exactly the must-ignore
  // cases: those are the cases whose whole purpose is to see a real comment.
  const ignoreIds = cases.filter((item) => item[4] === "ignore").map((item) => item[0]);
  const stripper = entries.find(([, mutant]) => mutant.label === "no comment stripping at all");
  assert.ok(stripper, "the comparator that strips nothing is missing from the mutant population");
  const stripperResults = await evaluateAll(stripper[1].comparePair);
  const stripperCaught = stripperResults.filter((result) => !result.ok).map((result) => result.id);
  assert.deepEqual(
    [...stripperCaught].sort(),
    [...ignoreIds].sort(),
    "the must-ignore cases are not the ones that catch a comparator that strips nothing",
  );
  t.diagnostic(
    `a comparator that strips nothing passes ${stripperResults.length - stripperCaught.length} of ${stripperResults.length} cases`,
  );
});

test("corpus: every source file of the population survives the stripper and every shape passes", async (t) => {
  const population = sourcePopulation();
  assert.ok(population.files.length > 0, "no source files were enumerated");
  t.diagnostic(`population: ${population.name}, ${population.files.length} JavaScript file(s)`);
  const result = corruptedFiles(population);
  reportCorpus(result);
  assert.equal(
    result.population,
    population.name,
    "the sweep reported a different population than the one it enumerated",
  );
  assert.deepEqual(
    result.failed.map((entry) => `${entry.file}: ${entry.error}`),
    [],
    "a file of the population could not be transformed",
  );
  assert.deepEqual(
    result.bad,
    [],
    "a file of the population has a comment-stripped output that does not parse",
  );
  assert.equal(
    result.processed + result.failed.length,
    result.expected,
    "the sweep's denominator does not hold",
  );

  // POSITIVE CONTROL: the detection path must be live. A deliberately naive comparator is
  // run through the SAME check and must be reported.
  const naive = corruptedFiles(population, naiveStrip);
  assert.ok(
    naive.bad.length > 0,
    "the corpus sweep did not report a deliberately naive comparator",
  );
  t.diagnostic(`positive control: a naive comparator is reported on ${naive.bad.length} file(s)`);

  const shapeResults = await runShapes();
  reportShapes(shapeResults);
  assert.equal(shapeResults.length, SHAPE_COUNT, "the adversarial shape register changed size");
  assert.equal(
    shapeResults.length,
    shapes.length,
    "the shape runner and the shape register disagree",
  );
  assert.deepEqual(
    shapeResults.filter((entry) => !entry.ok).map((entry) => entry.id),
    [],
    "an adversarial shape failed",
  );
});
