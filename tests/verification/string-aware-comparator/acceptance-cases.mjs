// Shared case list and direction logic for the comment-stripping comparator acceptance test.
// Both the acceptance script and the liveness script import from here, so the liveness
// script exercises the SAME checker logic the acceptance script uses.
//
// THE CASE LIST IS THE SINGLE SOURCE OF TRUTH. The runner iterates the module-level `cases`
// array below and NOTHING else. A case handed to the runner as an extra argument is not
// evaluated at all and the run still reports a clean sweep, so `evaluateAll` rejects extra
// arguments outright instead of dropping them.
//
// THE DIRECTION LABELS ARE EXACTLY "flag" AND "ignore". Any other value is a hard error,
// thrown when the module loads and when a case is evaluated. This is not pedantry: a
// must-flag case with a wrong label does not merely assert the wrong thing, it goes
// INERT - every label other than the exact string "flag" used to fall back to the ignore
// direction, so a mislabelled must-flag case passed against a comparator that is known to
// false-clean its pair. The green then certified a defective oracle. The acceptance script
// proves the assertion non-vacuous by flipping every label and requiring the run to fail.

/** The only accepted direction labels. */
export const DIRECTIONS = ["flag", "ignore"];

/**
 * The expected direction of each case, written INDEPENDENTLY of the tuples above.
 *
 * This map is the anchor the tuples are checked against, because a field that lives only
 * inside the tuple it justifies can be changed without changing anything that is
 * checked. A label that is VALID but WRONG - a must-flag case relabelled "ignore" -
 * would turn that case into an inert control: it can no longer fail, so it certifies
 * nothing, and the closed label set alone would not notice. The map is consulted at load
 * time, and a disagreement is a hard error.
 */
export const EXPECTED_DIRECTIONS = {
  A1: "flag",
  A2: "flag",
  A3: "flag",
  A4: "flag",
  A5: "flag",
  A6: "flag",
  A7: "flag",
  A8: "flag",
  A9a: "flag",
  A9b: "flag",
  A10: "ignore",
  A11: "flag",
  A12: "ignore",
  A13: "ignore",
  A14: "ignore",
  A17a: "flag",
  A17b: "flag",
  A18: "flag",
  A19: "flag",
  A20: "flag",
  C4: "ignore",
};

export const cases = [
  // id, description, left, right, direction
  [
    "A1",
    "// inside a string literal",
    'const s = "http://a/1";',
    'const s = "http://a/2";',
    "flag",
  ],
  ["A2", "/* inside a string literal", 'const s = "/* 1 */";', 'const s = "/* 2 */";', "flag"],
  [
    "A3",
    "// inside a regex literal",
    "const re = /https:\\/\\/x/;",
    "const re = /https:\\/\\/y/;",
    "flag",
  ],
  ["A4", "/* inside a regex literal", "const re = /\\/\\*x/;", "const re = /\\/\\*y/;", "flag"],
  [
    "A5",
    "// inside a template literal with interpolation",
    `const s = \`http://a/\${1}\`;`,
    `const s = \`http://a/\${2}\`;`,
    "flag",
  ],
  ["A6", "/* inside a template literal", "const s = `/* 1 */`;", "const s = `/* 2 */`;", "flag"],
  [
    "A7",
    "// after an escaped quote inside a string",
    'const s = "q\\" // 1";',
    'const s = "q\\" // 2";',
    "flag",
  ],
  ["A8", "*/ inside a string literal", 'const s = "a */ b 1";', 'const s = "a */ b 2";', "flag"],
  ["A9a", "division chain", "const q = total / count / 2;", "const q = total / count / 3;", "flag"],
  [
    "A9b",
    "regex literal after return",
    "function f(s){ return /ab/.test(s); }",
    "function f(s){ return /ac/.test(s); }",
    "flag",
  ],
  [
    "A11",
    "difference after a //-bearing string on the same line",
    'const u = "https://example.com/x"; const w = 1;',
    'const u = "https://example.com/x"; const w = 2;',
    "flag",
  ],
  [
    "A17a",
    "difference after a regex literal whose source ends with an escaped slash",
    "const re = /\\/\\//; const w = 1;",
    "const re = /\\/\\//; const w = 2;",
    "flag",
  ],
  [
    "A17b",
    'difference after the base64url idiom .replace(/\\//g, "_")',
    'const s = "x".replace(/\\//g, "_").replace(/=+$/g, ""); const w = 1;',
    'const s = "x".replace(/\\//g, "_").replace(/=+$/g, ""); const w = 2;',
    "flag",
  ],
  [
    "A18",
    "difference after a //-bearing template literal on the same line",
    "const s = `http://a/`; const w = 1;",
    "const s = `http://a/`; const w = 2;",
    "flag",
  ],
  [
    "A19",
    "difference after a NESTED template inside an interpolation",
    `const s = \`\${JSON.stringify({ url: \`http://127.0.0.1:\${port}\` })}\`; const w = 1;`,
    `const s = \`\${JSON.stringify({ url: \`http://127.0.0.1:\${port}\` })}\`; const w = 2;`,
    "flag",
  ],
  [
    "A20",
    "difference inside a NESTED template inside an interpolation",
    `const s = \`\${JSON.stringify({ url: \`http://127.0.0.1:\${port}\` })}\`;`,
    `const s = \`\${JSON.stringify({ url: \`http://127.0.0.1:\${port2}\` })}\`;`,
    "flag",
  ],
  ["A10", "a REAL comment (must be ignored)", "const a = 1; // note", "const a = 1;", "ignore"],
  [
    "C4",
    "a REAL comment containing a URL (must be ignored)",
    "// see https://example.com/x\nconst a = 1;",
    "const a = 1;",
    "ignore",
  ],
  [
    "A12",
    "a REAL full-line comment (must be ignored)",
    "// note\nconst a = 1;",
    "const a = 1;",
    "ignore",
  ],
  [
    "A13",
    "a REAL TRAILING block comment (must be ignored)",
    "const a = 1; /* note */",
    "const a = 1; /* other */",
    "ignore",
  ],
  [
    "A14",
    "a REAL FULL-LINE block comment (must be ignored)",
    "/* note */\nconst a = 1;",
    "const a = 1;",
    "ignore",
  ],
];

