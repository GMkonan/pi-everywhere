import { describe, expect, it } from "vitest";
import { applyTranscriptEvent, buildTranscript, emptyTranscriptState } from "./transcript";

describe("transcript reducer", () => {
  it("rebuilds ordered history and updates tools without duplicate rows", () => {
    const state = buildTranscript({
      instanceId: "agent-a",
      historyTruncated: true,
      omittedEntries: 12,
      entries: [
        { type: "message", message: { role: "user", content: "Inspect this" } },
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              { type: "thinking", thinking: "I should inspect it." },
              { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/tmp/a" } },
              { type: "text", text: "Reading the file." },
            ],
          },
        },
        { type: "message", message: { role: "toolResult", toolCallId: "tool-1", content: "ok", isError: false } },
        { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] } },
      ],
    });

    expect(state.items.map((item) => item.type)).toEqual([
      "activity", "user", "activity", "tool", "activity", "separator", "answer",
    ]);
    const tool = state.items.find((item) => item.type === "tool");
    expect(tool).toMatchObject({ type: "tool", toolCallId: "tool-1", label: "Read", detail: "/tmp/a", status: "done" });
    expect(state.items.filter((item) => item.type === "tool")).toHaveLength(1);
    expect(state.items.at(-1)).toMatchObject({ type: "answer", text: "Done." });
  });

  it("replaces temporary streaming blocks with the finalized assistant message", () => {
    let state = buildTranscript({
      instanceId: "agent-a",
      historyTruncated: false,
      entries: [{ type: "message", message: { role: "user", content: "Hello" } }],
    });
    state = applyTranscriptEvent(state, { type: "message_start", message: { role: "assistant" } });
    state = applyTranscriptEvent(state, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Think" } });
    state = applyTranscriptEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Draft" } });

    expect(state.items.some((item) => "streaming" in item && item.streaming)).toBe(true);
    expect(state.items.filter((item) => item.type === "separator" && item.streaming)).toHaveLength(1);

    state = applyTranscriptEvent(state, {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "Think" }, { type: "text", text: "Final" }],
      },
    });

    expect(state.items.some((item) => "streaming" in item && item.streaming)).toBe(false);
    expect(state.items.at(-1)).toMatchObject({ type: "answer", text: "Final" });
    expect(state.items.filter((item) => item.type === "separator")).toHaveLength(1);
  });

  it("handles tool errors, custom entries, aborted responses, and malformed events", () => {
    let state = buildTranscript({
      instanceId: "agent-a",
      historyTruncated: false,
      entries: [
        { type: "message", message: { role: "custom", display: false, content: "hidden" } },
        { type: "message", message: { role: "custom", content: "visible" } },
        { type: "message", message: { role: "assistant", stopReason: "aborted", content: [] } },
      ],
    });
    state = applyTranscriptEvent(state, {
      type: "tool_execution_end",
      toolCallId: "missing",
      toolName: "bash",
      isError: true,
      result: { content: "failed badly" },
    });
    expect(state.items.some((item) => item.type === "activity" && item.text === "hidden")).toBe(false);
    expect(state.items.some((item) => item.type === "activity" && item.text === "visible")).toBe(true);
    expect(state.items.some((item) => item.type === "activity" && item.text === "Response stopped." && item.error)).toBe(true);
    expect(state.items.at(-1)).toMatchObject({ type: "tool", status: "error", detail: "failed badly" });
    expect(() => applyTranscriptEvent(state, { unexpected: true })).not.toThrow();
    expect(() => applyTranscriptEvent(emptyTranscriptState(), null)).not.toThrow();
  });
});
