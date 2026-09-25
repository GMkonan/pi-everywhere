import { homedir } from "node:os";
import { join } from "node:path";

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (runtimeDir) return join(runtimeDir, "pi-everywhere", "bridge.sock");
  return join(homedir(), ".pi", "agent", "pi-everywhere", "bridge.sock");
}

export function defaultTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "pi-everywhere", "token");
}

export function defaultPushStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "pi-everywhere", "push.json");
}
