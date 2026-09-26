#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import QRCode from "qrcode";
import { defaultTokenPath } from "../shared/paths.js";
import { findProjectRoot } from "../server/static-files.js";
import {
  fetchHealth,
  findExecutable,
  privateFileMode,
  runCommand,
  runCommandOrThrow,
  tailscaleServeUrl,
} from "./diagnostics.js";
import {
  SERVICE_NAME,
  defaultUserServicePath,
  installUserService,
  renderUserService,
  requireBuiltServer,
  requireBuiltWeb,
} from "./service.js";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);

try {
  if (command === "serve") {
    await import("../server/index.js");
  } else if (command === "setup") {
    await setup(args);
  } else if (command === "status") {
    await status();
  } else if (command === "doctor") {
    await doctor();
  } else if (command === "pair") {
    await pair(args);
  } else if (command === "devices") {
    await devices();
  } else if (command === "revoke") {
    await revoke(args);
  } else if (["help", "--help", "-h"].includes(command)) {
    printHelp();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`pi-everywhere: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function setup(options: string[]): Promise<void> {
  const unknown = options.filter((option) => !["--tailscale", "--legacy-web"].includes(option));
  if (unknown.length > 0) throw new Error(`Unknown setup option: ${unknown.join(", ")}`);
  if (process.platform !== "linux") throw new Error("Automated service setup currently supports Linux with systemd only");

  const port = configuredPort();
  const projectRoot = await findProjectRoot(import.meta.url);
  const serverPath = await requireBuiltServer(projectRoot);
  const webRoot = options.includes("--legacy-web") ? join(projectRoot, "web") : await requireBuiltWeb(projectRoot);
  const nodePath = await findExecutable("node");
  const systemctl = await findExecutable("systemctl");
  const pi = await findExecutable("pi");
  if (!nodePath) throw new Error("Node.js was not found in PATH");
  if (!systemctl) throw new Error("systemctl was not found in PATH");
  if (!pi) throw new Error("Pi was not found in PATH");

  const serviceActive = (await runCommand(systemctl, ["--user", "is-active", "--quiet", SERVICE_NAME])).code === 0;
  const existingHealth = await fetchHealth(port);
  if (existingHealth && !serviceActive) {
    throw new Error(
      `A daemon is already listening on port ${port} outside ${SERVICE_NAME}. Stop it, then rerun setup.`,
    );
  }

  console.log("Installing the Pi extension package…");
  await runCommandOrThrow(pi, ["install", projectRoot]);

  const servicePath = defaultUserServicePath();
  await installUserService(servicePath, renderUserService({ nodePath, serverPath, projectRoot, webRoot }));
  await runCommandOrThrow(systemctl, ["--user", "daemon-reload"]);
  await runCommandOrThrow(systemctl, ["--user", "enable", SERVICE_NAME]);
  await runCommandOrThrow(systemctl, ["--user", "restart", SERVICE_NAME]);

  let health = await waitForHealth(port, 8_000);
  if (!health) throw new Error(`The service started but http://127.0.0.1:${port}/health did not become ready`);
  if (health.agents === 0) health = await waitForHealth(port, 2_000, true) ?? health;

  const tailscale = await findExecutable("tailscale");
  let remoteUrl: string | undefined;
  if (tailscale && options.includes("--tailscale")) {
    await runCommandOrThrow(tailscale, ["serve", "--bg", String(port)]);
  }
  if (tailscale) {
    const serveStatus = await runCommand(tailscale, ["serve", "status"]);
    if (serveStatus.code === 0) remoteUrl = tailscaleServeUrl(serveStatus.stdout, port);
  }

  console.log(`\n✓ ${SERVICE_NAME} is enabled and running (${health.agents} live Pi process${health.agents === 1 ? "" : "es"}).`);
  console.log("✓ The Pi extension package is installed. Existing Pi TUIs can load it with /reload.");
  if (remoteUrl) {
    console.log(`✓ Phone URL: ${remoteUrl}`);
  } else if (tailscale) {
    console.log(`\nPhone access is not configured. Run:\n  tailscale serve --bg ${port}`);
  } else {
    console.log("\nTailscale was not found. Install it before enabling private phone access.");
  }
  console.log(`Temporary MVP token: ${defaultTokenPath()}`);
}

async function status(): Promise<void> {
  const port = configuredPort();
  const systemctl = await findExecutable("systemctl");
  const servicePath = defaultUserServicePath();
  const enabled = systemctl
    ? (await runCommand(systemctl, ["--user", "is-enabled", "--quiet", SERVICE_NAME])).code === 0
    : false;
  const active = systemctl
    ? (await runCommand(systemctl, ["--user", "is-active", "--quiet", SERVICE_NAME])).code === 0
    : false;
  const health = await fetchHealth(port);
  const tailscale = await findExecutable("tailscale");
  let remoteUrl: string | undefined;
  if (tailscale) {
    const result = await runCommand(tailscale, ["serve", "status"]);
    if (result.code === 0) remoteUrl = tailscaleServeUrl(result.stdout, port);
  }

  console.log(`Service file: ${servicePath}`);
  console.log(`Enabled:     ${enabled ? "yes" : "no"}`);
  console.log(`Active:      ${active ? "yes" : "no"}`);
  console.log(`HTTP health: ${health ? `ready (${health.agents} live)` : "unavailable"}`);
  console.log(`Phone URL:   ${remoteUrl ?? "not configured"}`);
  if (!active || !health) process.exitCode = 1;
}

async function doctor(): Promise<void> {
  const projectRoot = await findProjectRoot(import.meta.url);
  const port = configuredPort();
  const checks: Array<{ level: "ok" | "warn" | "error"; text: string }> = [];
  checks.push(Number(process.versions.node.split(".")[0]) >= 22
    ? { level: "ok", text: `Node.js ${process.versions.node}` }
    : { level: "error", text: `Node.js 22+ is required; found ${process.versions.node}` });

  const pi = await findExecutable("pi");
  if (!pi) {
    checks.push({ level: "error", text: "Pi is not available in PATH" });
  } else {
    const packages = await runCommand(pi, ["list"]);
    checks.push(packages.code === 0 && packages.stdout.includes(projectRoot)
      ? { level: "ok", text: "Pi extension package is installed" }
      : { level: "warn", text: `Pi package does not list ${projectRoot}; run pi install ${projectRoot}` });
  }

  const systemctl = await findExecutable("systemctl");
  if (!systemctl) {
    checks.push({ level: "error", text: "systemctl is not available in PATH" });
  } else {
    const enabled = (await runCommand(systemctl, ["--user", "is-enabled", "--quiet", SERVICE_NAME])).code === 0;
    const active = (await runCommand(systemctl, ["--user", "is-active", "--quiet", SERVICE_NAME])).code === 0;
    checks.push(enabled
      ? { level: "ok", text: `${SERVICE_NAME} is enabled` }
      : { level: "warn", text: `${SERVICE_NAME} is not enabled` });
    checks.push(active
      ? { level: "ok", text: `${SERVICE_NAME} is active` }
      : { level: "error", text: `${SERVICE_NAME} is not active` });
  }

  const health = await fetchHealth(port);
  checks.push(health
    ? { level: "ok", text: `Daemon health is ready with ${health.agents} live Pi process${health.agents === 1 ? "" : "es"}` }
    : { level: "error", text: `Daemon health is unavailable on 127.0.0.1:${port}` });

  const tokenMode = await privateFileMode(defaultTokenPath());
  checks.push(tokenMode === "600"
    ? { level: "ok", text: "Browser credential file mode is 0600" }
    : tokenMode
      ? { level: "error", text: `Browser credential file mode is ${tokenMode}, expected 600` }
      : { level: "warn", text: "Browser credential has not been created yet" });

  const tailscale = await findExecutable("tailscale");
  if (!tailscale) {
    checks.push({ level: "warn", text: "Tailscale is not installed; private phone access is unavailable" });
  } else {
    const statusResult = await runCommand(tailscale, ["status", "--json"]);
    let online = false;
    try {
      const value = JSON.parse(statusResult.stdout) as { BackendState?: unknown; Self?: { Online?: unknown } };
      online = statusResult.code === 0 && value.BackendState === "Running" && value.Self?.Online === true;
    } catch {
      online = false;
    }
    checks.push(online
      ? { level: "ok", text: "Tailscale is online" }
      : { level: "warn", text: "Tailscale is installed but not online" });
    const serveResult = await runCommand(tailscale, ["serve", "status"]);
    const remoteUrl = serveResult.code === 0 ? tailscaleServeUrl(serveResult.stdout, port) : undefined;
    checks.push(remoteUrl
      ? { level: "ok", text: `Tailscale Serve routes ${remoteUrl} to the daemon` }
      : { level: "warn", text: `Tailscale Serve is not routing port ${port}` });
  }

  for (const check of checks) {
    const marker = check.level === "ok" ? "✓" : check.level === "warn" ? "!" : "✗";
    console.log(`${marker} ${check.text}`);
  }
  if (checks.some((check) => check.level === "error")) process.exitCode = 1;
}

async function pair(options: string[]): Promise<void> {
  if (options.length > 0) throw new Error(`Unknown pair option: ${options.join(", ")}`);
  const port = configuredPort();
  const tailscale = await findExecutable("tailscale");
  let baseUrl: string | undefined;
  if (tailscale) {
    const result = await runCommand(tailscale, ["serve", "status"]);
    if (result.code === 0) baseUrl = tailscaleServeUrl(result.stdout, port);
  }
  if (!baseUrl) throw new Error(`Tailscale Serve is not routing port ${port}; run tailscale serve --bg ${port}`);

  const response = await adminFetch("/api/admin/pairings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl }),
  });
  const result = await response.json() as { url?: unknown; expiresAt?: unknown; error?: unknown };
  if (!response.ok || typeof result.url !== "string" || typeof result.expiresAt !== "number") {
    throw new Error(typeof result.error === "string" ? result.error : `Pairing request failed (${response.status})`);
  }
  console.log(await QRCode.toString(result.url, { type: "terminal", small: true }));
  console.log(`Open or scan:\n${result.url}`);
  console.log(`Expires: ${new Date(result.expiresAt).toLocaleTimeString()}`);
}

