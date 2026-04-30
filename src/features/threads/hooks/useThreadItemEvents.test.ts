// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConversationItem } from "@utils/threadItems";
import { useThreadItemEvents } from "./useThreadItemEvents";

vi.mock("@utils/threadItems", () => ({
  buildConversationItem: vi.fn(),
}));

type ItemPayload = Record<string, unknown>;

type SetupOverrides = {
  activeThreadId?: string | null;
  getActiveTurnId?: (threadId: string) => string | null;
  shouldMarkProcessingForTurn?: (
    threadId: string,
    turnId: string | null,
  ) => boolean;
  getCustomName?: (workspaceId: string, threadId: string) => string | undefined;
  onUserMessageCreated?: (workspaceId: string, threadId: string, text: string) => void;
  onReviewExited?: (workspaceId: string, threadId: string) => void;
};

const makeOptions = (overrides: SetupOverrides = {}) => {
  const dispatch = vi.fn();
  const markProcessing = vi.fn();
  const markReviewing = vi.fn();
  const safeMessageActivity = vi.fn();
  const recordThreadActivity = vi.fn();
  const applyCollabThreadLinks = vi.fn();
  const getActiveTurnId =
    overrides.getActiveTurnId ?? vi.fn(() => null);
  const getCustomName =
    overrides.getCustomName ?? vi.fn(() => undefined);

  const { result } = renderHook(() =>
    useThreadItemEvents({
      activeThreadId: overrides.activeThreadId ?? null,
      dispatch,
      getActiveTurnId,
      shouldMarkProcessingForTurn: overrides.shouldMarkProcessingForTurn,
      getCustomName,
      markProcessing,
      markReviewing,
      safeMessageActivity,
      recordThreadActivity,
      applyCollabThreadLinks,
      onUserMessageCreated: overrides.onUserMessageCreated,
      onReviewExited: overrides.onReviewExited,
    }),
  );

  return {
    result,
    dispatch,
    markProcessing,
    markReviewing,
    safeMessageActivity,
    recordThreadActivity,
    applyCollabThreadLinks,
    getActiveTurnId,
    getCustomName,
  };
};

