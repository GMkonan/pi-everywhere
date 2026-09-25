import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Browser module is intentionally dependency-free JavaScript.
import { parseMarkdown, safeLinkTarget } from "../web/markdown.js";
// @ts-expect-error Browser module is intentionally dependency-free JavaScript.
import { agentActivityAt, formatActivityTime, groupAgentsByDate, sortAgentsByActivity, touchAgentActivity } from "../web/session-list.js";

test("Markdown parser recognizes common blocks without interpreting unsafe links as links", () => {
  const blocks = parseMarkdown([
    "# Heading",
    "",
    "Text with **bold**, `code`, and [safe](https://example.com).",
    "[unsafe](javascript:alert(1)) <img src=x onerror=alert(1)>",
    "",
    "- one",
    "- two",
    "",
    "```ts",
    "const value = 1;",
    "```",
    "",
    "| Name | Value |",
    "| :--- | ---: |",
    "| pi | everywhere |",
  ].join("\n"));

  assert.deepEqual(blocks.map((block: { type: string }) => block.type), [
    "heading",
    "paragraph",
    "list",
    "code",
    "table",
  ]);
  assert.equal(blocks[3].language, "ts");
  assert.equal(blocks[3].text, "const value = 1;");

  const paragraph = blocks[1].children as Array<{ type: string; text?: string; href?: string }>;
  assert.ok(paragraph.some((node) => node.type === "strong"));
  assert.ok(paragraph.some((node) => node.type === "code"));
  assert.ok(paragraph.some((node) => node.type === "link" && node.href === "https://example.com"));
  assert.equal(paragraph.some((node) => node.type === "link" && node.href?.startsWith("javascript:")), false);
  const literalText = paragraph.map((node) => node.text ?? "").join("");
  assert.match(literalText, /javascript:alert/);
  assert.match(literalText, /<img src=x onerror=alert/);
});

test("Markdown link policy permits only explicit web and mail protocols", () => {
  assert.equal(safeLinkTarget("https://example.com/path"), "https://example.com/path");
  assert.equal(safeLinkTarget("mailto:user@example.com"), "mailto:user@example.com");
  assert.equal(safeLinkTarget("javascript:alert(1)"), undefined);
  assert.equal(safeLinkTarget("data:text/html,test"), undefined);
  assert.equal(safeLinkTarget("/relative/path"), undefined);
});

test("session list activity comes from conversation entries rather than heartbeat liveness", () => {
  const older = {
    instanceId: "older",
    connectedAt: Date.parse("2030-01-01T00:00:00.000Z"),
    lastSeenAt: 99_999,
    meta: { cwd: "/older" },
    snapshot: { entries: [{ timestamp: "2024-01-01T00:00:01.000Z" }] },
  };
  const newer = {
    instanceId: "newer",
    connectedAt: 400,
    lastSeenAt: 1,
    meta: { cwd: "/newer" },
    snapshot: { entries: [{ message: { timestamp: Date.parse("2024-01-02T00:00:00.000Z") } }] },
  };

  assert.deepEqual(sortAgentsByActivity([older, newer]).map((agent: { instanceId: string }) => agent.instanceId), ["newer", "older"]);
  assert.equal(agentActivityAt(older), Date.parse("2024-01-01T00:00:01.000Z"));

  assert.equal(touchAgentActivity(older, { type: "heartbeat", timestamp: 200_000 }, 200_000), false);
  const recentActivity = Date.parse("2025-01-01T00:00:00.000Z");
  assert.equal(touchAgentActivity(older, { type: "message_start", message: { timestamp: recentActivity } }, recentActivity), true);
  assert.equal(agentActivityAt(older), recentActivity);
  assert.deepEqual(sortAgentsByActivity([older, newer]).map((agent: { instanceId: string }) => agent.instanceId), ["older", "newer"]);
});

test("session groups use calendar recency buckets and preserve newest-first order", () => {
  const now = new Date(2026, 8, 17, 12).getTime();
  const agent = (instanceId: string, timestamp: number) => ({
    instanceId,
    connectedAt: timestamp,
    meta: { cwd: `/${instanceId}` },
    snapshot: { entries: [] },
  });
  const groups = groupAgentsByDate([
    agent("older", new Date(2026, 6, 1).getTime()),
    agent("week", new Date(2026, 8, 13).getTime()),
    agent("today-old", new Date(2026, 8, 17, 8).getTime()),
    agent("month", new Date(2026, 7, 25).getTime()),
    agent("yesterday", new Date(2026, 8, 16, 18).getTime()),
    agent("today-new", new Date(2026, 8, 17, 11).getTime()),
  ], now);

  assert.deepEqual(groups.map((group: { key: string }) => group.key), ["today", "yesterday", "week", "month", "older"]);
  assert.deepEqual(groups[0].agents.map((item: { instanceId: string }) => item.instanceId), ["today-new", "today-old"]);
});

test("relative activity labels remain compact", () => {
  const now = 10 * 86_400_000;
  assert.equal(formatActivityTime(now - 20_000, now), "now");
  assert.equal(formatActivityTime(now - 5 * 60_000, now), "5m");
  assert.equal(formatActivityTime(now - 3 * 3_600_000, now), "3h");
  assert.equal(formatActivityTime(now - 2 * 86_400_000, now), "2d");
});
