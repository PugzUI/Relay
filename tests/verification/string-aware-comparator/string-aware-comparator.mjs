// A string-aware reference comparator for JavaScript sources.
//
// WHAT THIS IS: a comparison oracle that ignores COMMENTS while still seeing real code
// differences. It removes line comments and block comments without touching string
// literals, template literals or regex literals, then compares the result in three
// normalised views: collapsed text, token stream and token digest.
//
// WHY IT EXISTS: a comment stripper that is not string-aware produces FALSE CLEANS - it
// reports "no difference" for two sources that differ, because a delimiter inside a
// string or a template was mistaken for the start of a comment. Two of those defects were
// measured on the real corpus of this repository, and one of them was in THIS file: the
// literal branch used to scan to the next matching delimiter, so a template literal
// containing a NESTED template inside an interpolation was mis-lexed, the rest of the
// line was deleted as a line comment, and the comparator reported "no difference" for
// sources that differ. The template scanner below recurses into `${...}` for that reason.
//
// THE RULE THAT GOVERNS THIS FILE: AN ORACLE MUST BE VALIDATED AGAINST THE CORPUS. The
// acceptance set in this directory and this oracle were shaped by the same reasoning, so
// the set cannot find the oracle's own blind spot - it passed the set while the oracle
// corrupted first-party code. corpus-validation.mjs in this directory is the check that
// can: it applies the comparator to every tracked source file in the repository and
// asserts the comment-stripped output still parses. Run it beside any change here.
//
// ACCEPTANCE (acceptance.mjs in this directory, 21 cases, all passing, plus the
// direction-label assertions and 5 division/regex ambiguity probes): MUST-FLAG a real
// difference a naive stripper could hide - inside a string literal, a template literal, a
// regex literal, a nested template inside an interpolation, or after one of those
// constructs on the same line - and MUST-IGNORE a real comment edit in every placement:
// trailing and full-line, for both the line and the block delimiter. A one-directional
// set ships a broken checker while staying blind to the whole over-flagging class.
//
// THE CASES THAT MATTER MOST, and why each is strictly necessary (a case is strictly
// necessary when the set cannot hold without it - measured by removing it and seeing a
// mutant get through):
//   A13, A14 (block comments, must-ignore)  - strictly necessary: a comparator that strips
//     `//` comments but leaves `/* */` comments verbatim passes the set without them.
//   A17a, A17b (regex, after-position)       - strictly necessary: a comparator with no
//     regex-literal branch passes the set without them, because the inside-position
//     regex cases carry no adjacent `//` in their text.
//   A19, A20 (nested template in an
//     interpolation)                          - strictly necessary: the oracle itself is the
//     mutant for this blind spot, so nothing else in the set can see it.
//   A18 (template, after-position)            - symmetry-completing, NOT strictly
//     necessary: a template-blind comparator is already caught by the inside-position
//     cases A5 and A6. It is kept so every delimiter-bearing position has both an
//     inside-position and an after-position case.
//
// WHAT ACTUALLY DECIDES DISCRIMINATION: a blind-spot comparator is detected only when its
// truncation point PRECEDES the difference, so the difference is swallowed. A case whose
// literal text carries no adjacent `//` cannot detect a `//`-blind comparator at all - the
// inside-position regex case carries `\/\/`, not `//`, so nothing is truncated there and
// the difference survives. That is why the regex position needed an extra case and the
// template position did not. Measure the position; do not assume it.
//
// EVERY DELIMITER MUST BE EXERCISED IN BOTH DIRECTIONS. The `/*` handling used to appear
// only in the must-FLAG direction, never in the must-IGNORE direction, so a comparator
// that over-flags every real block-comment edit was structurally invisible to the set.
//
// LIVENESS OF THE ACCEPTANCE SET (liveness.mjs in this directory): the set is a
// DISCRIMINATOR, not a rubber stamp. Ten broken comparators are caught and none gets
// through - a naive `//`-to-EOL stripper, a naive `/* */` stripper, no comment stripping
// at all, a stripper that eats string contents, one that eats comments AND strings, one
// that strips trailing comments only, one that strips full-line comments only, one with
// no regex-literal branch, one with no template-literal branch, and one that keeps block
// comments. Four attributions are worth keeping: the over-flagging mutants are caught
// ONLY by the MUST-IGNORE cases, the no-regex-branch mutant ONLY by the after-position
// cases, the no-template-branch mutant by the inside-position cases and A18, and the
// block-comment-keeping mutant ONLY by A13 and A14.
//
// A liveness proof is NOT a completeness proof. A caught count shows the set catches what
// it was built to catch, not that no other blind spot exists. Keep mutating until it
// stops finding holes, and report the count that got THROUGH, not the count caught. The
// count that got through so far is five, and the fifth was this oracle.
//
// KNOWN, CORRECT ASYMMETRY (case C4): for a real comment the token views report SAME
// while raw_text reports a difference. That is not a bug - the comment is genuinely
// removed, so a comment-only edit really is unchanged in the token views. Do not "fix" it.

import { createHash } from "node:crypto";

const REGEX_PRECEDERS = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "~",
  "^",
  "<",
  ">",
]);
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/** True when a `/` at this position starts a regex literal rather than a division operator. */
function regexAllowed(previous) {
  if (previous === "") return true;
  if (REGEX_PRECEDERS.has(previous)) return true;
  if (REGEX_KEYWORDS.has(previous)) return true;
  return false;
}

