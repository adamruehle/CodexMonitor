import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppMention,
  ComposerSendIntent,
  DebugEntry,
  FollowUpMessageBehavior,
  QueuedMessage,
  SendMessageResult,
  WorkspaceInfo,
} from "@/types";

type UseQueuedSendOptions = {
  activeThreadId: string | null;
  activeTurnId: string | null;
  isProcessing: boolean;
  isReviewing: boolean;
  queueFlushPaused?: boolean;
  steerEnabled: boolean;
  followUpMessageBehavior: FollowUpMessageBehavior;
  appsEnabled: boolean;
  activeWorkspace: WorkspaceInfo | null;
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
  startThreadForWorkspace: (
    workspaceId: string,
    options?: { activate?: boolean },
  ) => Promise<string | null>;
  sendUserMessage: (
    text: string,
    images?: string[],
    appMentions?: AppMention[],
    options?: { sendIntent?: ComposerSendIntent },
  ) => Promise<SendMessageResult>;
  sendUserMessageToThread: (
    workspace: WorkspaceInfo,
    threadId: string,
    text: string,
    images?: string[],
  ) => Promise<void | SendMessageResult>;
  startFork: (text: string) => Promise<void>;
  startReview: (text: string) => Promise<void>;
  startResume: (text: string) => Promise<void>;
  startCompact: (text: string) => Promise<void>;
  startApps: (text: string) => Promise<void>;
  startMcp: (text: string) => Promise<void>;
  startFast: (text: string) => Promise<void>;
  startStatus: (text: string) => Promise<void>;
  clearActiveImages: () => void;
  onDebug?: (entry: DebugEntry) => void;
};

type UseQueuedSendResult = {
  queuedByThread: Record<string, QueuedMessage[]>;
  activeQueue: QueuedMessage[];
  handleSend: (
    text: string,
    images?: string[],
    appMentions?: AppMention[],
    submitIntent?: ComposerSendIntent,
  ) => Promise<SendMessageResult>;
  queueMessage: (
    text: string,
    images?: string[],
    appMentions?: AppMention[],
  ) => Promise<SendMessageResult>;
  removeQueuedMessage: (threadId: string, messageId: string) => void;
};

type SlashCommandKind =
  | "apps"
  | "compact"
  | "fast"
  | "fork"
  | "mcp"
  | "new"
  | "resume"
  | "review"
  | "status";

function parseSlashCommand(text: string, appsEnabled: boolean): SlashCommandKind | null {
  if (appsEnabled && /^\/apps\b/i.test(text)) {
    return "apps";
  }
  if (/^\/fork\b/i.test(text)) {
    return "fork";
  }
  if (/^\/fast\b/i.test(text)) {
    return "fast";
  }
  if (/^\/mcp\b/i.test(text)) {
    return "mcp";
  }
  if (/^\/review\b/i.test(text)) {
    return "review";
  }
  if (/^\/compact\b/i.test(text)) {
    return "compact";
  }
  if (/^\/new\b/i.test(text)) {
    return "new";
  }
  if (/^\/resume\b/i.test(text)) {
    return "resume";
  }
  if (/^\/status\b/i.test(text)) {
    return "status";
  }
  return null;
}

