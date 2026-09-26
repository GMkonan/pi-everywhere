import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeviceStore } from "../src/server/device-store.js";
import { PairingManager } from "../src/server/pairing.js";

test("pairing offers are HTTPS, short-lived, and single-use", () => {
  const pairings = new PairingManager(1000);
  const offer = pairings.create("https://phone.example.ts.net/path?old=true", 100);
  const url = new URL(offer.url);
  assert.equal(url.origin, "https://phone.example.ts.net");
  assert.equal(url.pathname, "/");
  assert.equal(url.searchParams.get("pair"), offer.code);
  assert.equal(offer.expiresAt, 1100);
  assert.equal(pairings.exchange(offer.code, 1099), true);
  assert.equal(pairings.exchange(offer.code, 1099), false);

  const expired = pairings.create("http://127.0.0.1:8484", 2000);
  assert.equal(pairings.exchange(expired.code, 3000), false);
  assert.throws(() => pairings.create("http://public.example.com", 3001), /HTTPS/u);
});

test("device credentials are hashed, persistent, private, and revocable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-everywhere-devices-"));
  const statePath = join(directory, "config", "devices.json");
  try {
    const store = await DeviceStore.load(statePath);
    const issued = await store.issue("  Chrome\nPWA on Android  ");
    assert.equal(issued.name, "Chrome PWA on Android");
    assert.equal((await store.authenticate(issued.credential))?.id, issued.id);
    assert.equal(await store.authenticate("invalid"), undefined);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "config"))).mode & 0o777, 0o700);

    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.devices.length, 1);
    assert.equal(persisted.devices[0].credential, undefined);
    assert.notEqual(persisted.devices[0].credentialHash, issued.credential);

    const reloaded = await DeviceStore.load(statePath);
    assert.equal((await reloaded.authenticate(issued.credential))?.id, issued.id);
    assert.equal(await reloaded.revoke(issued.id), true);
    assert.equal(await reloaded.authenticate(issued.credential), undefined);
    assert.equal(await reloaded.revoke(issued.id), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
