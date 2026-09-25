import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PushSubscription, RequestOptions } from "web-push";
import { PushService, type PushTransport } from "../src/server/push-service.ts";

function subscription(endpoint = "https://push.example/subscription-1"): PushSubscription {
  return {
    endpoint,
    keys: {
      p256dh: "abcdefgh12345678",
      auth: "abcdefgh12345678",
    },
  };
}

function fakeTransport(send?: (value: PushSubscription, payload: string) => Promise<unknown>): PushTransport {
  return {
    generateVAPIDKeys: () => ({ publicKey: "public-key", privateKey: "private-key" }),
    setVapidDetails: () => {},
    sendNotification: (value: PushSubscription, payload: string, _options: RequestOptions) => (
      send?.(value, payload) ?? Promise.resolve({})
    ),
  };
}

test("push state is private, persistent, idempotent, and revoked by token rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-everywhere-push-"));
  const statePath = join(directory, "config", "push.json");
  try {
    const first = await PushService.load(statePath, "token-one", { transport: fakeTransport() });
    await first.subscribe(subscription());
    await first.subscribe(subscription());
    assert.equal(first.subscriptionCount, 1);

    assert.equal((await stat(join(directory, "config"))).mode & 0o777, 0o700);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.subscriptions.length, 1);
    assert.notEqual(persisted.tokenFingerprint, "token-one");

    const reloaded = await PushService.load(statePath, "token-one", { transport: fakeTransport() });
    assert.equal(reloaded.subscriptionCount, 1);
    assert.equal(reloaded.publicKey, "public-key");

    const rotated = await PushService.load(statePath, "token-two", { transport: fakeTransport() });
    assert.equal(rotated.subscriptionCount, 0);
    assert.equal(rotated.publicKey, "public-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("push service validates subscriptions and prunes expired endpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-everywhere-push-"));
  const statePath = join(directory, "push.json");
  const deliveries: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  const transport = fakeTransport(async (value, payload) => {
    deliveries.push({ endpoint: value.endpoint, payload: JSON.parse(payload) });
    if (value.endpoint.endsWith("expired")) throw { statusCode: 410 };
    return {};
  });

  try {
    const service = await PushService.load(statePath, "token", { transport });
    await assert.rejects(() => service.subscribe(subscription("http://push.example/insecure")), /HTTPS/);
    await assert.rejects(
      () => service.subscribe({ endpoint: "https://push.example/missing", keys: { p256dh: "", auth: "" } }),
      /keys/,
    );

    await service.subscribe(subscription("https://push.example/active"));
    await service.subscribe(subscription("https://push.example/expired"));
    const result = await service.notify({
      type: "agent_settled",
      instanceId: "agent-a",
      title: "Pi finished working",
      body: "A Pi session is ready.",
      url: "/?session=agent-a",
      timestamp: 123,
    });

    assert.deepEqual(result, { sent: 1, removed: 1, failed: 0 });
    assert.equal(service.subscriptionCount, 1);
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries[0]);
    assert.deepEqual(deliveries[0].payload, {
      type: "agent_settled",
      instanceId: "agent-a",
      title: "Pi finished working",
      body: "A Pi session is ready.",
      url: "/?session=agent-a",
      timestamp: 123,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