/** Index just after the closing quote of a quoted literal that starts at `start`. */
function scanQuoted(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

/** Index just after a regex literal that starts at `start`, or null when there is none. */
function scanRegex(text, start) {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === "[") inClass = true;
    else if (text[index] === "]") inClass = false;
    else if (text[index] === "/" && !inClass) return index + 1;
    else if (text[index] === "\n") return null;
    index += 1;
  }
  return null;
}

/** Index just after the comment that starts at `start` (a `//` or a `/*` comment). */
function skipComment(text, start) {
  if (text[start + 1] === "/") {
    const newline = text.indexOf("\n", start);
    return newline === -1 ? text.length : newline;
  }
  const close = text.indexOf("*/", start + 2);
  return close === -1 ? text.length : close + 2;
}

/**
 * Scan one atom at `index`: a comment, a quoted literal, a template literal or a regex
 * literal. Returns null when the text at `index` is ordinary code. A comment contributes no
 * text; the other three contribute their own source text.
 */
function scanAtom(text, index, previous) {
  const character = text[index];
  if (character === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
    return { end: skipComment(text, index), text: "", literal: false };
  }
  if (character === '"' || character === "'") {
    const end = scanQuoted(text, index);
    return { end, text: text.slice(index, end), literal: true };
  }
  if (character === "`") {
    const template = scanTemplate(text, index);
    return { end: template.end, text: template.body, literal: true };
  }
  if (character === "/" && regexAllowed(previous)) {
    const end = scanRegex(text, index);
    if (end !== null) return { end, text: text.slice(index, end), literal: true };
  }
  return null;
}

/**
 * Scan an interpolation body that starts at `start` (just after `${`). Tracks brace depth
 * and skips strings, nested templates and comments. Returns the index just after the
 * matching `}` and the body with its comments removed.
 */
function scanInterpolation(text, start) {
  let out = "";
  let index = start;
  let depth = 1;
  let previous = "";
  while (index < text.length) {
    const atom = scanAtom(text, index, previous);
    if (atom) {
      out += atom.text;
      index = atom.end;
      if (atom.literal) previous = "literal";
      continue;
    }
    const character = text[index];
    depth = braceDepth(depth, character);
    if (character === "}" && depth === 0) return { end: index + 1, body: out };
    out += character;
    index += 1;
    if (!/\s/.test(character)) previous = character;
  }
  return { end: text.length, body: out };
}

/** The brace depth after reading `character`. */
function braceDepth(depth, character) {
  if (character === "{") return depth + 1;
  if (character === "}") return depth - 1;
  return depth;
}

/**
 * Scan a template literal that starts at `start` (the opening backtick). Handles escapes
 * and recurses into `${...}` interpolations, because a template can contain a NESTED
 * template inside an interpolation: scanning to the next backtick would end the outer
 * template early and the rest of the line would be read as code.
 */
function scanTemplate(text, start) {
  let out = "`";
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      out += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === "`") return { end: index + 1, body: `${out}\`` };
    if (character === "$" && text[index + 1] === "{") {
      const interpolation = scanInterpolation(text, index + 2);
      out += `\${${interpolation.body}}`;
      index = interpolation.end;
      continue;
    }
    out += character;
    index += 1;
  }
  return { end: text.length, body: out };
}

/**
 * Remove comments from JavaScript source without touching string or template literals.
 * Handles: line comments, block comments, '...', "...", `...` (with escapes and nested
 * templates inside interpolations), and regex literals (with a documented heuristic for the
 * `/` vs division ambiguity).
 */
export function stripCommentsStringAware(source) {
  const text = String(source);
  let out = "";
  let index = 0;
  let previous = "";
  while (index < text.length) {
    const atom = scanAtom(text, index, previous);
    if (atom) {
      out += atom.text;
      index = atom.end;
      if (atom.literal) previous = "literal";
      continue;
    }
    const character = text[index];
    if (!/\s/.test(character)) previous = character;
    out += character;
    index += 1;
  }
  return out;
}

/** Comments removed (string-aware) and whitespace collapsed: the text comparator. */
export function normText(source) {
  return stripCommentsStringAware(source).replace(/\s+/g, " ").trim();
}

/** Token stream of the comment-stripped source: identifiers, numbers, strings, operators. */
export function tokenStream(source) {
  const text = stripCommentsStringAware(source);
  const pattern =
    /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|===|!==|=>|==|!=|<=|>=|&&|\|\||\+\+|--|[^\sA-Za-z0-9_$]/g;
  return text.match(pattern) ?? [];
}

/** sha256 of the token stream, for a digest comparator. */
export function tokenDigest(source) {
  return createHash("sha256").update(tokenStream(source).join("\u0000")).digest("hex").slice(0, 16);
}

/** Comparators over a pair of sources. `flagged` = the comparator reports a difference. */
export async function comparePair(left, right) {
  const [leftTokens, rightTokens] = [tokenStream(left), tokenStream(right)];
  const [leftDigest, rightDigest] = await Promise.all([tokenDigest(left), tokenDigest(right)]);
  return {
    raw_text: left !== right,
    string_aware_text: normText(left) !== normText(right),
    token_stream: leftTokens.join("\u0000") !== rightTokens.join("\u0000"),
    token_digest: leftDigest !== rightDigest,
  };
}
