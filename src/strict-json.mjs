/** Parse one bounded JSON value while rejecting duplicate object keys. */
export function parseStrictJsonText(text, { maxBytes = 1_048_576, maxDepth = 64 } = {}) {
  const fail = (message) => { throw new SyntaxError(message); };
  if (typeof text !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || Buffer.byteLength(text, "utf8") > maxBytes) fail("JSON document is too large");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) fail("JSON nesting limit is invalid");
  let i = 0;
  const ws = () => { while (i < text.length && /[\t\n\r ]/.test(text[i])) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      const c = text.charCodeAt(i++);
      if (c === 34) {
        try { return JSON.parse(text.slice(start, i)); }
        catch { fail("JSON string is invalid"); }
      }
      if (c < 0x20) fail("JSON string contains a control character");
      if (c === 92) {
        if (i >= text.length) fail("JSON escape is incomplete");
        const e = text[i++];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i, i + 4))) fail("JSON unicode escape is invalid");
          i += 4;
        } else if (!'"\\/bfnrt'.includes(e)) fail("JSON escape is invalid");
      }
    }
    fail("JSON string is incomplete");
  };
  const value = (depth) => {
    if (depth > maxDepth) fail("JSON nesting is too deep");
    ws();
    const c = text[i];
    if (c === '"') return string();
    if (c === "{") {
      i++; ws(); const out = {};
      if (text[i] === "}") { i++; return out; }
      for (;;) {
        ws(); if (text[i] !== '"') fail("JSON object key is invalid");
        const key = string();
        if (Object.hasOwn(out, key)) fail("JSON object has a duplicate key");
        ws(); if (text[i++] !== ":") fail("JSON object separator is invalid");
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true }); ws();
        if (text[i] === "}") { i++; return out; }
        if (text[i++] !== ",") fail("JSON object separator is invalid");
      }
    }
    if (c === "[") {
      i++; ws(); const out = [];
      if (text[i] === "]") { i++; return out; }
      for (;;) {
        out.push(value(depth + 1)); ws();
        if (text[i] === "]") { i++; return out; }
        if (text[i++] !== ",") fail("JSON array separator is invalid");
      }
    }
    const rest = text.slice(i);
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]]) {
      if (rest.startsWith(literal)) { i += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (match) {
      i += match[0].length; const n = Number(match[0]);
      if (!Number.isFinite(n)) fail("JSON number is not finite");
      return n;
    }
    fail("JSON value is invalid");
  };
  const result = value(0); ws();
  if (i !== text.length) fail("JSON has trailing data");
  return result;
}