describe("useThreadItemEvents", () => {
  const convertedItem = {
    id: "item-1",
    kind: "message",
    role: "assistant",
    text: "Hello",
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildConversationItem).mockReturnValue(convertedItem);
  });

  it("dispatches item updates and marks review mode on item start", () => {
    const getCustomName = vi.fn(() => "Custom");
    const { result, dispatch, markProcessing, markReviewing, safeMessageActivity, applyCollabThreadLinks } =
      makeOptions({ getCustomName });
    const item: ItemPayload = { type: "enteredReviewMode", id: "item-1" };

    act(() => {
      result.current.onItemStarted("ws-1", "thread-1", item);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(markProcessing).toHaveBeenCalledWith("thread-1", true);
    expect(markReviewing).toHaveBeenCalledWith("thread-1", true);
    expect(applyCollabThreadLinks).toHaveBeenCalledWith("ws-1", "thread-1", item);
    expect(dispatch).toHaveBeenCalledWith({
      type: "upsertItem",
      workspaceId: "ws-1",
      threadId: "thread-1",
      item: convertedItem,
      hasCustomName: true,
    });
    expect(safeMessageActivity).toHaveBeenCalled();
  });

  it("falls back to the thread active turn id when an item event omits turnId", () => {
    const getActiveTurnId = vi.fn((threadId: string) =>
      threadId === "thread-1" ? "turn-1" : null,
    );
    const { result } = makeOptions({ getActiveTurnId });
    const item: ItemPayload = {
      type: "commandExecution",
      id: "cmd-1",
      command: ["date"],
    };

    act(() => {
      result.current.onItemCompleted("ws-1", "thread-1", item);
    });

    expect(buildConversationItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "commandExecution",
        id: "cmd-1",
      }),
      expect.objectContaining({
        turnId: "turn-1",
        timestampMs: expect.any(Number),
      }),
    );
  });

  it("marks review/processing false when review mode exits", () => {
    const { result, dispatch, markProcessing, markReviewing, safeMessageActivity } = makeOptions();
    const item: ItemPayload = { type: "exitedReviewMode", id: "review-1" };

    act(() => {
      result.current.onItemCompleted("ws-1", "thread-1", item);
    });

    expect(markReviewing).toHaveBeenCalledWith("thread-1", false);
    expect(markProcessing).toHaveBeenCalledWith("thread-1", false);
    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "upsertItem",
      workspaceId: "ws-1",
      threadId: "thread-1",
      item: convertedItem,
      hasCustomName: false,
    });
    expect(safeMessageActivity).toHaveBeenCalled();
  });

  it("only triggers onReviewExited on completed exit events", () => {
    const onReviewExited = vi.fn();
    const { result } = makeOptions({ onReviewExited });
    const item: ItemPayload = { type: "exitedReviewMode", id: "review-1" };

    act(() => {
      result.current.onItemStarted("ws-1", "thread-1", item);
    });
    expect(onReviewExited).not.toHaveBeenCalled();

    act(() => {
      result.current.onItemCompleted("ws-1", "thread-1", item);
    });
    expect(onReviewExited).toHaveBeenCalledTimes(1);
    expect(onReviewExited).toHaveBeenCalledWith("ws-1", "thread-1");
  });

  it("adds lifecycle status for context compaction items", () => {
    const { result } = makeOptions();
    const item: ItemPayload = { type: "contextCompaction", id: "compact-1" };

    act(() => {
      result.current.onItemStarted("ws-1", "thread-1", item);
    });
    expect(buildConversationItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "contextCompaction",
        id: "compact-1",
        status: "inProgress",
      }),
      expect.objectContaining({
        turnId: null,
        timestampMs: expect.any(Number),
      }),
    );

    act(() => {
      result.current.onItemCompleted("ws-1", "thread-1", item);
    });
    expect(buildConversationItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "contextCompaction",
        id: "compact-1",
        status: "completed",
      }),
      expect.objectContaining({
        turnId: null,
        timestampMs: expect.any(Number),
      }),
    );
  });

  it("adds lifecycle status for web search items", () => {
    const { result } = makeOptions();
    const item: ItemPayload = { type: "webSearch", id: "search-1", query: "codex monitor" };

    act(() => {
      result.current.onItemStarted("ws-1", "thread-1", item);
    });
    expect(buildConversationItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "webSearch",
        id: "search-1",
        status: "inProgress",
      }),
      expect.objectContaining({
        turnId: null,
        timestampMs: expect.any(Number),
      }),
    );

    act(() => {
      result.current.onItemCompleted("ws-1", "thread-1", item);
    });
    expect(buildConversationItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "webSearch",
        id: "search-1",
        status: "completed",
      }),
      expect.objectContaining({
        turnId: null,
        timestampMs: expect.any(Number),
      }),
    );
  });

  it("notifies when a user message is created", () => {
    const onUserMessageCreated = vi.fn();
    vi.mocked(buildConversationItem).mockReturnValue({
      id: "item-2",
      kind: "message",
      role: "user",
      text: "Hello from user",
    });
    const { result } = makeOptions({ onUserMessageCreated });
    const item: ItemPayload = { type: "userMessage", id: "item-2" };

    act(() => {
      result.current.onItemCompleted("ws-1", "thread-1", item);
    });

    expect(onUserMessageCreated).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "Hello from user",
    );
  });

  it("marks processing and appends agent deltas", () => {
    const { result, dispatch, markProcessing } = makeOptions();

    act(() => {
      result.current.onAgentMessageDelta({
        workspaceId: "ws-1",
        threadId: "thread-1",
        itemId: "assistant-1",
        delta: "Hello",
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(markProcessing).toHaveBeenCalledWith("thread-1", true);
    expect(dispatch).toHaveBeenCalledWith({
      type: "appendAgentDelta",
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: "assistant-1",
      delta: "Hello",
      hasCustomName: false,
      timestampMs: expect.any(Number),
    });
  });

  it("uses the active turn id for agent deltas that omit turnId", () => {
    const getActiveTurnId = vi.fn(() => "turn-active");
    const { result, dispatch } = makeOptions({ getActiveTurnId });

    act(() => {
      result.current.onAgentMessageDelta({
        workspaceId: "ws-1",
        threadId: "thread-1",
        itemId: "assistant-1",
        delta: "Live assistant text",
        phase: "commentary",
      });
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "appendAgentDelta",
        threadId: "thread-1",
        itemId: "assistant-1",
        turnId: "turn-active",
        phase: "commentary",
      }),
    );
  });

  it("does not reopen processing for late deltas from a settled turn", () => {
    const shouldMarkProcessingForTurn = vi.fn(() => false);
    const { result, dispatch, markProcessing } = makeOptions({
      shouldMarkProcessingForTurn,
    });

    act(() => {
      result.current.onAgentMessageDelta({
        workspaceId: "ws-1",
        threadId: "thread-1",
        itemId: "assistant-1",
        delta: "Late text",
        turnId: "turn-1",
      });
    });

    expect(shouldMarkProcessingForTurn).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
    );
    expect(markProcessing).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "appendAgentDelta",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    );
  });

  it("does not reopen processing for late item starts from a settled turn", () => {
    const shouldMarkProcessingForTurn = vi.fn(() => false);
    const { result, markProcessing } = makeOptions({
      shouldMarkProcessingForTurn,
    });

    act(() => {
      result.current.onItemStarted("ws-1", "thread-1", {
        type: "contextCompaction",
        id: "compact-1",
        turnId: "turn-1",
      });
    });

    expect(shouldMarkProcessingForTurn).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
    );
    expect(markProcessing).not.toHaveBeenCalled();
  });

  it("completes agent messages and updates thread activity", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234);
    const { result, dispatch, recordThreadActivity, safeMessageActivity } = makeOptions({
      activeThreadId: "thread-2",
    });

    act(() => {
      result.current.onAgentMessageCompleted({
        workspaceId: "ws-1",
        threadId: "thread-1",
        itemId: "assistant-1",
        text: "Done",
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "completeAgentMessage",
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: "assistant-1",
      text: "Done",
      hasCustomName: false,
      timestampMs: 1234,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadTimestamp",
      workspaceId: "ws-1",
      threadId: "thread-1",
      timestamp: 1234,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setLastAgentMessage",
      threadId: "thread-1",
      text: "Done",
      timestamp: 1234,
    });
    expect(recordThreadActivity).toHaveBeenCalledWith("ws-1", "thread-1", 1234);
    expect(safeMessageActivity).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "markUnread",
      threadId: "thread-1",
      hasUnread: true,
    });

    nowSpy.mockRestore();
  });

  it("uses the active turn id for completed agent messages that omit turnId", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(5678);
    const getActiveTurnId = vi.fn(() => "turn-active");
    const { result, dispatch } = makeOptions({ getActiveTurnId });

    act(() => {
      result.current.onAgentMessageCompleted({
        workspaceId: "ws-1",
        threadId: "thread-1",
        itemId: "assistant-1",
        text: "Final answer",
        phase: "final_answer",
      });
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "completeAgentMessage",
        threadId: "thread-1",
        itemId: "assistant-1",
        text: "Final answer",
        phase: "final_answer",
        turnId: "turn-active",
        timestampMs: 5678,
      }),
    );

    nowSpy.mockRestore();
  });

  it("dispatches reasoning summary boundaries", () => {
    const { result, dispatch } = makeOptions();

    act(() => {
      result.current.onReasoningSummaryBoundary("ws-1", "thread-1", "reasoning-1");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "appendReasoningSummaryBoundary",
      threadId: "thread-1",
      itemId: "reasoning-1",
    });
  });

  it("dispatches plan deltas", () => {
    const { result, dispatch } = makeOptions();

    act(() => {
      result.current.onPlanDelta("ws-1", "thread-1", "plan-1", "- Step 1");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "appendPlanDelta",
      threadId: "thread-1",
      itemId: "plan-1",
      delta: "- Step 1",
    });
  });
});