export function useQueuedSend({
  activeThreadId,
  activeTurnId,
  isProcessing,
  isReviewing,
  queueFlushPaused = false,
  steerEnabled,
  followUpMessageBehavior,
  appsEnabled,
  activeWorkspace,
  connectWorkspace,
  startThreadForWorkspace,
  sendUserMessage,
  sendUserMessageToThread,
  startFork,
  startReview,
  startResume,
  startCompact,
  startApps,
  startMcp,
  startFast,
  startStatus,
  clearActiveImages,
  onDebug,
}: UseQueuedSendOptions): UseQueuedSendResult {
  const [queuedByThread, setQueuedByThread] = useState<
    Record<string, QueuedMessage[]>
  >({});
  const [inFlightByThread, setInFlightByThread] = useState<
    Record<string, QueuedMessage | null>
  >({});
  const [hasStartedByThread, setHasStartedByThread] = useState<
    Record<string, boolean>
  >({});

  const activeQueue = useMemo(
    () => (activeThreadId ? queuedByThread[activeThreadId] ?? [] : []),
    [activeThreadId, queuedByThread],
  );
  const isActivelyReviewing = isProcessing && isReviewing;

  const enqueueMessage = useCallback((threadId: string, item: QueuedMessage) => {
    setQueuedByThread((prev) => ({
      ...prev,
      [threadId]: [...(prev[threadId] ?? []), item],
    }));
  }, []);

  const removeQueuedMessage = useCallback(
    (threadId: string, messageId: string) => {
      setQueuedByThread((prev) => ({
        ...prev,
        [threadId]: (prev[threadId] ?? []).filter(
          (entry) => entry.id !== messageId,
        ),
      }));
    },
    [],
  );

  const prependQueuedMessage = useCallback((threadId: string, item: QueuedMessage) => {
    setQueuedByThread((prev) => ({
      ...prev,
      [threadId]: [item, ...(prev[threadId] ?? [])],
    }));
  }, []);

  const createQueuedItem = useCallback(
    (text: string, images: string[], appMentions: AppMention[]): QueuedMessage => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      createdAt: Date.now(),
      images,
      ...(appMentions.length > 0 ? { appMentions } : {}),
    }),
    [],
  );

  const logComposerSend = useCallback(
    (label: string, payload: Record<string, unknown>, source: DebugEntry["source"] = "client") => {
      onDebug?.({
        id: `${Date.now()}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
        timestamp: Date.now(),
        source,
        label,
        payload,
      });
    },
    [onDebug],
  );

  const runSlashCommand = useCallback(
    async (command: SlashCommandKind, trimmed: string): Promise<SendMessageResult> => {
      if (command === "fork") {
        await startFork(trimmed);
        return { status: "sent" };
      }
      if (command === "review") {
        await startReview(trimmed);
        return { status: "sent" };
      }
      if (command === "resume") {
        await startResume(trimmed);
        return { status: "sent" };
      }
      if (command === "compact") {
        await startCompact(trimmed);
        return { status: "sent" };
      }
      if (command === "apps") {
        await startApps(trimmed);
        return { status: "sent" };
      }
      if (command === "mcp") {
        await startMcp(trimmed);
        return { status: "sent" };
      }
      if (command === "fast") {
        await startFast(trimmed);
        return { status: "sent" };
      }
      if (command === "status") {
        await startStatus(trimmed);
        return { status: "sent" };
      }
      if (command === "new" && activeWorkspace) {
        const threadId = await startThreadForWorkspace(activeWorkspace.id);
        const rest = trimmed.replace(/^\/new\b/i, "").trim();
        if (threadId && rest) {
          await sendUserMessageToThread(activeWorkspace, threadId, rest, []);
        }
        return threadId
          ? { status: "sent" }
          : {
              status: "blocked",
              message: "Could not start a new thread for this workspace.",
            };
      }
      return {
        status: "blocked",
        message: "No active workspace is available for this command.",
      };
    },
    [
      activeWorkspace,
      sendUserMessageToThread,
      startFork,
      startReview,
      startResume,
      startCompact,
      startApps,
      startMcp,
      startFast,
      startStatus,
      startThreadForWorkspace,
    ],
  );

  const handleSend = useCallback(
    async (
      text: string,
      images: string[] = [],
      appMentions: AppMention[] = [],
      submitIntent: ComposerSendIntent = "default",
    ): Promise<SendMessageResult> => {
      const trimmed = text.trim();
      const command = parseSlashCommand(trimmed, appsEnabled);
      const nextImages = command ? [] : images;
      const nextMentions = command ? [] : appMentions;
      const canSteerCurrentTurn =
        isProcessing && steerEnabled && Boolean(activeTurnId);
      const effectiveIntent: ComposerSendIntent = !isProcessing
        ? "default"
        : submitIntent === "queue"
          ? "queue"
          : submitIntent === "steer"
            ? canSteerCurrentTurn
              ? "steer"
              : "queue"
            : followUpMessageBehavior === "steer" && canSteerCurrentTurn
              ? "steer"
              : "queue";
      const baseDebugPayload = {
        activeThreadId,
        activeTurnId,
        workspaceId: activeWorkspace?.id ?? null,
        workspaceConnected: activeWorkspace?.connected ?? null,
        isProcessing,
        isReviewing,
        isActivelyReviewing,
        queueFlushPaused,
        steerEnabled,
        canSteerCurrentTurn,
        followUpMessageBehavior,
        submitIntent,
        effectiveIntent,
        command,
        textLength: trimmed.length,
        imagesCount: nextImages.length,
        appMentionsCount: nextMentions.length,
      };
      const finish = (
        result: SendMessageResult,
        extra: Record<string, unknown> = {},
      ): SendMessageResult => {
        logComposerSend("composer/send result", {
          ...baseDebugPayload,
          status: result.status,
          message: result.message ?? null,
          ...extra,
        }, result.status === "blocked" ? "error" : "client");
        return result;
      };
      logComposerSend("composer/send requested", baseDebugPayload);
      if (!trimmed && nextImages.length === 0) {
        return finish({ status: "blocked", message: "Nothing to send." });
      }
      if (activeThreadId && isActivelyReviewing) {
        return finish({
          status: "blocked",
          message: "Review is still active for this thread.",
        });
      }
      if (isProcessing && activeThreadId && effectiveIntent === "queue") {
        const item = createQueuedItem(trimmed, nextImages, nextMentions);
        enqueueMessage(activeThreadId, item);
        clearActiveImages();
        return finish({ status: "queued" }, { queuedMessageId: item.id });
      }
      if (activeWorkspace && !activeWorkspace.connected) {
        await connectWorkspace(activeWorkspace);
      }
      if (command) {
        const result = await runSlashCommand(command, trimmed);
        if (result.status !== "blocked") {
          clearActiveImages();
        }
        return finish(result, { routedTo: "slash-command" });
      }
      const sendResult =
        nextMentions.length > 0
          ? await sendUserMessage(trimmed, nextImages, nextMentions, {
              sendIntent: effectiveIntent,
            })
          : await sendUserMessage(trimmed, nextImages, undefined, {
              sendIntent: effectiveIntent,
            });
      if (
        sendResult.status === "steer_failed" &&
        activeThreadId &&
        isProcessing
      ) {
        const item = createQueuedItem(trimmed, nextImages, nextMentions);
        enqueueMessage(activeThreadId, item);
        clearActiveImages();
        return finish(
          { status: "queued" },
          { routedTo: "steer-fallback-queue", queuedMessageId: item.id },
        );
      }
      if (sendResult.status !== "blocked") {
        clearActiveImages();
      }
      return finish(sendResult, { routedTo: "thread-message" });
    },
    [
      activeThreadId,
      appsEnabled,
      activeWorkspace,
      clearActiveImages,
      connectWorkspace,
      createQueuedItem,
      enqueueMessage,
      activeTurnId,
      followUpMessageBehavior,
      isProcessing,
      isActivelyReviewing,
      isReviewing,
      logComposerSend,
      queueFlushPaused,
      steerEnabled,
      runSlashCommand,
      sendUserMessage,
    ],
  );

  const queueMessage = useCallback(
    async (
      text: string,
      images: string[] = [],
      appMentions: AppMention[] = [],
    ): Promise<SendMessageResult> => {
      const trimmed = text.trim();
      const command = parseSlashCommand(trimmed, appsEnabled);
      const nextImages = command ? [] : images;
      const nextMentions = command ? [] : appMentions;
      if (!trimmed && nextImages.length === 0) {
        return { status: "blocked", message: "Nothing to queue." };
      }
      if (activeThreadId && isActivelyReviewing) {
        return {
          status: "blocked",
          message: "Review is still active for this thread.",
        };
      }
      if (!activeThreadId) {
        return {
          status: "blocked",
          message: "No active thread is available for this queued message.",
        };
      }
      const item = createQueuedItem(trimmed, nextImages, nextMentions);
      enqueueMessage(activeThreadId, item);
      clearActiveImages();
      return { status: "queued" };
    },
    [
      activeThreadId,
      appsEnabled,
      clearActiveImages,
      createQueuedItem,
      enqueueMessage,
      isActivelyReviewing,
    ],
  );

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }
    const inFlight = inFlightByThread[activeThreadId];
    if (!inFlight) {
      return;
    }
    if (isProcessing || isActivelyReviewing) {
      if (!hasStartedByThread[activeThreadId]) {
        setHasStartedByThread((prev) => ({
          ...prev,
          [activeThreadId]: true,
        }));
      }
      return;
    }
    if (hasStartedByThread[activeThreadId]) {
      setInFlightByThread((prev) => ({ ...prev, [activeThreadId]: null }));
      setHasStartedByThread((prev) => ({ ...prev, [activeThreadId]: false }));
    }
  }, [
    activeThreadId,
    hasStartedByThread,
    inFlightByThread,
    isProcessing,
    isActivelyReviewing,
  ]);

  useEffect(() => {
    if (!activeThreadId || isProcessing || isActivelyReviewing || queueFlushPaused) {
      return;
    }
    if (inFlightByThread[activeThreadId]) {
      return;
    }
    const queue = queuedByThread[activeThreadId] ?? [];
    if (queue.length === 0) {
      return;
    }
    const threadId = activeThreadId;
    const nextItem = queue[0];
    logComposerSend("queue/flush started", {
      threadId,
      queuedMessageId: nextItem.id,
      textLength: nextItem.text.trim().length,
      imagesCount: nextItem.images?.length ?? 0,
      appMentionsCount: nextItem.appMentions?.length ?? 0,
    });
    setInFlightByThread((prev) => ({ ...prev, [threadId]: nextItem }));
    setHasStartedByThread((prev) => ({ ...prev, [threadId]: false }));
    setQueuedByThread((prev) => ({
      ...prev,
      [threadId]: (prev[threadId] ?? []).slice(1),
    }));
    (async () => {
      try {
        const trimmed = nextItem.text.trim();
        const command = parseSlashCommand(trimmed, appsEnabled);
        if (command) {
          const result = await runSlashCommand(command, trimmed);
          logComposerSend("queue/flush result", {
            threadId,
            queuedMessageId: nextItem.id,
            status: result.status,
            message: result.message ?? null,
            routedTo: "slash-command",
          }, result.status === "blocked" ? "error" : "client");
        } else {
          const queuedMentions = nextItem.appMentions ?? [];
          let result: SendMessageResult;
          if (queuedMentions.length > 0) {
            result = await sendUserMessage(
              nextItem.text,
              nextItem.images ?? [],
              queuedMentions,
            );
          } else {
            result = await sendUserMessage(nextItem.text, nextItem.images ?? []);
          }
          logComposerSend("queue/flush result", {
            threadId,
            queuedMessageId: nextItem.id,
            status: result.status,
            message: result.message ?? null,
            routedTo: "thread-message",
          }, result.status === "blocked" ? "error" : "client");
        }
      } catch (error) {
        logComposerSend("queue/flush error", {
          threadId,
          queuedMessageId: nextItem.id,
          message: error instanceof Error ? error.message : String(error),
        }, "error");
        setInFlightByThread((prev) => ({ ...prev, [threadId]: null }));
        setHasStartedByThread((prev) => ({ ...prev, [threadId]: false }));
        prependQueuedMessage(threadId, nextItem);
      }
    })();
  }, [
    activeThreadId,
    appsEnabled,
    inFlightByThread,
    isProcessing,
    isActivelyReviewing,
    queueFlushPaused,
    prependQueuedMessage,
    queuedByThread,
    runSlashCommand,
    sendUserMessage,
    logComposerSend,
  ]);

  return {
    queuedByThread,
    activeQueue,
    handleSend,
    queueMessage,
    removeQueuedMessage,
  };
}
