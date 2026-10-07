import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appState } from "../lib/controller";
import Settings from "./Settings.svelte";

describe("Settings", () => {
  beforeEach(() => {
    appState.update((state) => ({
      ...state,
      settingsOpen: true,
      notifications: { ...state.notifications, supported: true, label: "Enable notifications" },
    }));
  });

  afterEach(() => {
    window.localStorage.removeItem("pi-everywhere-theme");
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
  });

  it("exposes connection, notification, cache, and access controls", () => {
    render(Settings);

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reconnect now/u })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable notifications" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear history cache/u })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Change device access/u })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeInTheDocument();
  });

  it("previews and persists a selected theme", async () => {
    render(Settings);

    const grove = screen.getByRole("radio", { name: /Grove/u });
    await fireEvent.click(grove);

    expect(grove).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement).toHaveAttribute("data-theme", "grove");
    expect(window.localStorage.getItem("pi-everywhere-theme")).toBe("grove");
  });
});
