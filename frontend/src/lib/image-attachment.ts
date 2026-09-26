export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 300 * 1024;
export const MAX_IMAGE_DIMENSION = 1600;

export interface ProcessedImage {
  blob: Blob;
  data: string;
  mimeType: "image/jpeg";
}

export async function processImage(file: File): Promise<ProcessedImage> {
  const decoded = await decodeImage(file);
  try {
    let scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(decoded.width, decoded.height));
    for (let resizeAttempt = 0; resizeAttempt < 7; resizeAttempt += 1) {
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser cannot process images.");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(decoded.source, 0, 0, width, height);

      for (const quality of [0.86, 0.76, 0.66, 0.56]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob.size <= MAX_IMAGE_BYTES) {
          return { blob, data: await blobBase64(blob), mimeType: "image/jpeg" };
        }
      }
      scale *= 0.8;
    }
    throw new Error("The image could not be reduced below 300 KiB.");
  } finally {
    decoded.close?.();
  }
}

async function decodeImage(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Safari and some Android decoders support formats through <img> but not createImageBitmap.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    throw new Error("This image format could not be decoded.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("The image could not be encoded.")),
      "image/jpeg",
      quality,
    );
  });
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
