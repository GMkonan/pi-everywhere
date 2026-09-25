import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonLineDecoder, encodeJsonLine } from "../src/shared/framing.js";

test("JsonLineDecoder handles fragmented and combined records", () => {
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push('{"a":'), []);
  assert.deepEqual(decoder.push('1}\n{"b":2}\r\n'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(decoder.push("\n"), []);
});

test("JsonLineDecoder rejects an oversized unfinished record", () => {
  const decoder = new JsonLineDecoder(8);
  assert.throws(() => decoder.push("123456789"), /exceeded/);
});

test("encodeJsonLine uses one LF-delimited JSON record", () => {
  assert.equal(encodeJsonLine({ ok: true }), '{"ok":true}\n');
});
