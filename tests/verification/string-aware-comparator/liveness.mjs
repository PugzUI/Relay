// Liveness of the acceptance script: point the SAME checker logic at broken comparators.
// The checker is live if every mutant is caught. A mutant that passes is a failure mode the
// checker is blind to.
//
// The case count and the case ids are printed, because a case that is not in the
// module-level list is not evaluated at all and the run still reports a clean sweep.
//
// THE REACH OF EACH CHECK IS MEASURED, NOT ASSUMED. A mutant that a check does not catch
// is INVISIBLE to that check, which is not the same as being harmless to the product, so
// the same mutant is run through the adversarial shape list as well and the shapes that
// catch it are named next to the cases that catch it.

import { comparePair } from "./string-aware-comparator.mjs";
import { evaluateAll } from "./acceptance-cases.mjs";
import { mutants } from "./mutant-comparators.mjs";
import { runShapes, shapes } from "./corpus-validation.mjs";

const real = await evaluateAll(comparePair);
const realFailures = real.filter((result) => !result.ok);
console.log(`cases evaluated: ${real.length}`);
console.log(`case ids: ${real.map((result) => result.id).join(", ")}`);
console.log(
  `REAL string-aware comparator  ${realFailures.length === 0 ? "PASS" : "FAIL"}  ${real.length - realFailures.length}/${real.length}`,
);
if (realFailures.length !== 0) {
  for (const result of realFailures) console.log(`   failed: ${result.id} ${result.description}`);
}

let uncaught = 0;
for (const [id, mutant] of Object.entries(mutants)) {
  const results = await evaluateAll(mutant.comparePair);
  const failures = results.filter((result) => !result.ok);
  const caught = failures.length > 0;
  if (!caught) uncaught += 1;
  const caughtIds = failures.map((result) => result.id).join(", ");
  const shapeResults = await runShapes(mutant.comparePair);
  const shapeFailures = shapeResults.filter((result) => !result.ok);
  const shapeIds = shapeFailures.map((result) => result.id).join(", ");
  console.log(
    `${caught ? "CAUGHT" : "MISSED"} ${id.padEnd(3)} ${mutant.label.padEnd(28)} ${caught ? `${failures.length}/${results.length} cases caught (${caughtIds})` : `${results.length}/${results.length} passed - UNCAUGHT`} | shapes ${shapeFailures.length}/${shapeResults.length} caught (${shapeIds || "none"})`,
  );
}

const mutantsTotal = Object.keys(mutants).length;
console.log(`\nmutants caught: ${mutantsTotal - uncaught}/${mutantsTotal}, uncaught: ${uncaught}`);
console.log(`adversarial shapes in the module-level list: ${shapes.length}`);
process.exit(realFailures.length === 0 && uncaught === 0 ? 0 : 1);
