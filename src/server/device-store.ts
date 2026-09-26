import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_VERSION = 1;
const MAX_DEVICES = 32;

interface StoredDevice {
  id: string;
  name: string;
  credentialHash: string;
  createdAt: number;
  lastUsedAt: number;
}

interface DeviceState {
  version: typeof STATE_VERSION;
  devices: StoredDevice[];
}

export interface PublicDevice {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface IssuedDevice extends PublicDevice {
  credential: string;
}

export class DeviceStore {
  private writeQueue = Promise.resolve();

  private constructor(
    private readonly statePath: string,
    private readonly state: DeviceState,
  ) {}

  static async load(statePath: string): Promise<DeviceStore> {
    await secureDirectory(dirname(statePath));
    let state: DeviceState;
    let shouldPersist = false;
    try {
      state = validateState(JSON.parse(await readFile(statePath, "utf8")));
      await chmod(statePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { version: STATE_VERSION, devices: [] };
      shouldPersist = true;
    }
    const store = new DeviceStore(statePath, state);
    if (shouldPersist) await store.persist();
    return store;
  }

  list(): PublicDevice[] {
    return this.state.devices
      .map(publicDevice)
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  }

  async issue(name: unknown): Promise<IssuedDevice> {
    if (this.state.devices.length >= MAX_DEVICES) throw new DeviceLimitError();
    const normalizedName = normalizeName(name);
    const credential = randomBytes(32).toString("base64url");
    const now = Date.now();
    const stored: StoredDevice = {
      id: randomUUID(),
      name: normalizedName,
      credentialHash: fingerprint(credential),
      createdAt: now,
      lastUsedAt: now,
    };
    this.state.devices.push(stored);
    await this.persist();
    return { ...publicDevice(stored), credential };
  }

  async authenticate(credential: string | null): Promise<PublicDevice | undefined> {
    if (!credential || !/^[A-Za-z0-9_-]{43}$/u.test(credential)) return undefined;
    const supplied = fingerprint(credential);
    const device = this.state.devices.find((candidate) => hashesEqual(candidate.credentialHash, supplied));
    if (!device) return undefined;
    const now = Date.now();
    if (now - device.lastUsedAt >= 60_000) {
      device.lastUsedAt = now;
      await this.persist();
    }
    return publicDevice(device);
  }

  async revoke(id: string): Promise<boolean> {
    const before = this.state.devices.length;
    this.state.devices = this.state.devices.filter((device) => device.id !== id);
    if (this.state.devices.length === before) return false;
    await this.persist();
    return true;
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

export class DeviceLimitError extends Error {
  constructor() {
    super(`At most ${MAX_DEVICES} paired devices are supported`);
    this.name = "DeviceLimitError";
  }
}

function validateState(value: unknown): DeviceState {
  if (!isRecord(value) || value.version !== STATE_VERSION || !Array.isArray(value.devices) || value.devices.length > MAX_DEVICES) {
    throw new Error("Invalid paired-device state file");
  }
  return {
    version: STATE_VERSION,
    devices: value.devices.map((device) => {
      if (!isRecord(device)
        || typeof device.id !== "string"
        || !/^[A-Za-z0-9-]{1,128}$/u.test(device.id)
        || typeof device.name !== "string"
        || typeof device.credentialHash !== "string"
        || typeof device.createdAt !== "number"
        || typeof device.lastUsedAt !== "number"
        || !/^[A-Za-z0-9_-]{43}$/u.test(device.credentialHash)) {
        throw new Error("Invalid paired device");
      }
      return {
        id: device.id,
        name: normalizeName(device.name),
        credentialHash: device.credentialHash,
        createdAt: device.createdAt,
        lastUsedAt: device.lastUsedAt,
      };
    }),
  };
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") return "Mobile device";
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ");
  return name.slice(0, 100) || "Mobile device";
}

function publicDevice(device: StoredDevice): PublicDevice {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastUsedAt: device.lastUsedAt,
  };
}

function fingerprint(credential: string): string {
  return createHash("sha256").update(credential).digest("base64url");
}

function hashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
