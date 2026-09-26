import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

export const SERVICE_NAME = "pi-everywhere.service";

export interface UserServiceOptions {
  nodePath: string;
  serverPath: string;
  projectRoot: string;
  webRoot: string;
}

export function defaultUserServicePath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME ?? (env.HOME ? join(env.HOME, ".config") : undefined);
  if (!configHome) throw new Error("HOME or XDG_CONFIG_HOME is required");
  return join(configHome, "systemd", "user", SERVICE_NAME);
}

export function renderUserService(options: UserServiceOptions): string {
  return `[Unit]
Description=pi-everywhere bridge daemon
After=network.target

[Service]
Type=simple
Environment=${systemdQuote(`PI_EVERYWHERE_ROOT=${options.projectRoot}`)}
Environment=${systemdQuote(`PI_EVERYWHERE_WEB_ROOT=${options.webRoot}`)}
ExecStart=${systemdQuote(options.nodePath)} ${systemdQuote(options.serverPath)}
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target
`;
}

export async function installUserService(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function requireBuiltWeb(projectRoot: string): Promise<string> {
  const webRoot = join(projectRoot, "web-dist");
  const indexPath = join(webRoot, "index.html");
  try {
    await access(indexPath, constants.R_OK);
    return webRoot;
  } catch {
    throw new Error(`Built Svelte frontend not found at ${indexPath}. Run npm run build first.`);
  }
}

export async function requireBuiltServer(projectRoot: string): Promise<string> {
  const path = join(projectRoot, "dist", "src", "server", "index.js");
  try {
    await access(path, constants.R_OK);
    return path;
  } catch {
    throw new Error(`Built server not found at ${path}. Run npm run build first.`);
  }
}

function systemdQuote(value: string): string {
  if (/[\0\r\n]/u.test(value)) throw new Error("Systemd paths cannot contain line breaks");
  const escaped = value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `"${escaped}"`;
}
