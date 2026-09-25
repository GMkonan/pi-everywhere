import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BridgeClient } from "./bridge-client.ts";
import { defaultSocketPath } from "../shared/paths.ts";
import type { AgentCommand, AgentMeta, AgentSnapshot } from "../shared/protocol.ts";
import { claimProcessRuntime, getProcessInstanceId } from "./process-identity.ts";
import { toWireValue } from "./safe-serialize.ts";

const STATUS_KEY = "pi-everywhere";
const MAX_HISTORY_ENTRIES = 200;
const MAX_HISTORY_BYTES = 1_500_000;

export default function piEverywhere(pi: ExtensionAPI) {
  const instanceId = getProcessInstanceId();
  let activeContext: ExtensionContext | undefined;
  let bridge: BridgeClient | undefined;
  let releaseRuntimeOwnership: (() => void) | undefined;

  const stopBridge = (): void => {
    const currentBridge = bridge;
    bridge = undefined;
    releaseRuntimeOwnership?.();
    releaseRuntimeOwnership = undefined;
    currentBridge?.stop();
  };

  const buildMeta = (): AgentMeta => {
    if (!activeContext) throw new Error("Pi session is not active");
    const manager = activeContext.sessionManager;
    const sessionFile = manager.getSessionFile();
    const sessionName = pi.getSessionName();
    const model = activeContext.model;

    return {
      instanceId,
      pid: process.pid,
      cwd: activeContext.cwd,
      sessionId: manager.getSessionId(),
      ...(sessionFile ? { sessionFile } : {}),
      ...(sessionName ? { sessionName } : {}),
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
      thinkingLevel: activeContext.thinkingLevel ?? "off",
      idle: activeContext.isIdle(),
    };
  };

  const buildSnapshot = (): AgentSnapshot => {
    if (!activeContext) throw new Error("Pi session is not active");
    const branch = activeContext.sessionManager.getBranch();
    const candidates = toWireValue(branch.slice(-MAX_HISTORY_ENTRIES)) as unknown[];
    const entries: unknown[] = [];
    let bytes = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const entry = candidates[index];
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (bytes + entryBytes > MAX_HISTORY_BYTES) break;
      entries.unshift(entry);
      bytes += entryBytes;
    }
    const omittedEntries = branch.length - entries.length;
    return {
      meta: buildMeta(),
      entries,
      capturedAt: Date.now(),
      ...(omittedEntries > 0 ? { historyTruncated: true, omittedEntries } : {}),
    };
  };

  const handleCommand = async (command: AgentCommand): Promise<void> => {
    if (!activeContext || !bridge) throw new Error("Pi session is not active");
    if (command.instanceId !== instanceId) throw new Error("Command targets another Pi process");

    if (command.command === "snapshot") {
      if (!bridge.sendSnapshot()) throw new Error("Snapshot could not be sent");
      bridge.sendCommandResult(command.commandId, true);
      return;
    }

    if (command.command === "abort") {
      await activeContext.abort();
      bridge.sendCommandResult(command.commandId, true);
      return;
    }

    const text = command.payload?.text?.trim();
    if (!text) throw new Error("Prompt text is required");

    if (activeContext.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, {
        deliverAs: command.payload?.behavior === "steer" ? "steer" : "followUp",
      });
    }
    bridge.sendCommandResult(command.commandId, true);
  };

  pi.on("session_start", (_event, ctx) => {
    stopBridge();
    activeContext = ctx;
    const nextBridge = new BridgeClient({
      socketPath: process.env.PI_EVERYWHERE_SOCKET ?? defaultSocketPath(),
      instanceId,
      getSnapshot: buildSnapshot,
      onCommand: handleCommand,
      onStatus: (connected) => {
        if (activeContext !== ctx) return;
        ctx.ui.setStatus(STATUS_KEY, connected ? "everywhere: connected" : "everywhere: offline");
      },
    });
    bridge = nextBridge;
    releaseRuntimeOwnership = claimProcessRuntime(stopBridge);
    nextBridge.start();
  });

  pi.on("session_shutdown", () => {
    stopBridge();
    activeContext = undefined;
  });

  pi.on("agent_start", (event) => bridge?.sendEvent(event));
  pi.on("agent_end", (event) => bridge?.sendEvent(event));
  pi.on("turn_start", (event) => bridge?.sendEvent(event));
  pi.on("turn_end", (event) => bridge?.sendEvent(event));
  pi.on("message_start", (event) => bridge?.sendEvent(event));
  pi.on("message_update", (event) => bridge?.sendEvent(event));
  pi.on("message_end", (event) => bridge?.sendEvent(event));
  pi.on("tool_execution_start", (event) => bridge?.sendEvent(event));
  pi.on("tool_execution_update", (event) => bridge?.sendEvent(event));
  pi.on("tool_execution_end", (event) => bridge?.sendEvent(event));
  pi.on("session_compact", (event) => bridge?.sendEvent(event));

  pi.on("agent_settled", (event) => {
    bridge?.sendEvent(event);
    bridge?.sendSnapshot();
  });

  pi.on("session_info_changed", (event) => {
    bridge?.sendEvent(event);
    bridge?.sendSnapshot();
  });
  pi.on("model_select", (event) => {
    bridge?.sendEvent(event);
    bridge?.sendSnapshot();
  });
  pi.on("thinking_level_select", (event) => {
    bridge?.sendEvent(event);
    bridge?.sendSnapshot();
  });
}
