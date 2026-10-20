// Mutant comparators: broken in one specific, realistic way each.
// Each exposes the same comparePair(left, right) interface as the real artefact, so the
// acceptance script can be pointed at them without modification. A mutant that the
// acceptance script PASSES is a failure mode the checker is blind to.
//
// The scanner core below is an INDEPENDENT implementation, not an import from the reference
// comparator: fixing the reference cannot silently repair a mutant. Each mutant switches
// exactly ONE behaviour off, so the case that catches a mutant is the case that targets
// its defect. A mutant that carried a second, unrelated defect would be caught by the
// wrong case, and the targeted case would then be free to rot.

import { createHash } from "node:crypto";

const TOKEN_RE =
  /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|===|!==|=>|==|!=|<=|>=|&&|\|\||\+\+|--|[^\sA-Za-z0-9_$]/g;

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

const collapse = (source) => source.replace(/\s+/g, " ").trim();
const tokensOf = (source) => source.match(TOKEN_RE) ?? [];
const digestOf = (source) =>
  createHash("sha256").update(tokensOf(source).join("\u0000")).digest("hex").slice(0, 16);

/** Build a comparator around a stripper, so each mutant differs only in what it removes. */
export function makeComparator(stripper) {
  return (left, right) => {
    const l = stripper(left);
    const r = stripper(right);
    return {
      raw_text: left !== right,
      string_aware_text: collapse(l) !== collapse(r),
      token_stream: tokensOf(l).join("|") !== tokensOf(r).join("|"),
      token_digest: digestOf(l) !== digestOf(r),
    };
  };
}

/** Index just after the closing quote of a quoted literal. */
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

/** Index just after a regex literal, or null when there is none. */
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

/** Index just after the comment that starts at `start`. */
function skipComment(text, start) {
  if (text[start + 1] === "/") {
    const newline = text.indexOf("\n", start);
    return newline === -1 ? text.length : newline;
  }
  const close = text.indexOf("*/", start + 2);
  return close === -1 ? text.length : close + 2;
}

/** Scan a template literal, recursing into its interpolations. */
function scanTemplate(text, start, options) {
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
      const interpolation = scanInterpolation(text, index + 2, options);
      out += `\${${interpolation.body}}`;
      index = interpolation.end;
      continue;
    }
    out += character;
    index += 1;
  }
  return { end: text.length, body: out };
}

/** The brace depth after reading `character`. */
function braceDepth(depth, character) {
  if (character === "{") return depth + 1;
  if (character === "}") return depth - 1;
  return depth;
}