async function devices(): Promise<void> {
  const response = await adminFetch("/api/admin/devices");
  const result = await response.json() as { devices?: Array<{ id: string; name: string; createdAt: number; lastUsedAt: number }>; error?: unknown };
  if (!response.ok || !Array.isArray(result.devices)) {
    throw new Error(typeof result.error === "string" ? result.error : `Device request failed (${response.status})`);
  }
  if (result.devices.length === 0) {
    console.log("No paired devices.");
    return;
  }
  for (const device of result.devices) {
    console.log(`${device.id}  ${device.name}  last used ${new Date(device.lastUsedAt).toLocaleString()}`);
  }
}

async function revoke(options: string[]): Promise<void> {
  const requested = options[0];
  if (!requested || options.length !== 1) throw new Error("Usage: pi-everywhere revoke <device-id-or-prefix>");
  const listResponse = await adminFetch("/api/admin/devices");
  const list = await listResponse.json() as { devices?: Array<{ id: string }> };
  const matches = (list.devices ?? []).filter((device) => device.id === requested || device.id.startsWith(requested));
  if (matches.length === 0) throw new Error(`No paired device matches ${requested}`);
  if (matches.length > 1) throw new Error(`Device prefix ${requested} is ambiguous`);
  const id = matches[0]?.id;
  if (!id) throw new Error("Device could not be resolved");
  const response = await adminFetch(`/api/admin/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Device revocation failed (${response.status})`);
  console.log(`Revoked device ${id}.`);
}

async function adminFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const credential = (await readFile(defaultTokenPath(), "utf8")).trim();
  return await fetch(`http://127.0.0.1:${configuredPort()}${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      ...(options.headers ?? {}),
      authorization: `Bearer ${credential}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
}

async function waitForHealth(port: number, timeoutMs: number, requireAgent = false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port);
    if (health && (!requireAgent || health.agents > 0)) return health;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

function configuredPort(): number {
  const port = Number.parseInt(process.env.PI_EVERYWHERE_PORT ?? "8484", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid PI_EVERYWHERE_PORT");
  return port;
}

function printHelp(): void {
  console.log(`pi-everywhere

Usage:
  pi-everywhere setup [--tailscale] [--legacy-web]
                                      Install the Pi package and systemd user service
  pi-everywhere status               Show service, daemon, and phone-access state
  pi-everywhere doctor               Diagnose local setup problems
  pi-everywhere pair                 Show a short-lived phone pairing QR code
  pi-everywhere devices              List paired devices
  pi-everywhere revoke <device-id>   Revoke a device and its notifications
  pi-everywhere serve                Run the daemon in the foreground
`);
}
