import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HealthStatus {
  ok: boolean;
  agents: number;
}

export async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ code: error.code === "ENOENT" ? 127 : 1, stdout, stderr: error.message });
    });
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function runCommandOrThrow(command: string, args: string[]): Promise<void> {
  const result = await runCommand(command, args);
  if (result.code === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
}

export async function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

export async function fetchHealth(port: number, host = "127.0.0.1"): Promise<HealthStatus | undefined> {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    if (!isRecord(value) || value.ok !== true || typeof value.agents !== "number") return undefined;
    return { ok: true, agents: value.agents };
  } catch {
    return undefined;
  }
}

export function tailscaleServeUrl(status: string, port: number): string | undefined {
  let currentUrl: string | undefined;
  for (const rawLine of status.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (/^https:\/\/\S+$/u.test(line.split(" ")[0] ?? "")) {
      currentUrl = line.split(" ")[0];
      continue;
    }
    if (currentUrl && line.includes(`proxy http://127.0.0.1:${port}`)) return currentUrl;
  }
  return undefined;
}

export async function privateFileMode(path: string): Promise<string | undefined> {
  try {
    const details = await stat(path);
    return (details.mode & 0o777).toString(8).padStart(3, "0");
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
