// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "@/types";
import { useWorkspaceOrderingOrchestration } from "./useWorkspaceOrchestration";

function makeWorkspace(
  id: string,
  name: string,
  sortOrder: number,
  groupId: string | null = null,
): WorkspaceInfo {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    connected: true,
    settings: {
      sidebarCollapsed: false,
      sortOrder,
      groupId,
    },
  };
}

describe("useWorkspaceOrderingOrchestration", () => {
  it("persists arbitrary workspace drag reorder within a group", async () => {
    const alpha = makeWorkspace("ws-a", "Alpha", 0);
    const beta = makeWorkspace("ws-b", "Beta", 1);
    const gamma = makeWorkspace("ws-c", "Gamma", 2);
    const workspaces = [alpha, beta, gamma];
    const updateWorkspaceSettings = vi.fn(async (workspaceId, settings) => ({
      ...(workspaces.find((workspace) => workspace.id === workspaceId) ?? alpha),
      settings: {
        sidebarCollapsed: false,
        ...settings,
      },
    }));

    const { result } = renderHook(() =>
      useWorkspaceOrderingOrchestration({
        workspaces,
        workspacesById: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
        updateWorkspaceSettings,
      }),
    );

    await act(async () => {
      await result.current.handleReorderWorkspace("ws-c", "ws-a", "before");
    });

    expect(updateWorkspaceSettings).toHaveBeenCalledTimes(3);
    expect(updateWorkspaceSettings).toHaveBeenNthCalledWith(1, "ws-c", {
      sortOrder: 0,
    });
    expect(updateWorkspaceSettings).toHaveBeenNthCalledWith(2, "ws-a", {
      sortOrder: 1,
    });
    expect(updateWorkspaceSettings).toHaveBeenNthCalledWith(3, "ws-b", {
      sortOrder: 2,
    });
  });

  it("does not reorder across workspace groups", async () => {
    const alpha = makeWorkspace("ws-a", "Alpha", 0, "group-a");
    const beta = makeWorkspace("ws-b", "Beta", 0, "group-b");
    const workspaces = [alpha, beta];
    const updateWorkspaceSettings = vi.fn();

    const { result } = renderHook(() =>
      useWorkspaceOrderingOrchestration({
        workspaces,
        workspacesById: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
        updateWorkspaceSettings,
      }),
    );

    await act(async () => {
      await result.current.handleReorderWorkspace("ws-a", "ws-b", "after");
    });

    expect(updateWorkspaceSettings).not.toHaveBeenCalled();
  });
});
