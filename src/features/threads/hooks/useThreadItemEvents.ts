import { useCallback } from "react";
import type { Dispatch } from "react";
import { buildConversationItem } from "@utils/threadItems";
import { normalizeThreadTimestamp } from "@utils/threadItems.shared";
import type { CollabAgentRef } from "@/types";
import {
  buildItemForDisplay,
  handleConvertedItemEffects,
} from "./threadItemEventHelpers";
import type { ThreadAction } from "./useThreadsReducer";

function itemTurnId(item: Record<string, unknown>) {
  const raw = item.turnId ?? item.turn_id ?? null;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function itemTimestampMs(item: Record<string, unknown>) {
  const timestamp = normalizeThreadTimestamp(
    item.timestamp ??
      item.timestampMs ??
      item.timestamp_ms ??
      item.createdAt ??
      item.created_at ??
      item.startedAt ??
      item.started_at ??
      item.updatedAt ??
      item.updated_at,
  );
  return timestamp > 0 ? timestamp : null;
}

type UseThreadItemEventsOptions = {
  activeThreadId: string | null;
  dispatch: Dispatch<ThreadAction>;
  getActiveTurnId: (threadId: string) => string | null;
  shouldMarkProcessingForTurn?: (
    threadId: string,
    turnId: string | null,
  ) => boolean;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  markProcessing: (threadId: string, isProcessing: boolean) => void;
  markReviewing: (threadId: string, isReviewing: boolean) => void;
  safeMessageActivity: () => void;
  recordThreadActivity: (
    workspaceId: string,
    threadId: string,
    timestamp?: number,
  ) => void;
  applyCollabThreadLinks: (
    workspaceId: string,
    threadId: string,
    item: Record<string, unknown>,
  ) => void;
  hydrateSubagentThreads?: (
    workspaceId: string,
    receivers: CollabAgentRef[],
  ) => void | Promise<void>;
  onUserMessageCreated?: (
    workspaceId: string,
    threadId: string,
    text: string,
  ) => void | Promise<void>;
  onReviewExited?: (workspaceId: string, threadId: string) => void;
};

export function useThreadItemEvents({
  activeThreadId,
  dispatch,
  getActiveTurnId,
  shouldMarkProcessingForTurn,
  getCustomName,
  markProcessing,
  markReviewing,
  safeMessageActivity,
  recordThreadActivity,
  applyCollabThreadLinks,
  hydrateSubagentThreads,
  onUserMessageCreated,
  onReviewExited,
}: UseThreadItemEventsOptions) {
  const handleItemUpdate = useCallback(
    (
      workspaceId: string,
      threadId: string,
      item: Record<string, unknown>,
      shouldMarkProcessing: boolean,
    ) => {
      dispatch({ type: "ensureThread", workspaceId, threadId });
      const explicitTurnId = itemTurnId(item);
      const activeTurnId = getActiveTurnId(threadId);
      const effectiveTurnId = explicitTurnId ?? activeTurnId;
      const canMarkProcessing =
        shouldMarkProcessingForTurn?.(threadId, effectiveTurnId) ?? true;
      if (shouldMarkProcessing && canMarkProcessing) {
        markProcessing(threadId, true);
      }
      applyCollabThreadLinks(workspaceId, threadId, item);
      const itemType = String(item?.type ?? "");
      if (itemType === "enteredReviewMode") {
        markReviewing(threadId, true);
      } else if (itemType === "exitedReviewMode") {
        markReviewing(threadId, false);
        markProcessing(threadId, false);
        if (!shouldMarkProcessing) {
          onReviewExited?.(workspaceId, threadId);
        }
      }
      const itemForDisplay = buildItemForDisplay(item, shouldMarkProcessing);
      const converted = buildConversationItem(itemForDisplay, {
        turnId: effectiveTurnId,
        timestampMs: itemTimestampMs(item) ?? Date.now(),
      });
      handleConvertedItemEffects({
        converted,
        workspaceId,
        threadId,
        hydrateSubagentThreads,
        onUserMessageCreated,
      });
      if (converted) {
        dispatch({
          type: "upsertItem",
          workspaceId,
          threadId,
          item: converted,
          hasCustomName: Boolean(getCustomName(workspaceId, threadId)),
        });
      }
      safeMessageActivity();
    },
    [
      applyCollabThreadLinks,
      dispatch,
      getActiveTurnId,
      getCustomName,
      markProcessing,
      markReviewing,
      onReviewExited,
      onUserMessageCreated,
      hydrateSubagentThreads,
      safeMessageActivity,
      shouldMarkProcessingForTurn,
    ],
  );

  const handleToolOutputDelta = useCallback(
    (threadId: string, itemId: string, delta: string) => {
      const activeTurnId = getActiveTurnId(threadId);
      const canMarkProcessing =
        shouldMarkProcessingForTurn?.(threadId, activeTurnId) ?? true;
      if (canMarkProcessing) {
        markProcessing(threadId, true);
      }
      dispatch({ type: "appendToolOutput", threadId, itemId, delta });
      safeMessageActivity();
    },
    [
      dispatch,
      getActiveTurnId,
      markProcessing,
      safeMessageActivity,
      shouldMarkProcessingForTurn,
    ],
  );

  const handleTerminalInteraction = useCallback(
    (threadId: string, itemId: string, stdin: string) => {
      if (!stdin) {
        return;
      }
      const normalized = stdin.replace(/\r\n/g, "\n");
      const suffix = normalized.endsWith("\n") ? "" : "\n";
      handleToolOutputDelta(threadId, itemId, `\n[stdin]\n${normalized}${suffix}`);
    },
    [handleToolOutputDelta],
  );

  const onAgentMessageDelta = useCallback(
    ({
      workspaceId,
      threadId,
      itemId,
      delta,
      phase = null,
      turnId = null,
      timestampMs = null,
    }: {
      workspaceId: string;
      threadId: string;
      itemId: string;
      delta: string;
      phase?: string | null;
      turnId?: string | null;
      timestampMs?: number | null;
    }) => {
      const fallbackTimestamp =
        typeof timestampMs === "number" && Number.isFinite(timestampMs)
          ? timestampMs
          : Date.now();
      const activeTurnId = getActiveTurnId(threadId);
      const effectiveTurnId = turnId ?? activeTurnId;
      const canMarkProcessing =
        shouldMarkProcessingForTurn?.(threadId, effectiveTurnId) ?? true;
      dispatch({ type: "ensureThread", workspaceId, threadId });
      if (canMarkProcessing) {
        markProcessing(threadId, true);
      }
      const hasCustomName = Boolean(getCustomName(workspaceId, threadId));
      const action: ThreadAction = {
        type: "appendAgentDelta",
        workspaceId,
        threadId,
        itemId,
        delta,
        hasCustomName,
      };
      if (effectiveTurnId) {
        action.turnId = effectiveTurnId;
      }
      if (phase) {
        action.phase = phase;
      }
      action.timestampMs = fallbackTimestamp;
      dispatch(action);
    },
    [
      dispatch,
      getActiveTurnId,
      getCustomName,
      markProcessing,
      shouldMarkProcessingForTurn,
    ],
  );

  const onAgentMessageCompleted = useCallback(
    ({
      workspaceId,
      threadId,
      itemId,
      text,
      phase = null,
      turnId = null,
      timestampMs = null,
    }: {
      workspaceId: string;
      threadId: string;
      itemId: string;
      text: string;
      phase?: string | null;
      turnId?: string | null;
      timestampMs?: number | null;
    }) => {
      const timestamp =
        typeof timestampMs === "number" && Number.isFinite(timestampMs)
          ? timestampMs
          : Date.now();
      dispatch({ type: "ensureThread", workspaceId, threadId });
      const hasCustomName = Boolean(getCustomName(workspaceId, threadId));
      const action: ThreadAction = {
        type: "completeAgentMessage",
        workspaceId,
        threadId,
        itemId,
        text,
        hasCustomName,
      };
      const activeTurnId = getActiveTurnId(threadId);
      const effectiveTurnId = turnId ?? activeTurnId;
      if (effectiveTurnId) {
        action.turnId = effectiveTurnId;
      }
      if (phase) {
        action.phase = phase;
      }
      action.timestampMs = timestamp;
      dispatch(action);
      dispatch({
        type: "setThreadTimestamp",
        workspaceId,
        threadId,
        timestamp,
      });
      dispatch({
        type: "setLastAgentMessage",
        threadId,
        text,
        timestamp,
      });
      recordThreadActivity(workspaceId, threadId, timestamp);
      safeMessageActivity();
      if (threadId !== activeThreadId) {
        dispatch({ type: "markUnread", threadId, hasUnread: true });
      }
    },
    [
      activeThreadId,
      dispatch,
      getActiveTurnId,
      getCustomName,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  const onItemStarted = useCallback(
    (workspaceId: string, threadId: string, item: Record<string, unknown>) => {
      handleItemUpdate(workspaceId, threadId, item, true);
    },
    [handleItemUpdate],
  );

  const onItemCompleted = useCallback(
    (workspaceId: string, threadId: string, item: Record<string, unknown>) => {
      handleItemUpdate(workspaceId, threadId, item, false);
    },
    [handleItemUpdate],
  );

  const onReasoningSummaryDelta = useCallback(
    (_workspaceId: string, threadId: string, itemId: string, delta: string) => {
      dispatch({ type: "appendReasoningSummary", threadId, itemId, delta });
    },
    [dispatch],
  );

  const onReasoningSummaryBoundary = useCallback(
    (_workspaceId: string, threadId: string, itemId: string) => {
      dispatch({ type: "appendReasoningSummaryBoundary", threadId, itemId });
    },
    [dispatch],
  );

  const onReasoningTextDelta = useCallback(
    (_workspaceId: string, threadId: string, itemId: string, delta: string) => {
      dispatch({ type: "appendReasoningContent", threadId, itemId, delta });
    },
    [dispatch],
  );

  const onPlanDelta = useCallback(
    (_workspaceId: string, threadId: string, itemId: string, delta: string) => {
      dispatch({ type: "appendPlanDelta", threadId, itemId, delta });
    },
    [dispatch],
  );

  const onCommandOutputDelta = useCallback(
    (_workspaceId: string, threadId: string, itemId: string, delta: string) => {
      handleToolOutputDelta(threadId, itemId, delta);
    },
    [handleToolOutputDelta],
  );

  const onTerminalInteraction = useCallback(
    (_workspaceId: string, threadId: string, itemId: string, stdin: string) => {
      handleTerminalInteraction(threadId, itemId, stdin);
    },
    [handleTerminalInteraction],
  );

  const onFileChangeOutputDelta = useCallback(
    (_workspaceId: string, threadId: string, itemId: string, delta: string) => {
      handleToolOutputDelta(threadId, itemId, delta);
    },
    [handleToolOutputDelta],
  );

  return {
    onAgentMessageDelta,
    onAgentMessageCompleted,
    onItemStarted,
    onItemCompleted,
    onReasoningSummaryDelta,
    onReasoningSummaryBoundary,
    onReasoningTextDelta,
    onPlanDelta,
    onCommandOutputDelta,
    onTerminalInteraction,
    onFileChangeOutputDelta,
  };
}
