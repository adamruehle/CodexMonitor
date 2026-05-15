import { describe, expect, it } from "vitest";
import type { ConversationItem, ThreadSummary } from "@/types";
import {
  buildResumeHydrationPlan,
  buildWorkspaceThreadListState,
} from "./threadActionHelpers";

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

  it("does not keep review lock after resuming a completed thread", () => {
    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: null,
      localItems: [],
      localStatus: undefined,
      thread: {
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "review-started",
                type: "enteredReviewMode",
              },
              {
                id: "assistant-final",
                type: "agentMessage",
                text: "Review is complete.",
              },
            ],
          },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.shouldMarkProcessing).toBe(false);
    expect(plan.reviewing).toBe(false);
  });

  it("keeps review lock while the resumed turn is still active", () => {
    const plan = buildResumeHydrationPlan({
      getCustomName: () => undefined,
      localActiveTurnId: null,
      localItems: [],
      localStatus: undefined,
      thread: {
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            status: "inProgress",
            items: [
              {
                id: "review-started",
                type: "enteredReviewMode",
              },
            ],
          },
        ],
      },
      threadId: "thread-1",
      workspaceId: "ws-1",
    });

    expect(plan.shouldMarkProcessing).toBe(true);
    expect(plan.reviewing).toBe(true);
  });

  it("preserves non-codex provider threads even when they fall outside the recent cap", () => {
    const matchingThreads = Array.from({ length: 20 }, (_, index) => ({
      id: `codex-${index + 1}`,
      title: `Codex ${index + 1}`,
      provider: "codex",
      updated_at: `2026-05-${String(20 - index).padStart(2, "0")}T12:00:00Z`,
      created_at: `2026-05-${String(20 - index).padStart(2, "0")}T11:00:00Z`,
    }));
    matchingThreads.push({
      id: "claude-1",
      title: "Claude investigation",
      provider: "claude",
      updated_at: "2026-04-16T09:59:40Z",
      created_at: "2026-04-16T09:59:40Z",
    });

    const state = buildWorkspaceThreadListState({
      activeThreadId: null,
      activityByThread: {},
      buildThreadSummary: (_workspaceId, thread): ThreadSummary | null => ({
        id: String(thread.id ?? ""),
        name: String(thread.title ?? thread.id ?? ""),
        updatedAt: Date.parse(String(thread.updated_at ?? thread.updatedAt ?? 0)) || 0,
        createdAt: Date.parse(String(thread.created_at ?? thread.createdAt ?? 0)) || 0,
        provider:
          String(thread.provider ?? "").trim().toLowerCase() === "claude"
            ? "claude"
            : "codex",
      }),
      existingThreadIds: [],
      matchingThreads,
      requestedSortKey: "updated_at",
      threadListTargetCount: 20,
      threadParentById: {},
      threadStatusById: {},
      workspaceId: "ws-1",
    });

    expect(state.summaries).toHaveLength(21);
    expect(state.summaries.some((thread) => thread.id === "claude-1")).toBe(true);
  });
});
