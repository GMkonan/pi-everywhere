import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOrCreateToken, tokensEqual } from "../src/server/auth.js";

test("loadOrCreateToken creates and reuses a private token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-everywhere-auth-"));
  const path = join(directory, "config", "token");
  try {
    const first = await loadOrCreateToken(path);
    const second = await loadOrCreateToken(path);
    assert.equal(first, second);
    assert.ok(first.length >= 32);
    assert.equal((await readFile(path, "utf8")).trim(), first);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    await chmod(join(directory, "config"), 0o755);
    assert.equal(await loadOrCreateToken(path), first);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "config"))).mode & 0o777, 0o700);
    assert.equal(tokensEqual(first, first), true);
    assert.equal(tokensEqual(first, `${first}x`), false);
    assert.equal(tokensEqual(first, null), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
