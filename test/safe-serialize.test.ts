import assert from "node:assert/strict";
import { test } from "node:test";
import { toWireValue } from "../src/extension/safe-serialize.js";

test("toWireValue handles circular data and non-JSON primitives", () => {
  const input: Record<string, unknown> = {
    big: 10n,
    error: new Error("boom"),
    infinite: Number.POSITIVE_INFINITY,
  };
  input.self = input;
  const output = toWireValue(input) as Record<string, unknown>;

  assert.equal(output.big, "10");
  assert.equal(output.self, "[circular]");
  assert.equal(output.infinite, "Infinity");
  assert.equal((output.error as Record<string, unknown>).name, "Error");
  assert.equal((output.error as Record<string, unknown>).message, "boom");
  assert.doesNotThrow(() => JSON.stringify(output));
});

test("toWireValue bounds strings, errors, arrays, objects, and depth", () => {
  const largeError = new Error("m".repeat(110_000));
  largeError.stack = "s".repeat(110_000);
  const manyKeys = Object.fromEntries(
    Array.from({ length: 300 }, (_, index) => [`key-${index}`, index]),
  );
  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let index = 0; index < 12; index += 1) {
    const child: Record<string, unknown> = {};
    deep.child = child;
    deep = child;
  }

  const output = toWireValue({
    text: "x".repeat(110_000),
    error: largeError,
    array: Array.from({ length: 300 }, (_, index) => index),
    object: manyKeys,
    deep: root,
  }) as Record<string, unknown>;
  const error = output.error as Record<string, unknown>;
  const array = output.array as unknown[];
  const object = output.object as Record<string, unknown>;

  assert.match(output.text as string, /truncated by pi-everywhere/);
  assert.match(error.message as string, /truncated by pi-everywhere/);
  assert.match(error.stack as string, /truncated by pi-everywhere/);
  assert.equal(array.length, 251);
  assert.equal(array.at(-1), "[50 items omitted]");
  assert.equal(object.__truncated__, true);
  assert.equal(Object.keys(object).length, 251);
  assert.match(JSON.stringify(output), /maximum serialization depth reached/);
});

test("toWireValue bounds oversized object property names", () => {
  const oversizedKey = "key".repeat(400_000);
  const output = toWireValue({ [oversizedKey]: "kept" }) as Record<string, unknown>;
  const [boundedKey] = Object.keys(output);

  assert.ok(boundedKey);
  assert.ok(boundedKey.length < 300);
  assert.match(boundedKey, /key 1 truncated/);
  assert.equal(output[boundedKey], "kept");
  assert.ok(Buffer.byteLength(JSON.stringify(output), "utf8") < 1_000);
});

test("toWireValue never throws for invalid dates or hostile object properties", () => {
  const input = Object.defineProperty({ safe: "kept" }, "broken", {
    enumerable: true,
    get() {
      throw new Error("getter exploded");
    },
  });
  const hostileProxy = new Proxy({}, {
    ownKeys() {
      throw new Error("enumeration exploded");
    },
  });

  const output = toWireValue({
    invalidDate: new Date(Number.NaN),
    input,
    hostileProxy,
  }) as Record<string, unknown>;
  const serializedInput = output.input as Record<string, unknown>;

  assert.equal(output.invalidDate, "[Invalid Date]");
  assert.equal(serializedInput.safe, "kept");
  assert.equal(serializedInput.broken, "[property could not be serialized]");
  assert.equal(output.hostileProxy, "[value could not be serialized]");
  assert.doesNotThrow(() => JSON.stringify(output));
});
