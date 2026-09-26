import { access, readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FILES = new Set([
  "index.html",
  "app.js",
  "markdown.js",
  "session-list.js",
  "styles.css",
  "manifest.webmanifest",
  "sw.js",
  "icon.svg",
]);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
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

export async function serveStatic(pathname: string, projectRoot: string, response: ServerResponse): Promise<boolean> {
  const configuredRoot = process.env.PI_EVERYWHERE_WEB_ROOT;
  const staticRoot = resolve(configuredRoot ?? join(projectRoot, "web"));
  const filePath = resolveStaticFile(pathname, staticRoot);
  if (!filePath) return false;

  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()];
  if (!contentType) return false;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return false;
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": body.byteLength,
      "cache-control": pathname === "/sw.js" ? "no-cache" : "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(body);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function resolveStaticFile(pathname: string, staticRoot: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); }
  catch { return undefined; }
  if (decoded.includes("\0")) return undefined;
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (!ROOT_FILES.has(requested) && !requested.startsWith("assets/")) return undefined;
  const candidate = resolve(staticRoot, requested);
  const fromRoot = relative(staticRoot, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || resolve(staticRoot) === candidate) {
    return undefined;
  }
  return candidate;
}
