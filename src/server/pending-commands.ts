import {
  PROTOCOL_VERSION,
  type AgentCommand,
  type CommandResult,
} from "../shared/protocol.js";

interface PendingCommand<TBrowser> {
  browser: TBrowser;
  instanceId: string;
  timer: NodeJS.Timeout;
}

export class PendingCommands<TBrowser> {
  private readonly commands = new Map<string, PendingCommand<TBrowser>>();

  constructor(
    private readonly deliver: (browser: TBrowser, result: CommandResult) => void,
    private readonly timeoutMs = 30_000,
  ) {}

  add(browser: TBrowser, command: AgentCommand): boolean {
    if (this.commands.has(command.commandId)) return false;
    const { commandId, instanceId } = command;
    const timer = setTimeout(() => {
      const pending = this.commands.get(commandId);
      if (!pending) return;
      this.commands.delete(commandId);
      this.deliver(pending.browser, failure(instanceId, commandId, "Pi command timed out"));
    }, this.timeoutMs);
    timer.unref();
    this.commands.set(command.commandId, {
      browser,
      instanceId: command.instanceId,
      timer,
    });
    return true;
  }

  resolve(result: CommandResult): boolean {
    const pending = this.commands.get(result.commandId);
    if (!pending || pending.instanceId !== result.instanceId) return false;
    clearTimeout(pending.timer);
    this.commands.delete(result.commandId);
    this.deliver(pending.browser, result);
    return true;
  }

  fail(commandId: string, error: string): boolean {
    const pending = this.commands.get(commandId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.commands.delete(commandId);
    this.deliver(pending.browser, {
      v: PROTOCOL_VERSION,
      type: "command_result",
      instanceId: pending.instanceId,
      commandId,
      ok: false,
      error,
    });
    return true;
  }

  failInstance(instanceId: string, error: string): void {
    for (const [commandId, pending] of this.commands) {
      if (pending.instanceId === instanceId) this.fail(commandId, error);
    }
  }

  removeBrowser(browser: TBrowser): void {
    for (const [commandId, pending] of this.commands) {
      if (pending.browser !== browser) continue;
      clearTimeout(pending.timer);
      this.commands.delete(commandId);
    }
  }

  dispose(): void {
    for (const pending of this.commands.values()) clearTimeout(pending.timer);
    this.commands.clear();
  }
}

function failure(instanceId: string, commandId: string, error: string): CommandResult {
  return {
    v: PROTOCOL_VERSION,
    type: "command_result",
    instanceId,
    commandId,
    ok: false,
    error,
  };
}
