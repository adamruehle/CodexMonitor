import { useCallback, useMemo, useRef } from "react";
import type { DebugEntry } from "../../../types";
import { sendNotification } from "../../../services/tauri";
import { useAppServerEvents } from "../../app/hooks/useAppServerEvents";

const DEFAULT_MIN_DURATION_MS = 60_000; // 1 minute
const MAX_BODY_LENGTH = 200;

type SystemNotificationOptions = {
  enabled: boolean;
  isWindowFocused: boolean;
  minDurationMs?: number;
  subagentNotificationsEnabled?: boolean;
  isSubagentThread?: (workspaceId: string, threadId: string) => boolean;
  getWorkspaceName?: (workspaceId: string) => string | undefined;
  onThreadNotificationSent?: (workspaceId: string, threadId: string) => void;
  onDebug?: (entry: DebugEntry) => void;
};

function buildThreadKey(workspaceId: string, threadId: string) {
  return `${workspaceId}:${threadId}`;
}

function buildTurnKey(workspaceId: string, turnId: string) {
  return `${workspaceId}:${turnId}`;
}

function buildTerminalKey(
  workspaceId: string,
  threadId: string,
  turnId: string,
) {
  const normalizedTurnId = turnId.trim();
  return normalizedTurnId
    ? `${workspaceId}:turn:${normalizedTurnId}`
    : `${workspaceId}:thread:${threadId}`;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 1) + "…";
}

