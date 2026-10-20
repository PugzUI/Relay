/** Parse one bounded JSON value while rejecting duplicate object keys. */
export function parseStrictJsonText(text, { maxBytes = 1_048_576, maxDepth = 64 } = {}) {
  if (
    typeof text !== "string" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    Buffer.byteLength(text, "utf8") > maxBytes
  ) {
    fail("JSON document is too large");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    fail("JSON nesting limit is invalid");
  }
  const state = { text, index: 0, maxDepth };
  const result = parseValue(state, 0);
  skipWhitespace(state);
  if (state.index !== text.length) {
    fail("JSON has trailing data");
  }
  return result;
}

const WHITESPACE = /[\t\n\r ]/;
const UNICODE_ESCAPE = /^[0-9a-fA-F]{4}$/;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES = '"\\/bfnrt';
const LITERALS = [
  ["true", true],
  ["false", false],
  ["null", null],
];

function fail(message) {
  throw new SyntaxError(message);
}

function skipWhitespace(state) {
  while (state.index < state.text.length && WHITESPACE.test(state.text[state.index])) {
    state.index += 1;
  }
}

function decodeString(source) {
  try {
    return JSON.parse(source);
  } catch {
    fail("JSON string is invalid");
  }
}

function readEscape(state) {
  if (state.index >= state.text.length) {
    fail("JSON escape is incomplete");
  }
  const escapeChar = state.text[state.index++];
  if (escapeChar === "u") {
    if (!UNICODE_ESCAPE.test(state.text.slice(state.index, state.index + 4))) {
      fail("JSON unicode escape is invalid");
    }
    state.index += 4;
    return;
  }
  if (!ESCAPES.includes(escapeChar)) {
    fail("JSON escape is invalid");
  }
}

function parseString(state) {
  const start = state.index++;
  while (state.index < state.text.length) {
    const code = state.text.charCodeAt(state.index++);
    if (code === 34) {
      return decodeString(state.text.slice(start, state.index));
    }
    if (code < 0x20) {
      fail("JSON string contains a control character");
    }
    if (code === 92) {
      readEscape(state);
    }
  }
  fail("JSON string is incomplete");
}

function parseValue(state, depth) {
  if (depth > state.maxDepth) {
    fail("JSON nesting is too deep");
  }
  skipWhitespace(state);
  const char = state.text[state.index];
  if (char === '"') {
    return parseString(state);
  }
  if (char === "{") {
    return parseObject(state, depth);
  }
  if (char === "[") {
    return parseArray(state, depth);
  }
  return parseLiteral(state);
}

function parseObject(state, depth) {
  state.index += 1;
  skipWhitespace(state);
  const out = {};
  if (state.text[state.index] === "}") {
    state.index += 1;
    return out;
  }
  for (;;) {
    readMember(state, out, depth);
    if (state.text[state.index] === "}") {
      state.index += 1;
      return out;
    }
    if (state.text[state.index++] !== ",") {
      fail("JSON object separator is invalid");
    }
  }
}

function readMember(state, out, depth) {
  skipWhitespace(state);
  if (state.text[state.index] !== '"') {
    fail("JSON object key is invalid");
  }
  const key = parseString(state);
  if (Object.hasOwn(out, key)) {
    fail("JSON object has a duplicate key");
  }
  skipWhitespace(state);
  if (state.text[state.index++] !== ":") {
    fail("JSON object separator is invalid");
  }
  const value = parseValue(state, depth + 1);
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  skipWhitespace(state);
}

function parseArray(state, depth) {
  state.index += 1;
  skipWhitespace(state);
  const out = [];
  if (state.text[state.index] === "]") {
    state.index += 1;
    return out;
  }
  for (;;) {
    out.push(parseValue(state, depth + 1));
    skipWhitespace(state);
    if (state.text[state.index] === "]") {
      state.index += 1;
      return out;
    }
    if (state.text[state.index++] !== ",") {
      fail("JSON array separator is invalid");
    }
  }
}

function parseLiteral(state) {
  for (const [literal, result] of LITERALS) {
    if (state.text.startsWith(literal, state.index)) {
      state.index += literal.length;
      return result;
    }
  }
  return parseNumber(state);
}

function parseNumber(state) {
  NUMBER.lastIndex = state.index;
  const match = NUMBER.exec(state.text);
  if (!match) {
    fail("JSON value is invalid");
  }
  state.index += match[0].length;
  const number = Number(match[0]);
  if (!Number.isFinite(number)) {
    fail("JSON number is not finite");
  }
  return number;
}
