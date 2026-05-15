import { useEffect, useRef } from "react";
import type { Dispatch } from "react";
import type {
  ApprovalRequest,
  DebugEntry,
  RequestUserInputRequest,
  SendMessageResult,
  WorkspaceInfo,
} from "@/types";
import { interruptTurn as interruptTurnService } from "@services/tauri";
import type { SendMessageOptions } from "./threadMessagingHelpers";
import type {
  RunningToolCall,
  ThreadAction,
  ThreadState,
} from "./useThreadsReducer";

const TOOL_CALL_WATCHDOG_TIMEOUT_MS = 120_000;
const TOOL_CALL_WATCHDOG_POLL_MS = 5_000;

type PendingContinuation = {
  workspaceId: string;
  threadId: string;
  turnId: string;
  toolCall: RunningToolCall;
  interruptedAt: number;
  sending: boolean;
};

type UseToolCallWatchdogOptions = {
  activeWorkspace: WorkspaceInfo | null;
  runningToolCallsByThread: ThreadState["runningToolCallsByThread"];
  threadStatusById: ThreadState["threadStatusById"];
  activeTurnIdByThread: ThreadState["activeTurnIdByThread"];
  approvals: ApprovalRequest[];
  userInputRequests: RequestUserInputRequest[];
  dispatch: Dispatch<ThreadAction>;
  onDebug?: (entry: DebugEntry) => void;
  sendUserMessageToThread: (
    workspace: WorkspaceInfo,
    threadId: string,
    text: string,
    images?: string[],
    options?: SendMessageOptions,
  ) => Promise<SendMessageResult>;
};

function watchdogKey(workspaceId: string, threadId: string, turnId: string) {
  return `${workspaceId}:${threadId}:${turnId}`;
}

function normalizeFlag(flag: string) {
  return flag.toLowerCase().replace(/[\s_-]+/g, "");
}

function isHumanWaitFlag(flag: string) {
  const normalized = normalizeFlag(flag);
  return (
    normalized.includes("approval") ||
    normalized.includes("userinput") ||
    normalized.includes("human")
  );
}

