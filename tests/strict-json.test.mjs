import test from "node:test";
import assert from "node:assert/strict";
import { parseStrictJsonText } from "../src/strict-json.mjs";

test("strict JSON shares duplicate-key, depth, and UTF-8 byte checks", () => {
  const parsed = parseStrictJsonText('{"__proto__":{"ok":true},"value":"雪"}', { maxBytes: 64, maxDepth: 2 });
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal(parsed.__proto__.ok, true);
  assert.equal(parsed.value, "雪");
  assert.throws(() => parseStrictJsonText('{"a":1,"\\u0061":2}'), /duplicate key/);
  assert.throws(() => parseStrictJsonText("[[0]]", { maxDepth: 1 }), /nesting/);
  assert.throws(() => parseStrictJsonText('"雪"', { maxBytes: 4 }), /too large/);
  assert.equal(parseStrictJsonText('"\\u0000"'), "\0");
});
