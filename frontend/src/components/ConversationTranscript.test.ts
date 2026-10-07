import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { setControllerActionOverridesForTest, transcriptState } from "../lib/controller";
import { applyTranscriptEvent, buildTranscript } from "../lib/transcript";
import ConversationTranscript from "./ConversationTranscript.svelte";

describe("ConversationTranscript", () => {
  afterEach(() => setControllerActionOverridesForTest());
  it("renders conversation semantics and safe Markdown without HTML injection", () => {
    transcriptState.set(buildTranscript({
      instanceId: "agent-a",
      historyTruncated: false,
      entries: [
        { type: "message", message: { role: "user", content: "<script>alert(1)</script>" } },
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "[safe](https://example.com) [unsafe](javascript:alert(1))" }],
          },
        },
      ],
    }));

    render(ConversationTranscript);

    expect(screen.getByText("You")).toBeInTheDocument();
    expect(document.querySelector("script")).not.toBeInTheDocument();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/u)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "safe" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: "unsafe" })).not.toBeInTheDocument();
    expect(document.querySelector("#transcript")).toHaveAttribute("aria-live", "polite");
  });

  it("loads older history through the controller", async () => {
    let requested = "";
    setControllerActionOverridesForTest({ loadOlderHistory: (instanceId) => { requested = instanceId; } });
    transcriptState.set(buildTranscript({
      instanceId: "agent-a",
      historyTruncated: false,
      entries: [],
      hasOlder: true,
      canLoadOlder: true,
    }));

    render(ConversationTranscript);
    await fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    expect(requested).toBe("agent-a");
  });

  it("shows an accessible loading state before on-demand history arrives", () => {
    transcriptState.set(buildTranscript({
      instanceId: "agent-a",
      historyTruncated: false,
      entries: [],
      loading: true,
    }));

    render(ConversationTranscript);

    expect(screen.getByRole("status")).toHaveTextContent("Loading history");
    expect(document.querySelector(".history-loader")).toBeInTheDocument();
    expect(document.querySelector("#transcript")).toHaveAttribute("aria-busy", "true");
  });

  it("offers a retry when history loading times out", async () => {
    let requested = "";
    setControllerActionOverridesForTest({ selectSession: (instanceId) => { requested = instanceId; } });
    transcriptState.set(buildTranscript({
      instanceId: "agent-a",
      historyTruncated: false,
      entries: [],
      loading: false,
      loadError: "The connection did not return history in time.",
    }));

    render(ConversationTranscript);
    expect(screen.getByRole("alert")).toHaveTextContent("History stopped loading");
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(requested).toBe("agent-a");
  });

  it("does not jump to the latest message while the reader is scrolled up", async () => {
    transcriptState.set(buildTranscript({
      instanceId: "agent-a",
      historyTruncated: false,
      entries: [{ type: "message", message: { role: "user", content: "Earlier message" } }],
    }));
    render(ConversationTranscript);

    const transcript = document.querySelector<HTMLDivElement>("#transcript")!;
    let height = 2_000;
    let top = 0;
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, get: () => 500 },
      scrollHeight: { configurable: true, get: () => height },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => { top = Math.min(value, height - 500); },
      },
    });
    await tick();
    await tick();

    transcript.scrollTop = 900;
    await fireEvent.scroll(transcript);
    height = 2_200;
    transcriptState.set(applyTranscriptEvent(get(transcriptState), {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "New reply" }] },
    }));
    await tick();
    await tick();

    expect(transcript.scrollTop).toBe(900);
    expect(screen.getByText("New reply")).toBeInTheDocument();
  });
});