/** The comment-normalised views a case must agree on. raw_text is deliberately excluded. */
export const NORMALISED_VIEWS = ["string_aware_text", "token_stream", "token_digest"];

/**
 * Reject any direction label that is not exactly "flag" or "ignore". Throwing is the point:
 * a fallback would silently turn a must-flag case into an inert must-ignore control.
 */
export function assertDirection(direction, id = "<case>") {
  if (!DIRECTIONS.includes(direction)) {
    throw new Error(
      `case ${id}: direction must be one of ${DIRECTIONS.join(", ")}, got ${JSON.stringify(direction)}`,
    );
  }
  return direction;
}

/** Reject a case that is not a five-element tuple. */
function assertShape(item) {
  if (!Array.isArray(item) || item.length !== 5) {
    throw new Error(
      `a case must be a five-element tuple [id, description, left, right, direction], got ${JSON.stringify(item)}`,
    );
  }
  assertDirection(item[4], item[0]);
}

/** Every case in the module-level list is a valid tuple with a valid direction label. */
for (const item of cases) assertShape(item);

/**
 * The module-level list must agree with the independently written expectation map: every
 * case id needs a recorded expectation, every recorded expectation needs a case, and the
 * two must state the same direction. A disagreement is a hard error, never a fallback.
 */
export function validateExpectations(list) {
  const ids = new Set(list.map((item) => item[0]));
  for (const item of list) {
    const expected = EXPECTED_DIRECTIONS[item[0]];
    if (expected === undefined) {
      throw new Error(`case ${item[0]}: no independent expectation recorded for this id`);
    }
    if (expected !== item[4]) {
      throw new Error(
        `case ${item[0]}: direction ${JSON.stringify(item[4])} disagrees with the recorded expectation ${JSON.stringify(expected)}`,
      );
    }
  }
  for (const id of Object.keys(EXPECTED_DIRECTIONS)) {
    if (!ids.has(id)) {
      throw new Error(`case ${id}: an expectation is recorded but there is no such case`);
    }
  }
  return list;
}

validateExpectations(cases);

/**
 * Evaluate one case against a comparePair implementation.
 * A "flag" case passes only if every normalised view reports a difference.
 * An "ignore" case passes only if every normalised view reports "same".
 */
export async function evaluateCase(comparePair, item) {
  assertShape(item);
  const [id, description, left, right, direction] = item;
  const verdict = await comparePair(left, right);
  const reported = NORMALISED_VIEWS.map((view) => verdict[view]);
  const ok = direction === "flag" ? reported.every(Boolean) : reported.every((value) => !value);
  return { id, description, direction, ok, verdict };
}

/**
 * Evaluate the whole module-level case list against one comparePair implementation.
 * Extra arguments are REJECTED, not dropped: a case that is not in the list above is not
 * evaluated, and a run that silently ignores it still reports a clean sweep.
 */
export async function evaluateAll(comparePair, ...extra) {
  if (extra.length > 0) {
    throw new Error(
      `evaluateAll iterates the module-level case list (${cases.length} cases); ${extra.length} extra argument(s) were supplied. Add the case to "cases" instead.`,
    );
  }
  const results = [];
  for (const item of cases) results.push(await evaluateCase(comparePair, item));
  return results;
}
