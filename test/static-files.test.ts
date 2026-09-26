import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { resolveStaticFile } from "../src/server/static-files.js";

const root = resolve("/tmp/pi-everywhere-web");

test("static path resolution maps the index and keeps assets inside the web root", () => {
  assert.equal(resolveStaticFile("/", root), resolve(root, "index.html"));
  assert.equal(resolveStaticFile("/assets/app-123.js", root), resolve(root, "assets/app-123.js"));
  assert.equal(resolveStaticFile("/%E0%A4%A", root), undefined);
  assert.equal(resolveStaticFile("/private.json", root), undefined);
});

test("static path resolution rejects traversal and the root directory", () => {
  assert.equal(resolveStaticFile("/../secret", root), undefined);
  assert.equal(resolveStaticFile("/%2e%2e/secret", root), undefined);
  assert.equal(resolveStaticFile("/assets/../..", root), undefined);
  assert.equal(resolveStaticFile("/\0secret", root), undefined);
});
