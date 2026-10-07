import { describe, expect, it } from "vitest";
import { renderMarkdown, safeLinkTarget } from "./markdown";

describe("typed Markdown renderer", () => {
  it("renders common blocks and keeps unsafe content inert", () => {
    const root = document.createElement("div");
    root.append(renderMarkdown([
      "## Heading",
      "",
      "| Name | State |",
      "| :--- | ---: |",
      "| **Pi** | `live` |",
      "",
      "[safe](https://example.com) [unsafe](javascript:alert(1)) <script>alert(2)</script>",
    ].join("\n")));

    expect(root.querySelector("h2")).toHaveTextContent("Heading");
    expect(root.querySelector("table")).toHaveTextContent("Pi");
    expect(root.querySelector("a")).toHaveAttribute("href", "https://example.com");
    expect(root.querySelectorAll("a")).toHaveLength(1);
    expect(root.querySelector("script")).toBeNull();
    expect(root).toHaveTextContent("<script>alert(2)</script>");
  });

  it("allows only explicit web and mail link targets", () => {
    expect(safeLinkTarget("mailto:user@example.com")).toBe("mailto:user@example.com");
    expect(safeLinkTarget("https://example.com/path")).toBe("https://example.com/path");
    expect(safeLinkTarget("javascript:alert(1)")).toBeUndefined();
    expect(safeLinkTarget("/relative")).toBeUndefined();
  });
});
