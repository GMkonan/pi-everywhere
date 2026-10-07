import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionListState, setControllerActionOverridesForTest } from "../lib/controller";
import type { LiveAgent } from "../lib/types";
import SessionList from "./SessionList.svelte";

function agent(instanceId: string, name: string, idle: boolean, activity: number): LiveAgent {
  return {
    instanceId,
    connectedAt: activity,
    lastActivityAt: activity,
    meta: { cwd: `/work/${name.toLowerCase()}`, idle, pid: 100, sessionName: name },
    snapshot: { entries: [] },
  };
}

describe("SessionList", () => {
  afterEach(() => setControllerActionOverridesForTest());

  it("renders live sessions, selection, activity, and routes taps through the controller", async () => {
    const selectAgent = vi.fn();
    setControllerActionOverridesForTest({ selectSession: selectAgent });
    const now = Date.now();
    sessionListState.set({
      agents: [agent("older", "Older task", true, now - 120_000), agent("working", "Working task", false, now)],
      selectedId: "older",
      syncing: false,
    });

    render(SessionList);

    const selected = screen.getByRole("button", { name: /Older task/u });
    const working = screen.getByRole("button", { name: /Working task/u });
    expect(selected).toHaveClass("selected");
    expect(working).not.toHaveClass("selected");
    expect(working).toHaveClass("working");
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(working.querySelector(".working-bars")).toBeInTheDocument();
    expect(working.querySelector(".session-pulse")).toBeInTheDocument();
    expect(document.querySelector(".session-mark")).toBeInTheDocument();
    expect(screen.queryByText("π")).not.toBeInTheDocument();

    await fireEvent.click(working);
    expect(selectAgent).toHaveBeenCalledWith("working");
  });

  it("announces synchronization and renders the empty state safely", () => {
    sessionListState.set({ agents: [], syncing: true });
    render(SessionList);

    expect(document.querySelector("#agents")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText(/No live Pi sessions/u)).toBeInTheDocument();
  });
});
