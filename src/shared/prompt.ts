export const MAX_PROMPT_TEXT_LENGTH = 100_000;
export const MAX_PROMPT_IMAGES = 3;
export const MAX_PROMPT_IMAGE_BYTES = 300 * 1024;
export const MAX_PROMPT_IMAGE_BYTES_TOTAL = 900 * 1024;
export const PROMPT_IMAGE_MIME_TYPE = "image/jpeg" as const;

export interface PromptImage {
  mimeType: typeof PROMPT_IMAGE_MIME_TYPE;
  data: string;
}

export interface PromptPayload {
  text?: string;
  behavior?: "steer" | "followUp";
  images?: PromptImage[];
}

export function validatePromptPayload(value: unknown): PromptPayload {
  if (!isRecord(value)) throw new Error("Prompt payload is required");
  const allowed = new Set(["text", "behavior", "images"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Prompt payload contains unsupported fields");

  const text = value.text === undefined ? "" : value.text;
  if (typeof text !== "string" || text.length > MAX_PROMPT_TEXT_LENGTH) {
    throw new Error(`Prompt text must not exceed ${MAX_PROMPT_TEXT_LENGTH} characters`);
  }
  const trimmedText = text.trim();
  const behavior = value.behavior;
  if (behavior !== undefined && behavior !== "steer" && behavior !== "followUp") {
    throw new Error("Prompt delivery behavior is invalid");
  }

  const imagesValue = value.images ?? [];
  if (!Array.isArray(imagesValue) || imagesValue.length > MAX_PROMPT_IMAGES) {
    throw new Error(`A prompt may contain at most ${MAX_PROMPT_IMAGES} images`);
  }
  let totalBytes = 0;
  const images = imagesValue.map((image, index): PromptImage => {
    if (!isRecord(image)
      || Object.keys(image).some((key) => key !== "mimeType" && key !== "data")
      || image.mimeType !== PROMPT_IMAGE_MIME_TYPE
      || typeof image.data !== "string") {
      throw new Error(`Image ${index + 1} must be a JPEG attachment`);
    }
    const bytes = decodeCanonicalBase64(image.data);
    if (bytes.length > MAX_PROMPT_IMAGE_BYTES) {
      throw new Error(`Image ${index + 1} exceeds ${MAX_PROMPT_IMAGE_BYTES} bytes`);
    }
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error(`Image ${index + 1} is not valid JPEG data`);
    }
    totalBytes += bytes.length;
    return { mimeType: PROMPT_IMAGE_MIME_TYPE, data: image.data };
  });
  if (totalBytes > MAX_PROMPT_IMAGE_BYTES_TOTAL) {
    throw new Error(`Prompt images exceed ${MAX_PROMPT_IMAGE_BYTES_TOTAL} bytes in total`);
  }
  if (!trimmedText && images.length === 0) throw new Error("Prompt must contain text or an image");

  return {
    ...(trimmedText ? { text: trimmedText } : {}),
    ...(behavior ? { behavior } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

function decodeCanonicalBase64(value: string): Buffer {
  if (value.length === 0
    || value.length > Math.ceil(MAX_PROMPT_IMAGE_BYTES / 3) * 4 + 4
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("Image data is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Image data is not canonical base64");
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
