import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_PENDING_PAIRINGS = 8;

interface PendingPairing {
  secret: string;
  expiresAt: number;
}

export interface PairingOffer {
  code: string;
  url: string;
  expiresAt: number;
}

export class PairingManager {
  private readonly pending = new Map<string, PendingPairing>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  create(baseUrl: unknown, now = Date.now()): PairingOffer {
    this.prune(now);
    if (this.pending.size >= MAX_PENDING_PAIRINGS) throw new PairingLimitError();
    const base = validateBaseUrl(baseUrl);
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = now + this.ttlMs;
    this.pending.set(id, { secret, expiresAt });
    const code = `${id}.${secret}`;
    const url = new URL("/", base);
    url.searchParams.set("pair", code);
    return { code, url: url.href, expiresAt };
  }

  exchange(code: unknown, now = Date.now()): boolean {
    this.prune(now);
    if (typeof code !== "string" || code.length > 128) return false;
    const separator = code.indexOf(".");
    if (separator < 1) return false;
    const id = code.slice(0, separator);
    const supplied = code.slice(separator + 1);
    const pending = this.pending.get(id);
    if (!pending || !secretsEqual(pending.secret, supplied)) return false;
    this.pending.delete(id);
    return true;
  }

  private prune(now: number): void {
    for (const [id, pairing] of this.pending) {
      if (pairing.expiresAt <= now) this.pending.delete(id);
    }
  }
}

export class PairingLimitError extends Error {
  constructor() {
    super(`At most ${MAX_PENDING_PAIRINGS} pairing offers may be active`);
    this.name = "PairingLimitError";
  }
}

function validateBaseUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 2048) throw new Error("A valid pairing base URL is required");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("A valid pairing base URL is required"); }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Pairing requires HTTPS or a loopback HTTP URL");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function secretsEqual(expected: string, supplied: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}
