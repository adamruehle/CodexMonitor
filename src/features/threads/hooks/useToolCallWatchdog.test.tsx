// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interruptTurn } from "@services/tauri";
import { useToolCallWatchdog } from "./useToolCallWatchdog";
import type { RunningToolCall, ThreadState } from "./useThreadsReducer";
import type {
  ApprovalRequest,
  RequestUserInputRequest,
  WorkspaceInfo,
} from "@/types";

vi.mock("@services/tauri", () => ({
  interruptTurn: vi.fn(),
}));

const activeWorkspace: WorkspaceInfo = {
  id: "ws-1",
  name: "Workspace",
  path: "/tmp/ws-1",
  connected: true,
  settings: { sidebarCollapsed: false },
};

const staleToolCall: RunningToolCall = {
  id: "tool-1",
  workspaceId: "ws-1",
  threadId: "thread-1",
  turnId: "turn-1",
  toolType: "mcpToolCall",
  title: "Tool: dope / get_service_skills",
  detail: "{}",
  startedAt: 0,
  lastSeenAt: 0,
};

const approvalRequest: ApprovalRequest = {
  workspace_id: "ws-1",
  request_id: 1,
  method: "item/permissions/requestApproval",
  params: { threadId: "thread-1" },
};

const userInputRequest: RequestUserInputRequest = {
  workspace_id: "ws-1",
  request_id: 2,
  params: {
    thread_id: "thread-1",
    turn_id: "turn-1",
    item_id: "tool-1",
    questions: [
      {
        id: "confirm",
        header: "Confirm",
        question: "Proceed?",
      },
    ],
  },
};

function makeStatus(
  patch: Partial<ThreadState["threadStatusById"][string]> = {},
): ThreadState["threadStatusById"][string] {
  return {
    isProcessing: true,
    hasUnread: false,
    isReviewing: false,
    processingStartedAt: 0,
    lastDurationMs: null,
    activeFlags: [],
    ...patch,
  };
}

function makeProps(
  overrides: Partial<Parameters<typeof useToolCallWatchdog>[0]> = {},
): Parameters<typeof useToolCallWatchdog>[0] {
  return {
    activeWorkspace,
    runningToolCallsByThread: {
      "thread-1": {
        "tool-1": staleToolCall,
      },
    },
    threadStatusById: {
      "thread-1": makeStatus(),
    },
    activeTurnIdByThread: {
      "thread-1": "turn-1",
    },
    approvals: [],
    userInputRequests: [],
    dispatch: vi.fn(),
    onDebug: vi.fn(),
    sendUserMessageToThread: vi.fn().mockResolvedValue({ status: "sent" }),
    ...overrides,
  };
}

describe("useToolCallWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(121_000);
    vi.mocked(interruptTurn).mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("interrupts a running tool call after the timeout", () => {
    const dispatch = vi.fn();
    renderHook((props) => useToolCallWatchdog(props), {
      initialProps: makeProps({ dispatch }),
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(interruptTurn).toHaveBeenCalledWith("ws-1", "thread-1", "turn-1");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "addAssistantMessage",
        threadId: "thread-1",
        text: expect.stringContaining("appeared hung"),
        turnId: "turn-1",
      }),
    );
  });

  it("does not interrupt while a matching approval request is visible", () => {
    renderHook((props) => useToolCallWatchdog(props), {
      initialProps: makeProps({
        threadStatusById: {
          "thread-1": makeStatus({ activeFlags: ["waitingOnApproval"] }),
        },
        approvals: [approvalRequest],
      }),
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it("does not interrupt while a matching user-input request is visible", () => {
    renderHook((props) => useToolCallWatchdog(props), {
      initialProps: makeProps({
        threadStatusById: {
          "thread-1": makeStatus({ activeFlags: ["waitingForUserInput"] }),
        },
        userInputRequests: [userInputRequest],
      }),
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it("interrupts when the thread only has a stale invisible human-wait flag", () => {
    const onDebug = vi.fn();
    renderHook((props) => useToolCallWatchdog(props), {
      initialProps: makeProps({
        threadStatusById: {
          "thread-1": makeStatus({ activeFlags: ["waitingOnApproval"] }),
        },
        onDebug,
      }),
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(interruptTurn).toHaveBeenCalledWith("ws-1", "thread-1", "turn-1");
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "tool/watchdog timeout",
        payload: expect.objectContaining({
          staleHumanWaitFlags: ["waitingOnApproval"],
        }),
      }),
    );
  });

  it("sends a continuation prompt after the interrupted turn settles", async () => {
    const sendUserMessageToThread = vi.fn().mockResolvedValue({ status: "sent" });
    const { rerender } = renderHook((props) => useToolCallWatchdog(props), {
      initialProps: makeProps({ sendUserMessageToThread }),
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    rerender(
      makeProps({
        runningToolCallsByThread: {},
        threadStatusById: {
          "thread-1": makeStatus({ isProcessing: false, processingStartedAt: null }),
        },
        activeTurnIdByThread: {
          "thread-1": null,
        },
        sendUserMessageToThread,
      }),
    );

    await act(async () => {});

    expect(sendUserMessageToThread).toHaveBeenCalledWith(
      activeWorkspace,
      "thread-1",
      expect.stringContaining("Continue from the last completed step."),
      [],
      { skipPromptExpansion: true },
    );
  });
});
