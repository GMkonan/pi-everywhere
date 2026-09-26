import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tailscaleServeUrl } from "../src/cli/diagnostics.js";
import {
  defaultUserServicePath,
  installUserService,
  renderUserService,
} from "../src/cli/service.js";

test("systemd service uses quoted absolute paths and a private umask", () => {
  const unit = renderUserService({
    nodePath: "/home/user/a node/bin/node",
    serverPath: "/home/user/100% ready/dist/server.js",
    projectRoot: "/home/user/100% ready",
  });

  assert.doesNotMatch(unit, /WorkingDirectory/u);
  assert.match(unit, /Environment="PI_EVERYWHERE_ROOT=\/home\/user\/100%% ready"/u);
  assert.match(unit, /ExecStart="\/home\/user\/a node\/bin\/node" "\/home\/user\/100%% ready\/dist\/server\.js"/u);
  assert.match(unit, /Restart=on-failure/u);
  assert.match(unit, /UMask=0077/u);
});

test("service path follows XDG configuration conventions", () => {
  assert.equal(
    defaultUserServicePath({ XDG_CONFIG_HOME: "/tmp/config" }),
    "/tmp/config/systemd/user/pi-everywhere.service",
  );
  assert.equal(
    defaultUserServicePath({ HOME: "/home/test" }),
    "/home/test/.config/systemd/user/pi-everywhere.service",
  );
  assert.throws(() => defaultUserServicePath({}), /HOME or XDG_CONFIG_HOME/u);
});

test("service installation is atomic and private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-everywhere-cli-"));
  const path = join(directory, "nested", "pi-everywhere.service");
  try {
    await installUserService(path, "unit contents\n");
    assert.equal(await readFile(path, "utf8"), "unit contents\n");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "nested"))).mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Tailscale Serve URL parser selects the route for the daemon port", () => {
  const status = `https://phone.example.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8484

https://phone.example.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:18473
`;
  assert.equal(tailscaleServeUrl(status, 8484), "https://phone.example.ts.net");
  assert.equal(tailscaleServeUrl(status, 18473), "https://phone.example.ts.net:8443");
  assert.equal(tailscaleServeUrl(status, 9999), undefined);
});
