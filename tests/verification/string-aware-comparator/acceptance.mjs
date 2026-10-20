// Acceptance test for the reference comment-stripping comparator.
//
// Usage: node acceptance.mjs
//
// Exits 0 only when ALL of the following hold, and prints the measurement for each:
//   1. every case in the module-level case list passes against the real comparator;
//   2. the runner evaluated exactly that list - the case count and the case ids are
//      printed, because a case that is not in the list is not evaluated and the run still
//      reports a clean sweep;
//   3. every case's direction label is one of the two accepted labels, and the assertion
//      has teeth: a wrong label is REJECTED, and a FLIPPED label makes the case FAIL, so
//      no case is an inert control that cannot fail.

import { comparePair } from "./string-aware-comparator.mjs";
import {
  assertDirection,
  cases,
  DIRECTIONS,
  evaluateAll,
  evaluateCase,
  validateExpectations,
} from "./acceptance-cases.mjs";

/** Cases that must be present, by id: the guard against a silently dropped case. */
const REQUIRED_CASE_IDS = ["A19", "A20"];

const results = await evaluateAll(comparePair);

let failures = 0;
for (const result of results) {
  if (!result.ok) failures += 1;
  const views = Object.entries(result.verdict)
    .map(([view, value]) => `${view}=${value ? "DIFF" : "SAME"}`)
    .join(" ");
  console.log(
    `${result.ok ? "PASS" : "FAIL"} ${result.id} [${result.direction}] ${result.description} (${views})`,
  );
}

console.log(`cases evaluated: ${results.length}`);
console.log(`cases in the module-level list: ${cases.length}`);
console.log(`case ids: ${results.map((result) => result.id).join(", ")}`);

// CHECK 2: the runner must have iterated the module-level list, and the cases that close
// the measured blind spots must be in it. A missing id is reported by name.
const evaluatedIds = results.map((result) => result.id);
const missingIds = REQUIRED_CASE_IDS.filter((id) => !evaluatedIds.includes(id));
const countMatches = results.length === cases.length;
console.log(
  `case list and runner agree: ${countMatches ? "yes" : "NO"} (${results.length} evaluated, ${cases.length} listed)`,
);
if (missingIds.length > 0) {
  console.log(`MISSING CASE IDS: ${missingIds.join(", ")}`);
}

// CHECK 3a: every direction label is one of the two accepted labels.
const badLabels = cases.filter((item) => !DIRECTIONS.includes(item[4])).map((item) => item[0]);
console.log(
  `direction labels valid (${DIRECTIONS.join(", ")}): ${badLabels.length === 0 ? "yes" : "NO"}`,
);
if (badLabels.length > 0) console.log(`invalid direction labels: ${badLabels.join(", ")}`);

// CHECK 3b: the label assertion has teeth - a wrong label is rejected outright.
let wrongLabelRejected = false;
try {
  assertDirection("must-flag", "probe");
} catch {
  wrongLabelRejected = true;
}
console.log(`a wrong direction label is rejected: ${wrongLabelRejected ? "yes" : "NO"}`);

// CHECK 3c: the labels are non-vacuous - a FLIPPED label must make the case fail. A case
// whose label is flipped and still passes is an inert control: it cannot fail, so it
// certifies nothing.
const inert = [];
for (const item of cases) {
  const flipped = [item[0], item[1], item[2], item[3], item[4] === "flag" ? "ignore" : "flag"];
  const result = await evaluateCase(comparePair, flipped);
  if (result.ok) inert.push(item[0]);
}
console.log(`a flipped direction label fails the case: ${inert.length === 0 ? "yes" : "NO"}`);
if (inert.length > 0) console.log(`inert cases: ${inert.join(", ")}`);

// CHECK 3d: the independently written expectation map is CONSULTED, not merely present.
// A list whose label disagrees with the recorded expectation must be rejected outright,
// because a VALID but WRONG label is what turns a must-flag case into an inert control.
let wrongExpectationRejected = false;
try {
  const tampered = cases.map((item) =>
    item[0] === "A19" ? [item[0], item[1], item[2], item[3], "ignore"] : item,
  );
  validateExpectations(tampered);
} catch {
  wrongExpectationRejected = true;
}
console.log(
  `a direction label that disagrees with the recorded expectation is rejected: ${wrongExpectationRejected ? "yes" : "NO"}`,
);

const ok =
  failures === 0 &&
  countMatches &&
  missingIds.length === 0 &&
  badLabels.length === 0 &&
  wrongLabelRejected &&
  inert.length === 0 &&
  wrongExpectationRejected;
console.log(`\nacceptance: ${results.length - failures}/${results.length} cases passed`);
process.exit(ok ? 0 : 1);
