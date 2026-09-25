import assert from "node:assert/strict";
import { test } from "node:test";
import { PendingCommands } from "../src/server/pending-commands.js";
import type { AgentCommand, CommandResult } from "../src/shared/protocol.js";

function command(commandId: string, instanceId = "agent"): AgentCommand {
  return {
    v: 1,
    type: "command",
    instanceId,
    commandId,
    command: "snapshot",
  };
}

test("pending commands deliver extension results only to the originating browser", () => {
  const deliveries: Array<{ browser: string; result: CommandResult }> = [];
  const pending = new PendingCommands<string>((browser, result) => deliveries.push({ browser, result }));

  assert.equal(pending.add("browser-a", command("command-1")), true);
  assert.equal(pending.resolve({
    v: 1,
    type: "command_result",
    instanceId: "agent",
    commandId: "command-1",
    ok: true,
  }), true);

  assert.deepEqual(deliveries.map(({ browser }) => browser), ["browser-a"]);
  pending.dispose();
});

test("pending commands reject duplicate IDs and ignore mismatched instances", () => {
  const deliveries: CommandResult[] = [];
  const pending = new PendingCommands<string>((_browser, result) => deliveries.push(result));

  assert.equal(pending.add("browser-a", command("duplicate", "agent-a")), true);
  assert.equal(pending.add("browser-b", command("duplicate", "agent-b")), false);
  assert.equal(pending.resolve({
    v: 1,
    type: "command_result",
    instanceId: "agent-b",
    commandId: "duplicate",
    ok: true,
  }), false);
  assert.equal(deliveries.length, 0);
  assert.equal(pending.fail("duplicate", "disconnected"), true);
  assert.equal(deliveries[0]?.instanceId, "agent-a");
  assert.equal(deliveries[0]?.ok, false);
});

test("pending commands clear browser and instance ownership", () => {
  const deliveries: Array<{ browser: string; result: CommandResult }> = [];
  const pending = new PendingCommands<string>((browser, result) => deliveries.push({ browser, result }));
  pending.add("browser-a", command("a-1", "agent-a"));
  pending.add("browser-b", command("b-1", "agent-b"));

  pending.removeBrowser("browser-a");
  pending.failInstance("agent-a", "offline");
  pending.failInstance("agent-b", "offline");

  assert.deepEqual(deliveries.map(({ browser }) => browser), ["browser-b"]);
  pending.dispose();
});

test("pending commands fail after their acknowledgement timeout", async () => {
  const deliveries: CommandResult[] = [];
  const pending = new PendingCommands<string>((_browser, delivered) => deliveries.push(delivered), 10);
  pending.add("browser", command("slow"));

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(deliveries[0]?.ok, false);
  assert.equal(deliveries[0]?.error, "Pi command timed out");
  pending.dispose();
});
