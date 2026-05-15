// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import type { ConversationItem } from "@/types";
import {
  loadPinnedThreadOrder,
  loadThreadItems,
  normalizePinnedThreadOrder,
  savePinnedThreadOrder,
  STORAGE_KEY_PINNED_THREAD_ORDER,
  saveThreadItems,
  STORAGE_KEY_THREAD_ITEMS,
} from "./threadStorage";

describe("threadStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("loads and normalizes persisted pinned thread order", () => {
    window.localStorage.setItem(
      STORAGE_KEY_PINNED_THREAD_ORDER,
      JSON.stringify(["ws-1:thread-2", "", "ws-1:thread-2", "ws-1:thread-1"]),
    );

    expect(loadPinnedThreadOrder()).toEqual([
      "ws-1:thread-2",
      "ws-1:thread-1",
    ]);
  });

  it("normalizes pinned thread order against current pinned membership", () => {
    expect(
      normalizePinnedThreadOrder(
        {
          "ws-1:thread-1": 100,
          "ws-2:thread-2": 200,
          "ws-3:thread-3": 300,
        },
        ["ws-2:thread-2", "ws-1:missing", "ws-2:thread-2"],
      ),
    ).toEqual([
      "ws-2:thread-2",
      "ws-1:thread-1",
      "ws-3:thread-3",
    ]);
  });

  it("persists pinned thread order", () => {
    savePinnedThreadOrder(["ws-1:thread-1", "ws-2:thread-2"]);

    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY_PINNED_THREAD_ORDER) ?? "[]"),
    ).toEqual(["ws-1:thread-1", "ws-2:thread-2"]);
  });

  it("repairs persisted thread items with missing turn ids when loading", () => {
    const persisted: Record<string, ConversationItem[]> = {
      "thread-1": [
        {
          id: "user-1",
          kind: "message",
          role: "user",
          text: "continue",
          turnId: "turn-1",
        },
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          text: "Checking now",
          turnId: "turn-1",
        },
        {
          id: "tool-1",
          kind: "tool",
          toolType: "commandExecution",
          title: "Command: rg turnId src",
          detail: "/tmp/repo",
          status: "completed",
          output: "src/foo.ts:1:turnId",
          turnId: null,
        },
        {
          id: "assistant-2",
          kind: "message",
          role: "assistant",
          text: "Done",
          turnId: "turn-1",
        },
      ],
    };

    window.localStorage.setItem(STORAGE_KEY_THREAD_ITEMS, JSON.stringify(persisted));

    const loaded = loadThreadItems();

    expect(loaded["thread-1"]?.[2]).toMatchObject({
      id: "tool-1",
      turnId: "turn-1",
    });
  });

  it("repairs missing turn ids before saving", () => {
    const items: Record<string, ConversationItem[]> = {
      "thread-1": [
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          text: "Working",
          turnId: "turn-9",
        },
        {
          id: "tool-1",
          kind: "tool",
          toolType: "mcpToolCall",
          title: "Tool: jira / get_issue",
          detail: "{\"key\":\"CMP-1\"}",
          status: "completed",
          output: "done",
          turnId: null,
        },
        {
          id: "assistant-2",
          kind: "message",
          role: "assistant",
          text: "Finished",
          turnId: "turn-9",
        },
      ],
    };

    saveThreadItems(items);

    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY_THREAD_ITEMS) ?? "{}",
    ) as Record<string, ConversationItem[]>;

    expect(stored["thread-1"]?.[1]).toMatchObject({
      id: "tool-1",
      turnId: "turn-9",
    });
  });

  it("synthesizes turn ids for persisted legacy snapshots with no turn metadata", () => {
    const persisted: Record<string, ConversationItem[]> = {
      "thread-1": [
        {
          id: "user-1",
          kind: "message",
          role: "user",
          text: "continue",
          turnId: null,
        },
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          text: "Checking the renderer.",
          turnId: null,
        },
        {
          id: "tool-1",
          kind: "tool",
          toolType: "commandExecution",
          title: "Command: rg workGroup src",
          detail: "/tmp/repo",
          status: "completed",
          output: "matched",
          turnId: null,
        },
        {
          id: "assistant-2",
          kind: "message",
          role: "assistant",
          text: "Final answer visible again.",
          turnId: null,
        },
        {
          id: "user-2",
          kind: "message",
          role: "user",
          text: "next bug",
          turnId: null,
        },
      ],
    };

    window.localStorage.setItem(STORAGE_KEY_THREAD_ITEMS, JSON.stringify(persisted));

    const loaded = loadThreadItems();
    const firstTurnId = loaded["thread-1"]?.[0]?.turnId;
    const secondTurnId = loaded["thread-1"]?.[4]?.turnId;

    expect(firstTurnId).toBeTruthy();
    expect(loaded["thread-1"]?.slice(0, 4).every((item) => item.turnId === firstTurnId)).toBe(
      true,
    );
    expect(secondTurnId).toBeTruthy();
    expect(secondTurnId).not.toBe(firstTurnId);
  });

  it("repairs missing timestamps when loading persisted thread items", () => {
    const firstTimestamp = 1_746_000_000_000;
    const finalTimestamp = 1_746_000_005_000;
    const persisted: Record<string, ConversationItem[]> = {
      "thread-1": [
        {
          id: "user-1",
          kind: "message",
          role: "user",
          text: "continue",
          turnId: "turn-1",
          timestampMs: firstTimestamp,
        },
        {
          id: "tool-1",
          kind: "tool",
          toolType: "commandExecution",
          title: "Command: rg missing src",
          detail: "/tmp/repo",
          status: "completed",
          output: "src/foo.ts:1:missing",
          turnId: "turn-1",
          timestampMs: null,
        },
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          text: "Final answer visible.",
          turnId: "turn-1",
          timestampMs: finalTimestamp,
        },
      ],
    };

    window.localStorage.setItem(STORAGE_KEY_THREAD_ITEMS, JSON.stringify(persisted));

    const loaded = loadThreadItems();

    expect(loaded["thread-1"]?.[1]).toMatchObject({
      id: "tool-1",
      timestampMs: 1_746_000_002_500,
    });
  });

  it("repairs missing timestamps before saving", () => {
    const firstTimestamp = 1_746_000_000_000;
    const finalTimestamp = 1_746_000_005_000;
    const items: Record<string, ConversationItem[]> = {
      "thread-1": [
        {
          id: "user-1",
          kind: "message",
          role: "user",
          text: "continue",
          turnId: "turn-1",
          timestampMs: firstTimestamp,
        },
        {
          id: "tool-1",
          kind: "tool",
          toolType: "commandExecution",
          title: "Command: rg missing src",
          detail: "/tmp/repo",
          status: "completed",
          output: "src/foo.ts:1:missing",
          turnId: "turn-1",
          timestampMs: null,
        },
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          text: "Final answer visible.",
          turnId: "turn-1",
          timestampMs: finalTimestamp,
        },
      ],
    };

    saveThreadItems(items);

    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY_THREAD_ITEMS) ?? "{}",
    ) as Record<string, ConversationItem[]>;

    expect(stored["thread-1"]?.[1]).toMatchObject({
      id: "tool-1",
      timestampMs: 1_746_000_002_500,
    });
  });
});
