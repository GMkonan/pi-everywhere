import { randomUUID } from "node:crypto";

const INSTANCE_ID_KEY = Symbol.for("pi-everywhere.process-instance-id");
const RUNTIME_OWNER_KEY = Symbol.for("pi-everywhere.process-runtime-owner");

type GlobalSymbolState = {
  [key: symbol]: unknown;
};

/**
 * Return an identity for the current Pi OS process that survives extension
 * module reloads. A module-local UUID would change on `/reload` and session
 * replacement even though commands still target the same live process.
 */
export function getProcessInstanceId(): string {
  const state = globalThis as GlobalSymbolState;
  const existing = state[INSTANCE_ID_KEY];
  if (typeof existing === "string") return existing;

  const instanceId = `${process.pid}-${randomUUID()}`;
  state[INSTANCE_ID_KEY] = instanceId;
  return instanceId;
}

/** Ensure only one loaded copy of the extension owns the process bridge. */
export function claimProcessRuntime(stop: () => void): () => void {
  const state = globalThis as GlobalSymbolState;
  const previous = state[RUNTIME_OWNER_KEY];
  if (isRuntimeOwner(previous)) {
    try {
      previous.stop();
    } catch {
      // A stale extension copy must not prevent the replacement from starting.
    }
  }

  const owner = { stop };
  state[RUNTIME_OWNER_KEY] = owner;
  return () => {
    if (state[RUNTIME_OWNER_KEY] === owner) delete state[RUNTIME_OWNER_KEY];
  };
}

function isRuntimeOwner(value: unknown): value is { stop: () => void } {
  return typeof value === "object" && value !== null && "stop" in value && typeof value.stop === "function";
}
