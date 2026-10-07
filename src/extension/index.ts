import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BridgeClient } from "./bridge-client.ts";
import { defaultSocketPath } from "../shared/paths.ts";
import type { AgentCommand, AgentMeta, AgentSnapshot } from "../shared/protocol.ts";
import { claimProcessRuntime, getProcessInstanceId } from "./process-identity.ts";
import { buildBoundedSnapshot } from "./snapshot.ts";
import { validatePromptPayload } from "../shared/prompt.ts";

const STATUS_KEY = "pi-everywhere";

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
      supportsImages: model?.input.includes("image") === true,
      thinkingLevel: activeContext.thinkingLevel ?? "off",
      idle: activeContext.isIdle(),
    };
  };

  const buildSnapshot = (): AgentSnapshot => {
    if (!activeContext) throw new Error("Pi session is not active");
    return buildBoundedSnapshot(buildMeta(), activeContext.sessionManager.getBranch());
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

    const payload = validatePromptPayload(command.payload);
    const images = payload.images ?? [];
    if (images.length > 0 && activeContext.model?.input.includes("image") !== true) {
      throw new Error("The selected model does not support image input");
    }
    const content = images.length > 0
      ? [
          ...(payload.text ? [{ type: "text" as const, text: payload.text }] : []),
          ...images.map((image) => ({ type: "image" as const, mimeType: image.mimeType, data: image.data })),
        ]
      : payload.text ?? "";

    if (activeContext.isIdle()) {
      pi.sendUserMessage(content);
    } else {
      pi.sendUserMessage(content, {
        deliverAs: payload.behavior === "steer" ? "steer" : "followUp",
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
        const indicator = connected
          ? ctx.ui.theme.fg("success", "[•ᴗ•]")
          : `${ctx.ui.theme.fg("error", "[")}${ctx.ui.theme.fg("warning", "•︵•")}${ctx.ui.theme.fg("error", "]")}`;
        ctx.ui.setStatus(STATUS_KEY, indicator);
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
