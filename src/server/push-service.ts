import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import webPush, { type PushSubscription, type RequestOptions } from "web-push";

const STATE_VERSION = 1;
const MAX_SUBSCRIPTIONS = 16;
const MAX_ENDPOINT_LENGTH = 4096;
const MAX_KEY_LENGTH = 1024;

interface StoredSubscription extends PushSubscription {
  createdAt: number;
}

interface PushState {
  version: typeof STATE_VERSION;
  tokenFingerprint: string;
  vapid: {
    publicKey: string;
    privateKey: string;
  };
  subscriptions: StoredSubscription[];
}

export interface PushPayload {
  type: "agent_settled";
  instanceId: string;
  title: string;
  body: string;
  url: string;
  timestamp: number;
}

export interface PushTransport {
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: PushSubscription, payload: string, options: RequestOptions): Promise<unknown>;
}

const defaultTransport: PushTransport = {
  generateVAPIDKeys: () => webPush.generateVAPIDKeys(),
  setVapidDetails: (subject, publicKey, privateKey) => webPush.setVapidDetails(subject, publicKey, privateKey),
  sendNotification: (subscription, payload, options) => webPush.sendNotification(subscription, payload, options),
};

export class PushService {
  private writeQueue = Promise.resolve();

  private constructor(
    private readonly statePath: string,
    private readonly state: PushState,
    private readonly transport: PushTransport,
  ) {}

  static async load(
    statePath: string,
    browserToken: string,
    options: { transport?: PushTransport; subject?: string } = {},
  ): Promise<PushService> {
    const transport = options.transport ?? defaultTransport;
    const fingerprint = tokenFingerprint(browserToken);
    await secureDirectory(dirname(statePath));

    let state: PushState;
    let shouldPersist = false;
    try {
      const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
      state = validateState(parsed);
      await chmod(statePath, 0o600);
      if (state.tokenFingerprint !== fingerprint) {
        state.tokenFingerprint = fingerprint;
        state.subscriptions = [];
        shouldPersist = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = {
        version: STATE_VERSION,
        tokenFingerprint: fingerprint,
        vapid: transport.generateVAPIDKeys(),
        subscriptions: [],
      };
      shouldPersist = true;
    }

    transport.setVapidDetails(
      options.subject ?? process.env.PI_EVERYWHERE_VAPID_SUBJECT ?? "mailto:pi-everywhere@example.invalid",
      state.vapid.publicKey,
      state.vapid.privateKey,
    );
    const service = new PushService(statePath, state, transport);
    if (shouldPersist) await service.persist();
    return service;
  }

  get publicKey(): string {
    return this.state.vapid.publicKey;
  }

  get subscriptionCount(): number {
    return this.state.subscriptions.length;
  }

  async subscribe(value: unknown): Promise<void> {
    const subscription = validateSubscription(value);
    const existing = this.state.subscriptions.findIndex((item) => item.endpoint === subscription.endpoint);
    const stored: StoredSubscription = { ...subscription, createdAt: Date.now() };
    if (existing >= 0) this.state.subscriptions[existing] = stored;
    else {
      if (this.state.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new PushSubscriptionLimitError();
      this.state.subscriptions.push(stored);
    }
    await this.persist();
  }

  async unsubscribe(endpoint: unknown): Promise<void> {
    if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) {
      throw new Error("Invalid push endpoint");
    }
    const before = this.state.subscriptions.length;
    this.state.subscriptions = this.state.subscriptions.filter((item) => item.endpoint !== endpoint);
    if (this.state.subscriptions.length !== before) await this.persist();
  }

  async notify(payload: PushPayload): Promise<{ sent: number; removed: number; failed: number }> {
    const subscriptions = [...this.state.subscriptions];
    const encoded = JSON.stringify(payload);
    const expired = new Set<string>();
    let sent = 0;
    let failed = 0;

    await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await this.transport.sendNotification(subscription, encoded, {
          TTL: 3_600,
          urgency: "normal",
          timeout: 10_000,
        });
        sent += 1;
      } catch (error) {
        const statusCode = getStatusCode(error);
        if (statusCode === 404 || statusCode === 410) expired.add(subscription.endpoint);
        else failed += 1;
      }
    }));

    if (expired.size > 0) {
      this.state.subscriptions = this.state.subscriptions.filter((item) => !expired.has(item.endpoint));
      await this.persist();
    }
    return { sent, removed: expired.size, failed };
  }

  private persist(): Promise<void> {
    const content = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, content, { mode: 0o600 });
      await rename(temporaryPath, this.statePath);
      await chmod(this.statePath, 0o600);
    });
    return this.writeQueue;
  }
}

export class PushSubscriptionLimitError extends Error {
  constructor() {
    super(`At most ${MAX_SUBSCRIPTIONS} notification subscriptions are supported`);
    this.name = "PushSubscriptionLimitError";
  }
}

function validateState(value: unknown): PushState {
  if (!isRecord(value) || value.version !== STATE_VERSION || typeof value.tokenFingerprint !== "string" || !validateFingerprint(value.tokenFingerprint)) {
    throw new Error("Invalid push state file");
  }
  if (!isRecord(value.vapid) || typeof value.vapid.publicKey !== "string" || typeof value.vapid.privateKey !== "string") {
    throw new Error("Invalid VAPID keys in push state file");
  }
  if (!Array.isArray(value.subscriptions) || value.subscriptions.length > MAX_SUBSCRIPTIONS) {
    throw new Error("Invalid subscriptions in push state file");
  }
  return {
    version: STATE_VERSION,
    tokenFingerprint: value.tokenFingerprint,
    vapid: { publicKey: value.vapid.publicKey, privateKey: value.vapid.privateKey },
    subscriptions: value.subscriptions.map((subscription) => {
      const validated = validateSubscription(subscription);
      const createdAt = isRecord(subscription) && typeof subscription.createdAt === "number" ? subscription.createdAt : Date.now();
      return { ...validated, createdAt };
    }),
  };
}

function validateSubscription(value: unknown): PushSubscription {
  if (!isRecord(value) || typeof value.endpoint !== "string" || !isRecord(value.keys)) {
    throw new Error("Invalid push subscription");
  }
  if (value.endpoint.length === 0 || value.endpoint.length > MAX_ENDPOINT_LENGTH) throw new Error("Invalid push endpoint");
  let endpoint: URL;
  try { endpoint = new URL(value.endpoint); }
  catch { throw new Error("Invalid push endpoint"); }
  if (endpoint.protocol !== "https:") throw new Error("Push endpoint must use HTTPS");

  const p256dh = value.keys.p256dh;
  const auth = value.keys.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string" || !validKey(p256dh) || !validKey(auth)) {
    throw new Error("Invalid push subscription keys");
  }
  return { endpoint: endpoint.href, keys: { p256dh, auth } };
}

function validKey(value: string): boolean {
  return value.length >= 8 && value.length <= MAX_KEY_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

function validateFingerprint(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function tokenFingerprint(token: string): string {
  const fingerprint = createHash("sha256").update(token).digest("base64url");
  if (!validateFingerprint(fingerprint)) throw new Error("Could not fingerprint browser token");
  return fingerprint;
}

function getStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
