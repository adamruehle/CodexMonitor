import { describe, expect, it } from "vitest";
import type { ConversationItem } from "@/types";
import { buildResumeHydrationPlan } from "./threadActionHelpers";

describe("threadActionHelpers", () => {
  it("repairs stale local turn items before merging resumed thread items", () => {
    const userTimestamp = Date.parse("2026-04-29T01:00:00Z");
    const progressTimestamp = Date.parse("2026-04-29T01:00:01Z");
    const localItems: ConversationItem[] = [
      {
        id: "user-1",
        kind: "message",
        role: "user",
        text: "continue",
        turnId: "turn-1",
        timestampMs: userTimestamp,
      },
      {
        id: "assistant-progress-1",
        kind: "message",
        role: "assistant",
        text: "Checking the replay path.",
        turnId: "turn-1",
        timestampMs: progressTimestamp,
      },
      {
        id: "tool-local-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: rg missing src",
        detail: "/tmp/repo",
        status: "completed",
        output: "src/foo.ts:1:missing",
        turnId: null,
        timestampMs: null,
      },
    ];

    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: null,
      localItems,
      localStatus: undefined,
      thread: {
        id: "thread-1",
        title: "Replay thread",
        updated_at: "2026-04-29T01:00:10Z",
        turns: [
          {
            id: "turn-1",
            status: "completed",
            started_at: "2026-04-29T01:00:00Z",
            completed_at: "2026-04-29T01:00:10Z",
            items: [
              {
                id: "user-1",
                type: "userMessage",
                content: [{ type: "text", text: "continue" }],
              },
              {
                id: "assistant-progress-1",
                type: "agentMessage",
                text: "Checking the replay path.",
              },
              {
                id: "assistant-final-1",
                type: "agentMessage",
                text: "Final answer visible.",
              },
            ],
          },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.mergedItems.map((item) => item.id)).toEqual([
      "user-1",
      "assistant-progress-1",
      "tool-local-1",
      "assistant-final-1",
    ]);
    expect(plan.lastMessageText).toBe("Final answer visible.");
  });
});