export function useAgentSystemNotifications({
  enabled,
  isWindowFocused,
  minDurationMs = DEFAULT_MIN_DURATION_MS,
  subagentNotificationsEnabled = true,
  isSubagentThread,
  getWorkspaceName,
  onThreadNotificationSent,
  onDebug,
}: SystemNotificationOptions) {
  const turnStartById = useRef(new Map<string, number>());
  const turnStartByThread = useRef(new Map<string, number>());
  const lastNotifiedAtByThread = useRef(new Map<string, number>());
  const lastMessageByThread = useRef(new Map<string, string>());
  const handledTerminalKeys = useRef(new Set<string>());

  const notify = useCallback(
    async (
      title: string,
      body: string,
      label: "success" | "error",
      extra?: Record<string, unknown>,
    ) => {
      try {
        await sendNotification(title, body, {
          autoCancel: true,
          extra,
        });
        onDebug?.({
          id: `${Date.now()}-client-notification-${label}`,
          timestamp: Date.now(),
          source: "client",
          label: `notification/${label}`,
          payload: { title, body },
        });
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-notification-error`,
          timestamp: Date.now(),
          source: "error",
          label: "notification/error",
          payload: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [onDebug],
  );

  const consumeDuration = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      const threadKey = buildThreadKey(workspaceId, threadId);
      let startedAt: number | undefined;

      if (turnId) {
        const turnKey = buildTurnKey(workspaceId, turnId);
        startedAt = turnStartById.current.get(turnKey);
        turnStartById.current.delete(turnKey);
      }

      if (startedAt === undefined) {
        startedAt = turnStartByThread.current.get(threadKey);
      }

      if (startedAt !== undefined) {
        turnStartByThread.current.delete(threadKey);
        return Date.now() - startedAt;
      }

      return null;
    },
    [],
  );

  const recordStartIfMissing = useCallback(
    (workspaceId: string, threadId: string) => {
      const threadKey = buildThreadKey(workspaceId, threadId);
      if (!turnStartByThread.current.has(threadKey)) {
        turnStartByThread.current.set(threadKey, Date.now());
      }
    },
    [],
  );

  const shouldNotify = useCallback(
    (
      workspaceId: string,
      threadId: string,
      durationMs: number | null,
      threadKey: string,
    ) => {
      if (durationMs === null) {
        return false;
      }
      if (!enabled) {
        return false;
      }
      if (
        !subagentNotificationsEnabled &&
        isSubagentThread?.(workspaceId, threadId)
      ) {
        return false;
      }
      if (durationMs < minDurationMs) {
        return false;
      }
      if (isWindowFocused) {
        return false;
      }
      const lastNotifiedAt = lastNotifiedAtByThread.current.get(threadKey);
      if (lastNotifiedAt && Date.now() - lastNotifiedAt < 1500) {
        return false;
      }
      lastNotifiedAtByThread.current.set(threadKey, Date.now());
      return true;
    },
    [
      enabled,
      isSubagentThread,
      isWindowFocused,
      minDurationMs,
      subagentNotificationsEnabled,
    ],
  );

  const getNotificationContent = useCallback(
    (workspaceId: string, threadId: string, fallbackBody: string) => {
      const title = getWorkspaceName?.(workspaceId) ?? "Agent Complete";
      const threadKey = buildThreadKey(workspaceId, threadId);
      const lastMessage = lastMessageByThread.current.get(threadKey);
      const body = lastMessage
        ? truncateText(lastMessage, MAX_BODY_LENGTH)
        : fallbackBody;
      return { title, body };
    },
    [getWorkspaceName],
  );

  const shouldHandleTerminalEvent = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      const key = buildTerminalKey(workspaceId, threadId, turnId);
      if (handledTerminalKeys.current.has(key)) {
        return false;
      }
      handledTerminalKeys.current.add(key);
      return true;
    },
    [],
  );

  const handleTurnStarted = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      const startedAt = Date.now();
      const threadKey = buildThreadKey(workspaceId, threadId);
      handledTerminalKeys.current.delete(
        buildTerminalKey(workspaceId, threadId, turnId),
      );
      turnStartByThread.current.set(threadKey, startedAt);
      lastMessageByThread.current.delete(threadKey);
      if (turnId) {
        turnStartById.current.set(buildTurnKey(workspaceId, turnId), startedAt);
      }
    },
    [],
  );

  const handleTurnCompleted = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      if (!shouldHandleTerminalEvent(workspaceId, threadId, turnId)) {
        return;
      }
      const durationMs = consumeDuration(workspaceId, threadId, turnId);
      const threadKey = buildThreadKey(workspaceId, threadId);
      if (!shouldNotify(workspaceId, threadId, durationMs, threadKey)) {
        return;
      }
      const { title, body } = getNotificationContent(
        workspaceId,
        threadId,
        "Your agent has finished its task.",
      );
      onThreadNotificationSent?.(workspaceId, threadId);
      void notify(title, body, "success", {
        kind: "thread",
        workspaceId,
        threadId,
      });
      lastMessageByThread.current.delete(threadKey);
    },
    [
      consumeDuration,
      getNotificationContent,
      notify,
      onThreadNotificationSent,
      shouldHandleTerminalEvent,
      shouldNotify,
    ],
  );

  const handleTurnError = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      payload: { message: string; willRetry: boolean },
    ) => {
      if (payload.willRetry) {
        return;
      }
      if (!shouldHandleTerminalEvent(workspaceId, threadId, turnId)) {
        return;
      }
      const durationMs = consumeDuration(workspaceId, threadId, turnId);
      const threadKey = buildThreadKey(workspaceId, threadId);
      if (!shouldNotify(workspaceId, threadId, durationMs, threadKey)) {
        return;
      }
      const title = getWorkspaceName?.(workspaceId) ?? "Agent Error";
      const body = payload.message || "An error occurred.";
      onThreadNotificationSent?.(workspaceId, threadId);
      void notify(title, truncateText(body, MAX_BODY_LENGTH), "error", {
        kind: "thread",
        workspaceId,
        threadId,
      });
      lastMessageByThread.current.delete(threadKey);
    },
    [
      consumeDuration,
      getWorkspaceName,
      notify,
      onThreadNotificationSent,
      shouldHandleTerminalEvent,
      shouldNotify,
    ],
  );

  const handleItemStarted = useCallback(
    (workspaceId: string, threadId: string) => {
      recordStartIfMissing(workspaceId, threadId);
    },
    [recordStartIfMissing],
  );

  const handleAgentMessageDelta = useCallback(
    (event: { workspaceId: string; threadId: string }) => {
      recordStartIfMissing(event.workspaceId, event.threadId);
    },
    [recordStartIfMissing],
  );

  const handleAgentMessageCompleted = useCallback(
    (event: { workspaceId: string; threadId: string; text: string }) => {
      const threadKey = buildThreadKey(event.workspaceId, event.threadId);
      // Store the message text for use in turn completion notification
      if (event.text) {
        lastMessageByThread.current.set(threadKey, event.text);
      }
    },
    [],
  );

  const handlers = useMemo(
    () => ({
      onTurnStarted: handleTurnStarted,
      onTurnCompleted: handleTurnCompleted,
      onTurnError: handleTurnError,
      onItemStarted: handleItemStarted,
      onAgentMessageDelta: handleAgentMessageDelta,
      onAgentMessageCompleted: handleAgentMessageCompleted,
    }),
    [
      handleAgentMessageCompleted,
      handleAgentMessageDelta,
      handleItemStarted,
      handleTurnCompleted,
      handleTurnError,
      handleTurnStarted,
    ],
  );

  useAppServerEvents(handlers);
}
