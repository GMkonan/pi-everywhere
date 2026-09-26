import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { composerState, installUiBridge } from "../lib/ui-bridge";
import Composer from "./Composer.svelte";

beforeEach(() => {
  installUiBridge();
  composerState.set({ selectedId: "agent-a", connected: true, supportsImages: true, working: false });
});

describe("Composer", () => {
  it("keeps plain Enter multiline and submits with Ctrl+Enter", async () => {
    const sendPrompt = vi.fn(() => "command-1");
    window.__PI_EVERYWHERE_SVELTE__?.bindActions({
      selectAgent: () => undefined,
      loadOlderHistory: () => undefined,
      sendPrompt,
    });
    render(Composer);
    const input = screen.getByLabelText("Message Pi");
    await fireEvent.input(input, { target: { value: "hello" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
    await fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(sendPrompt).toHaveBeenCalledWith({ text: "hello", behavior: "followUp" });
    expect(input).toHaveValue("hello");
    window.__PI_EVERYWHERE_SVELTE__?.resolvePrompt("command-1", true);
    await vi.waitFor(() => expect(input).toHaveValue(""));
  });

  it("explains unavailable image input for a text-only or stale process", async () => {
    composerState.set({ selectedId: "agent-a", connected: true, supportsImages: false, working: false });
    render(Composer);
    await fireEvent.click(screen.getByRole("button", { name: "Attach images" }));
    expect(screen.getByRole("alert")).toHaveTextContent("does not report image support");
  });
});
