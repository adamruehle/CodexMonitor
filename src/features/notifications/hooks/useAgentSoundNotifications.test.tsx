// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playNotificationSound } from "../../../utils/notificationSounds";
import { useAgentSoundNotifications } from "./useAgentSoundNotifications";

const useAppServerEventsMock = vi.fn();

vi.mock("../../../utils/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
}));

vi.mock("../../app/hooks/useAppServerEvents", () => ({
  useAppServerEvents: (handlers: unknown) => useAppServerEventsMock(handlers),
}));

describe("useAgentSoundNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not play completion sound when an intermediary agent message completes", () => {
    renderHook(() =>
      useAgentSoundNotifications({
        enabled: true,
        isWindowFocused: false,
        minDurationMs: 0,
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerEventsMock.mock.calls.length - 1
    ]?.[0] as {
      onTurnStarted?: (workspaceId: string, threadId: string, turnId: string) => void;
      onAgentMessageCompleted?: (event: {
        workspaceId: string;
        threadId: string;
      }) => void;
      onTurnCompleted?: (workspaceId: string, threadId: string, turnId: string) => void;
    };

    act(() => {
      handlers.onTurnStarted?.("ws-1", "thread-1", "turn-1");
      handlers.onAgentMessageCompleted?.({
        workspaceId: "ws-1",
        threadId: "thread-1",
      });
    });

    expect(playNotificationSound).not.toHaveBeenCalled();

    act(() => {
      handlers.onTurnCompleted?.("ws-1", "thread-1", "turn-1");
    });

    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("dedupes repeated terminal completion after late item events", () => {
    renderHook(() =>
      useAgentSoundNotifications({
        enabled: true,
        isWindowFocused: false,
        minDurationMs: 0,
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerEventsMock.mock.calls.length - 1
    ]?.[0] as {
      onTurnStarted?: (workspaceId: string, threadId: string, turnId: string) => void;
      onItemStarted?: (workspaceId: string, threadId: string) => void;
      onTurnCompleted?: (workspaceId: string, threadId: string, turnId: string) => void;
    };

    act(() => {
      handlers.onTurnStarted?.("ws-1", "thread-1", "turn-1");
      handlers.onTurnCompleted?.("ws-1", "thread-1", "turn-1");
      handlers.onItemStarted?.("ws-1", "thread-1");
      handlers.onTurnCompleted?.("ws-1", "thread-1", "turn-1");
    });

    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });
});
