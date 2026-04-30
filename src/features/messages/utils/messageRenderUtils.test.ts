import { describe, expect, it } from "vitest";
import type { ConversationItem } from "../../../types";
import {
  buildMessageEntries,
  buildToolSummary,
  statusToneFromText,
} from "./messageRenderUtils";

function makeToolItem(
  overrides: Partial<Extract<ConversationItem, { kind: "tool" }>>,
): Extract<ConversationItem, { kind: "tool" }> {
  return {
    id: "tool-1",
    kind: "tool",
    toolType: "webSearch",
    title: "Web search",
    detail: "codex monitor",
    status: "completed",
    output: "",
    ...overrides,
  };
}

describe("messageRenderUtils", () => {
  it("renders web search as searching while in progress", () => {
    const summary = buildToolSummary(makeToolItem({ status: "inProgress" }), "");
    expect(summary.label).toBe("searching");
    expect(summary.value).toBe("codex monitor");
  });

  it("renders mcp search calls as searching while in progress", () => {
    const summary = buildToolSummary(
      makeToolItem({
        toolType: "mcpToolCall",
        title: "Tool: web / search_query",
        detail: '{\n  "query": "codex monitor"\n}',
        status: "inProgress",
      }),
      "",
    );
    expect(summary.label).toBe("searching");
    expect(summary.value).toBe("codex monitor");
  });

  it("classifies camelCase inProgress as processing", () => {
    expect(statusToneFromText("inProgress")).toBe("processing");
  });

  it("renders collab tool calls with nickname and role", () => {
    const summary = buildToolSummary(
      makeToolItem({
        toolType: "collabToolCall",
        title: "Collab: wait",
        detail: "From thread-parent → thread-child",
        status: "completed",
        output: "Robie [explorer]: completed",
        collabReceivers: [
          {
            threadId: "thread-child",
            nickname: "Robie",
            role: "explorer",
          },
        ],
      }),
      "",
    );
    expect(summary.label).toBe("waited for");
    expect(summary.value).toBe("Robie [explorer]");
    expect(summary.output).toContain("Robie [explorer]: completed");
  });

  it("keeps explicit final answers visible outside collapsed legacy work groups", () => {
    const items: ConversationItem[] = [
      {
        id: "user-1",
        kind: "message",
        role: "user",
        text: "Fix this",
      },
      {
        id: "assistant-progress-1",
        kind: "message",
        role: "assistant",
        text: "I am checking the logs.",
        phase: "commentary",
      },
      makeToolItem({
        id: "tool-1",
        title: "Command: rg bug src",
        detail: "/repo",
      }),
      {
        id: "assistant-final",
        kind: "message",
        role: "assistant",
        text: "Fixed the bug.",
        phase: "final_answer",
      },
    ];

    const entries = buildMessageEntries(items, false);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "item",
      "workGroup",
      "item",
    ]);
    expect(entries[2]).toMatchObject({
      kind: "item",
      item: { id: "assistant-final" },
    });
    expect(entries[1]).toMatchObject({
      kind: "workGroup",
      group: {
        items: expect.arrayContaining([
          expect.objectContaining({ id: "assistant-progress-1" }),
          expect.objectContaining({ id: "tool-1" }),
        ]),
      },
    });
  });

  it("prefers explicit final answers when a completed turn has trailing bookkeeping", () => {
    const items: ConversationItem[] = [
      {
        id: "user-1",
        kind: "message",
        role: "user",
        text: "Fix this",
        turnId: "turn-1",
      },
      {
        id: "assistant-progress-1",
        kind: "message",
        role: "assistant",
        text: "I am checking the logs.",
        phase: "commentary",
        turnId: "turn-1",
      },
      makeToolItem({
        id: "tool-1",
        title: "Command: rg bug src",
        detail: "/repo",
        turnId: "turn-1",
      }),
      {
        id: "assistant-final",
        kind: "message",
        role: "assistant",
        text: "Fixed the bug.",
        phase: "final_answer",
        turnId: "turn-1",
      },
      {
        id: "compact-1",
        kind: "tool",
        toolType: "contextCompaction",
        title: "Context compaction",
        detail: "Compacting conversation context to fit token limits.",
        status: "completed",
        output: "",
        turnId: "turn-1",
      },
    ];

    const entries = buildMessageEntries(items, false);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "item",
      "workGroup",
      "item",
    ]);
    expect(entries[2]).toMatchObject({
      kind: "item",
      item: { id: "assistant-final" },
    });
    expect(entries[1]).toMatchObject({
      kind: "workGroup",
      group: {
        items: expect.arrayContaining([
          expect.objectContaining({ id: "assistant-progress-1" }),
          expect.objectContaining({ id: "tool-1" }),
          expect.objectContaining({ id: "compact-1" }),
        ]),
      },
    });
  });
});
