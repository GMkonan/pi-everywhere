import { access, readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILES: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/markdown.js": { file: "markdown.js", contentType: "text/javascript; charset=utf-8" },
  "/session-list.js": { file: "session-list.js", contentType: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", contentType: "application/manifest+json" },
  "/sw.js": { file: "sw.js", contentType: "text/javascript; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", contentType: "image/svg+xml" },
};

export async function findProjectRoot(startUrl: string = import.meta.url): Promise<string> {
  let current = dirname(fileURLToPath(startUrl));
  for (let index = 0; index < 8; index += 1) {
    const candidate = resolve(current);
    try {
      await access(join(candidate, "web", "index.html"));
      return candidate;
    } catch {
      current = dirname(current);
    }
  }
  throw new Error("Could not locate web/index.html; set PI_EVERYWHERE_ROOT");
}

export async function serveStatic(pathname: string, root: string, response: ServerResponse): Promise<boolean> {
  const descriptor = FILES[pathname];
  if (!descriptor) return false;

  const body = await readFile(join(root, "web", descriptor.file));
  response.writeHead(200, {
    "content-type": descriptor.contentType,
    "content-length": body.byteLength,
    "cache-control": pathname === "/sw.js" ? "no-cache" : "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
  return true;
}
