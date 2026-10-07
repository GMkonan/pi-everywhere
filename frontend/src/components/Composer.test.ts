import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerState, promptResult, setControllerActionOverridesForTest } from "../lib/controller";
import Composer from "./Composer.svelte";

beforeEach(() => {
  promptResult.set(undefined);
  composerState.set({ selectedId: "agent-a", connected: true, supportsImages: true, working: false });
});

afterEach(() => setControllerActionOverridesForTest());

describe("Composer", () => {
  it("keeps plain Enter multiline and submits with Ctrl+Enter", async () => {
    const sendPrompt = vi.fn(() => "command-1");
    setControllerActionOverridesForTest({ sendPrompt });
    render(Composer);
    const input = screen.getByLabelText("Message Pi");
    await fireEvent.input(input, { target: { value: "hello" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
    await fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(sendPrompt).toHaveBeenCalledWith({ text: "hello", behavior: "followUp" });
    expect(input).toHaveValue("hello");
    promptResult.set({ commandId: "command-1", ok: true });
    await vi.waitFor(() => expect(input).toHaveValue(""));
  });

  it("grows smoothly without switching the control grid when text wraps", async () => {
    render(Composer);
    const input = screen.getByLabelText("Message Pi");
    const form = document.querySelector("#prompt-form");
    let scrollHeight = 52;
    Object.defineProperty(input, "scrollHeight", { configurable: true, get: () => scrollHeight });

    await fireEvent.input(input, { target: { value: "Short message" } });
    await vi.waitFor(() => expect(input).toHaveStyle({ height: "52px" }));
    expect(form).not.toHaveClass("composer-has-attachments");

    scrollHeight = 78;
    await fireEvent.input(input, { target: { value: "A longer message that wraps onto a second visual line" } });
    await vi.waitFor(() => expect(input).toHaveStyle({ height: "78px" }));
    expect(form).not.toHaveClass("composer-has-attachments");
  });

  it("keeps independent drafts when switching between live sessions", async () => {
    render(Composer);
    const input = screen.getByLabelText("Message Pi");

    await fireEvent.input(input, { target: { value: "draft for A" } });
    composerState.set({ selectedId: "agent-b", connected: true, supportsImages: true, working: false });
    await vi.waitFor(() => expect(input).toHaveValue(""));
    await fireEvent.input(input, { target: { value: "draft for B" } });

    composerState.set({ selectedId: "agent-a", connected: true, supportsImages: true, working: false });
    await vi.waitFor(() => expect(input).toHaveValue("draft for A"));
    composerState.set({ selectedId: "agent-b", connected: true, supportsImages: true, working: false });
    await vi.waitFor(() => expect(input).toHaveValue("draft for B"));
  });

  it("offers a full-screen editor once the input reaches its height limit", async () => {
    render(Composer);
    const input = screen.getByLabelText("Message Pi");
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 240 });
    await fireEvent.input(input, { target: { value: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight" } });

    const expand = await screen.findByRole("button", { name: "Open full-screen editor" });
    await fireEvent.click(expand);
    expect(document.querySelector("#prompt-form")).toHaveClass("composer-expanded");
    expect(screen.getByRole("button", { name: "Exit full-screen editor" })).toHaveAttribute("aria-expanded", "true");

    await fireEvent.keyDown(input, { key: "Escape" });
    expect(document.querySelector("#prompt-form")).not.toHaveClass("composer-expanded");
  });

  it("explains unavailable image input for a text-only or stale process", async () => {
    composerState.set({ selectedId: "agent-a", connected: true, supportsImages: false, working: false });
    render(Composer);
    await fireEvent.click(screen.getByRole("button", { name: "Attach images" }));
    expect(screen.getByRole("alert")).toHaveTextContent("does not report image support");
  });
});
