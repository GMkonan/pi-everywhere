import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PROMPT_IMAGE_BYTES,
  validatePromptPayload,
} from "../src/shared/prompt.js";

function jpeg(bytes = 12): string {
  const value = Buffer.alloc(bytes, 0);
  value.set([0xff, 0xd8, 0xff]);
  return value.toString("base64");
}

test("prompt validation accepts text, images, and image-only prompts", () => {
  assert.deepEqual(validatePromptPayload({ text: " hello ", behavior: "followUp" }), {
    text: "hello",
    behavior: "followUp",
  });
  assert.deepEqual(validatePromptPayload({ images: [{ mimeType: "image/jpeg", data: jpeg() }] }), {
    images: [{ mimeType: "image/jpeg", data: jpeg() }],
  });
});

test("prompt validation rejects malformed or excessive images", () => {
  assert.throws(() => validatePromptPayload({}), /text or an image/u);
  assert.throws(() => validatePromptPayload({ images: Array.from({ length: 4 }, () => ({ mimeType: "image/jpeg", data: jpeg() })) }), /at most 3/u);
  assert.throws(() => validatePromptPayload({ images: [{ mimeType: "image/png", data: jpeg() }] }), /JPEG/u);
  assert.throws(() => validatePromptPayload({ images: [{ mimeType: "image/jpeg", data: "not-base64" }] }), /base64/u);
  assert.throws(() => validatePromptPayload({ images: [{ mimeType: "image/jpeg", data: Buffer.from("not jpeg").toString("base64") }] }), /not valid JPEG/u);
  assert.throws(() => validatePromptPayload({ images: [{ mimeType: "image/jpeg", data: jpeg(MAX_PROMPT_IMAGE_BYTES + 1) }] }), /exceeds/u);
});
