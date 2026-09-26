import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import { buildTranscript } from "../lib/transcript";
import { transcriptState } from "../lib/ui-bridge";
import ConversationTranscript from "./ConversationTranscript.svelte";

describe("ConversationTranscript", () => {
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

  it("shows an accessible loading state before on-demand history arrives", () => {
    transcriptState.set(buildTranscript({
      instanceId: "agent-a",
      historyTruncated: false,
      entries: [],
      loading: true,
    }));

    render(ConversationTranscript);

    expect(screen.getByRole("status")).toHaveTextContent("Loading history…");
    expect(document.querySelector("#transcript")).toHaveAttribute("aria-busy", "true");
  });
});