/** Scan an interpolation body, tracking brace depth and skipping strings and comments. */
function scanInterpolation(text, start, options) {
  let out = "";
  let index = start;
  let depth = 1;
  let previous = "";
  while (index < text.length) {
    const atom = scanAtom(text, index, previous, options);
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

/**
 * Scan a comment at `index`. Returns null when there is no comment here. A block comment
 * is COPIED when the mutant under construction keeps block comments.
 */
function scanCommentAtom(text, index, options) {
  if (text[index] !== "/") return null;
  const next = text[index + 1];
  if (next !== "/" && next !== "*") return null;
  const end = skipComment(text, index);
  const keep = options.keepBlockComments && next === "*";
  return { end, text: keep ? text.slice(index, end) : "", literal: false };
}

/** Scan a quoted or a template literal at `index`. Returns null when there is none. */
function scanLiteralAtom(text, index, options) {
  const character = text[index];
  if (character === '"' || character === "'") {
    const end = scanQuoted(text, index);
    return { end, text: text.slice(index, end), literal: true };
  }
  if (character === "`" && options.templateBranch) {
    const template = scanTemplate(text, index, options);
    return { end: template.end, text: template.body, literal: true };
  }
  return null;
}

/** Scan a regex literal at `index`. Returns null when there is none. */
function scanRegexAtom(text, index, previous, options) {
  if (text[index] !== "/") return null;
  if (!options.regexBranch) return null;
  if (!REGEX_PRECEDERS.has(previous)) return null;
  const end = scanRegex(text, index);
  if (end === null) return null;
  return { end, text: text.slice(index, end), literal: true };
}

/**
 * Scan one atom: a comment, a quoted literal, a template literal or a regex literal. The
 * switches decide which of those the scanner recognises. Returns null for ordinary code.
 */
function scanAtom(text, index, previous, options) {
  return (
    scanCommentAtom(text, index, options) ??
    scanLiteralAtom(text, index, options) ??
    scanRegexAtom(text, index, previous, options)
  );
}

/** The mutant core: the reference shape with switchable behaviours. */
function scanSource(source, options) {
  const text = String(source);
  let out = "";
  let index = 0;
  let previous = "";
  while (index < text.length) {
    const atom = scanAtom(text, index, previous, options);
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

/** The full-featured core: every behaviour the reference comparator has. */
const FULL = { regexBranch: true, templateBranch: true, keepBlockComments: false };

const stripStringContents = (source) =>
  source
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");

/**
 * The stripper behind M4: the comments are removed correctly, but the CONTENTS of every
 * string literal are emptied. The file stays parseable, so this defect is invisible to a
 * check that only asks "does the stripped output still parse" - the case list is what
 * catches it. Exported so the reach of the corpus sweep can be MEASURED against the same
 * mutant the case list is measured against.
 */
export const stripsStringContents = (source) => stripStringContents(scanSource(source, FULL));

export const mutants = {
  // M1: naive line-comment stripper - cuts from the first `//` to end of line, anywhere,
  // including inside a string literal.
  M1: {
    label: "naive //-to-EOL stripper",
    comparePair: makeComparator((source) =>
      source
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n"),
    ),
  },
  // M2: naive block-comment stripper - strips /* */ only, leaves line comments in place.
  M2: {
    label: "naive /* */ stripper",
    comparePair: makeComparator((source) => source.replace(/\/\*[\s\S]*?\*\//g, "")),
  },
  // M3: no comment stripping at all - over-flags a comment-only edit.
  M3: {
    label: "no comment stripping at all",
    comparePair: makeComparator((source) => source),
  },
  // M4: strips string CONTENTS as well as comments - hides differences inside literals.
  M4: {
    label: "strips string contents",
    comparePair: makeComparator(stripsStringContents),
  },
  // M5: strips comments naively AND string contents.
  M5: {
    label: "strips comments and strings",
    comparePair: makeComparator((source) =>
      stripStringContents(
        source
          .split("\n")
          .map((line) => line.replace(/\/\/.*$/, ""))
          .join("\n")
          .replace(/\/\*[\s\S]*?\*\//g, ""),
      ),
    ),
  },
  // M6: strips TRAILING comments only - a full-line comment is left in place.
  M6: {
    label: "strips trailing comments only",
    comparePair: makeComparator((source) =>
      source
        .split("\n")
        .map((line) => (/^\s*\/\//.test(line) ? line : line.replace(/\s+\/\/.*$/, "")))
        .join("\n"),
    ),
  },
  // M7: strips FULL-LINE comments only - a trailing comment is left in place.
  M7: {
    label: "strips full-line comments only",
    comparePair: makeComparator((source) =>
      source
        .split("\n")
        .map((line) => (/^\s*\/\//.test(line) ? "" : line))
        .join("\n"),
    ),
  },
  // M8: no regex-literal branch - a `/` that is not part of `//` or `/*` is just a
  // character. A regex literal whose source ends with an escaped slash puts its closing
  // delimiter next to that slash, so the FILE TEXT contains `//` - the classic base64url
  // idiom `.replace(/\//g, "_")` - and the rest of the line is then deleted as a line
  // comment.
  M8: {
    label: "no regex-literal branch",
    comparePair: makeComparator((source) => scanSource(source, { ...FULL, regexBranch: false })),
  },
  // M9: no template-literal branch - a backtick is an ordinary character. A template
  // literal whose text contains `//` - the common `http://host/path` shape - is then
  // truncated as a line comment. The regex branch is kept so the mutant's caught-set
  // isolates the template blind spot.
  M9: {
    label: "no template-literal branch",
    comparePair: makeComparator((source) => scanSource(source, { ...FULL, templateBranch: false })),
  },
  // M10: a block comment is COPIED into the output instead of being skipped - so a real
  // block-comment edit survives normalisation and is reported as a difference. This
  // over-flags; it is the mirror image of the mutants that swallow a difference.
  M10: {
    label: "keeps block comments",
    comparePair: makeComparator((source) =>
      scanSource(source, { ...FULL, keepBlockComments: true }),
    ),
  },
};