function requestThreadId(params: Record<string, unknown>) {
  const thread =
    params.thread && typeof params.thread === "object" && !Array.isArray(params.thread)
      ? (params.thread as Record<string, unknown>)
      : null;
  const raw =
    params.threadId ??
    params.thread_id ??
    thread?.id;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function requestMatchesThread(
  workspaceId: string,
  threadId: string,
  requestWorkspaceId: string,
  params: Record<string, unknown>,
) {
  if (requestWorkspaceId !== workspaceId) {
    return false;
  }
  const requestThread = requestThreadId(params);
  return !requestThread || requestThread === threadId;
}

function hasMatchingApprovalRequest({
  workspaceId,
  threadId,
  approvals,
}: {
  workspaceId: string;
  threadId: string;
  approvals: ApprovalRequest[];
}) {
  return approvals.some((approval) =>
    requestMatchesThread(
      workspaceId,
      threadId,
      approval.workspace_id,
      approval.params ?? {},
    ),
  );
}

function hasMatchingUserInputRequest({
  workspaceId,
  threadId,
  userInputRequests,
}: {
  workspaceId: string;
  threadId: string;
  userInputRequests: RequestUserInputRequest[];
}) {
  return userInputRequests.some(
    (request) =>
      request.workspace_id === workspaceId && request.params.thread_id === threadId,
  );
}

function hasVisibleHumanBlocker({
  workspaceId,
  threadId,
  approvals,
  userInputRequests,
}: {
  workspaceId: string;
  threadId: string;
  approvals: ApprovalRequest[];
  userInputRequests: RequestUserInputRequest[];
}) {
  if (hasMatchingApprovalRequest({ workspaceId, threadId, approvals })) {
    return true;
  }
  return hasMatchingUserInputRequest({ workspaceId, threadId, userInputRequests });
}

function buildTimeoutNotice(toolCall: RunningToolCall) {
  return [
    `CodexMonitor interrupted a tool call that appeared hung for over ${TOOL_CALL_WATCHDOG_TIMEOUT_MS / 1_000} seconds.`,
    `Tool: ${toolCall.title}`,
    "It will ask the agent to continue once the interrupted turn settles.",
  ].join("\n");
}

function buildContinuationPrompt(toolCall: RunningToolCall) {
  return [
    `CodexMonitor interrupted the previous turn because this tool call appeared to hang for over ${TOOL_CALL_WATCHDOG_TIMEOUT_MS / 1_000} seconds: ${toolCall.title}.`,
    "Continue from the last completed step.",
    "Do not retry the same hung tool call unless it is necessary; if it is necessary, explain why before retrying it.",
  ].join("\n");
}

function oldestRunningToolCall(
  runningToolCallsByThread: ThreadState["runningToolCallsByThread"],
) {
  return Object.values(runningToolCallsByThread)
    .flatMap((toolCallsById) => Object.values(toolCallsById))
    .sort((left, right) => left.startedAt - right.startedAt);
}

export function useToolCallWatchdog({
  activeWorkspace,
  runningToolCallsByThread,
  threadStatusById,
  activeTurnIdByThread,
  approvals,
  userInputRequests,
  dispatch,
  onDebug,
  sendUserMessageToThread,
}: UseToolCallWatchdogOptions) {
  const interruptedTurnKeysRef = useRef<Set<string>>(new Set());
  const pendingContinuationsRef = useRef<Record<string, PendingContinuation>>({});

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const toolCalls = oldestRunningToolCall(runningToolCallsByThread);
      for (const toolCall of toolCalls) {
        const elapsedMs = now - toolCall.startedAt;
        if (elapsedMs < TOOL_CALL_WATCHDOG_TIMEOUT_MS) {
          continue;
        }
        const activeTurnId = activeTurnIdByThread[toolCall.threadId] ?? null;
        const turnId = toolCall.turnId ?? activeTurnId;
        if (!turnId) {
          continue;
        }
        const threadStatus = threadStatusById[toolCall.threadId];
        if (!threadStatus?.isProcessing) {
          continue;
        }
        const activeFlags = threadStatus.activeFlags ?? [];
        if (hasVisibleHumanBlocker({
          workspaceId: toolCall.workspaceId,
          threadId: toolCall.threadId,
          approvals,
          userInputRequests,
        })) {
          continue;
        }
        const key = watchdogKey(toolCall.workspaceId, toolCall.threadId, turnId);
        if (interruptedTurnKeysRef.current.has(key)) {
          continue;
        }

        interruptedTurnKeysRef.current.add(key);
        pendingContinuationsRef.current[key] = {
          workspaceId: toolCall.workspaceId,
          threadId: toolCall.threadId,
          turnId,
          toolCall,
          interruptedAt: now,
          sending: false,
        };

        dispatch({
          type: "addAssistantMessage",
          threadId: toolCall.threadId,
          text: buildTimeoutNotice(toolCall),
          turnId,
          timestampMs: now,
        });
        onDebug?.({
          id: `${now}-client-tool-watchdog-timeout`,
          timestamp: now,
          source: "client",
          label: "tool/watchdog timeout",
          payload: {
            workspaceId: toolCall.workspaceId,
            threadId: toolCall.threadId,
            turnId,
            itemId: toolCall.id,
            toolType: toolCall.toolType,
            title: toolCall.title,
            elapsedMs,
            staleHumanWaitFlags: activeFlags.filter(isHumanWaitFlag),
          },
        });

        void interruptTurnService(toolCall.workspaceId, toolCall.threadId, turnId)
          .then((response) => {
            onDebug?.({
              id: `${Date.now()}-server-tool-watchdog-interrupt`,
              timestamp: Date.now(),
              source: "server",
              label: "tool/watchdog interrupt response",
              payload: {
                workspaceId: toolCall.workspaceId,
                threadId: toolCall.threadId,
                turnId,
                response,
              },
            });
          })
          .catch((error) => {
            delete pendingContinuationsRef.current[key];
            onDebug?.({
              id: `${Date.now()}-client-tool-watchdog-interrupt-error`,
              timestamp: Date.now(),
              source: "error",
              label: "tool/watchdog interrupt error",
              payload: {
                workspaceId: toolCall.workspaceId,
                threadId: toolCall.threadId,
                turnId,
                error: error instanceof Error ? error.message : String(error),
              },
            });
            dispatch({
              type: "addAssistantMessage",
              threadId: toolCall.threadId,
              text: `Tool watchdog failed to interrupt the hung tool call: ${
                error instanceof Error ? error.message : String(error)
              }`,
              turnId,
              timestampMs: Date.now(),
            });
          });
      }
    }, TOOL_CALL_WATCHDOG_POLL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    activeTurnIdByThread,
    approvals,
    dispatch,
    onDebug,
    runningToolCallsByThread,
    threadStatusById,
    userInputRequests,
  ]);

  useEffect(() => {
    if (!activeWorkspace?.connected) {
      return;
    }
    Object.entries(pendingContinuationsRef.current).forEach(([key, pending]) => {
      if (pending.sending) {
        return;
      }
      if (pending.workspaceId !== activeWorkspace.id) {
        return;
      }
      const threadStatus = threadStatusById[pending.threadId];
      const activeTurnId = activeTurnIdByThread[pending.threadId] ?? null;
      if (threadStatus?.isProcessing || activeTurnId) {
        return;
      }

      pending.sending = true;
      const timestamp = Date.now();
      onDebug?.({
        id: `${timestamp}-client-tool-watchdog-auto-continue`,
        timestamp,
        source: "client",
        label: "tool/watchdog auto-continue",
        payload: {
          workspaceId: pending.workspaceId,
          threadId: pending.threadId,
          turnId: pending.turnId,
          interruptedAt: pending.interruptedAt,
          title: pending.toolCall.title,
        },
      });

      void sendUserMessageToThread(
        activeWorkspace,
        pending.threadId,
        buildContinuationPrompt(pending.toolCall),
        [],
        { skipPromptExpansion: true },
      )
        .then(() => {
          delete pendingContinuationsRef.current[key];
        })
        .catch((error) => {
          pending.sending = false;
          onDebug?.({
            id: `${Date.now()}-client-tool-watchdog-auto-continue-error`,
            timestamp: Date.now(),
            source: "error",
            label: "tool/watchdog auto-continue error",
            payload: {
              workspaceId: pending.workspaceId,
              threadId: pending.threadId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        });
    });
  }, [
    activeTurnIdByThread,
    activeWorkspace,
    onDebug,
    sendUserMessageToThread,
    threadStatusById,
  ]);
}
