const MAX_STRING_LENGTH = 100_000;
const MAX_ARRAY_LENGTH = 250;
const MAX_OBJECT_KEYS = 250;
const MAX_OBJECT_KEY_LENGTH = 250;
const MAX_DEPTH = 10;

const UNSERIALIZABLE_VALUE = "[value could not be serialized]";
const UNSERIALIZABLE_PROPERTY = "[property could not be serialized]";

/** Convert arbitrary extension and tool values into bounded JSON-safe data. */
export function toWireValue(value: unknown): unknown {
  try {
    return visit(value, 0, new WeakSet<object>());
  } catch {
    // Tool and extension values are untrusted. Serialization must never throw
    // into a Pi event handler or prevent the bridge from reconnecting.
    return UNSERIALIZABLE_VALUE;
  }
}

function visit(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  try {
    return visitUnsafe(value, depth, seen);
  } catch {
    return UNSERIALIZABLE_VALUE;
  }
}

function visitUnsafe(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    return value.length <= MAX_STRING_LENGTH
      ? value
      : `${value.slice(0, MAX_STRING_LENGTH)}\n… [truncated by pi-everywhere]`;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (depth >= MAX_DEPTH) return "[maximum serialization depth reached]";

  if (value instanceof Error) {
    return {
      name: readProperty(value, "name", depth, seen),
      message: readProperty(value, "message", depth, seen),
      stack: readProperty(value, "stack", depth, seen),
    };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString();
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength} bytes]`;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    const length = Math.min(value.length, MAX_ARRAY_LENGTH);
    for (let index = 0; index < length; index += 1) {
      result.push(readProperty(value, index, depth, seen));
    }
    if (value.length > MAX_ARRAY_LENGTH) result.push(`[${value.length - MAX_ARRAY_LENGTH} items omitted]`);
    return result;
  }

  const keys = Object.keys(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [index, key] of keys.slice(0, MAX_OBJECT_KEYS).entries()) {
    const serialized = readProperty(value, key, depth, seen);
    if (serialized === undefined) continue;
    const outputKey = boundedObjectKey(key, index, result);
    result[outputKey] = serialized;
  }
  if (keys.length > MAX_OBJECT_KEYS) result.__truncated__ = true;
  return result;
}

function boundedObjectKey(key: string, index: number, result: Record<string, unknown>): string {
  let candidate = key.length <= MAX_OBJECT_KEY_LENGTH
    ? key
    : `${key.slice(0, MAX_OBJECT_KEY_LENGTH)}… [key ${index + 1} truncated]`;
  let collision = 0;
  while (Object.hasOwn(result, candidate)) {
    collision += 1;
    candidate = `__pi_everywhere_key_${index + 1}_${collision}__`;
  }
  return candidate;
}

function readProperty(
  value: object,
  key: string | number,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  try {
    return visit(Reflect.get(value, key), depth + 1, seen);
  } catch {
    return UNSERIALIZABLE_PROPERTY;
  }
}
