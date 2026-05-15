// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORAGE_KEY_CUSTOM_NAMES,
  STORAGE_KEY_PINNED_THREAD_ORDER,
  loadCustomNames,
  loadPinnedThreadOrder,
  loadPinnedThreads,
  loadThreadActivity,
  savePinnedThreadOrder,
  savePinnedThreads,
  saveThreadActivity,
} from "@threads/utils/threadStorage";
import { useThreadStorage } from "./useThreadStorage";

vi.mock("@threads/utils/threadStorage", () => ({
  MAX_PINS_SOFT_LIMIT: 2,
  STORAGE_KEY_CUSTOM_NAMES: "custom-names",
  STORAGE_KEY_PINNED_THREAD_ORDER: "pinned-thread-order",
  STORAGE_KEY_PINNED_THREADS: "pinned-threads",
  loadCustomNames: vi.fn(),
  loadPinnedThreadOrder: vi.fn(() => []),
  loadPinnedThreads: vi.fn(),
  loadThreadActivity: vi.fn(),
  makeCustomNameKey: (workspaceId: string, threadId: string) =>
    `${workspaceId}:${threadId}`,
  makePinKey: (workspaceId: string, threadId: string) =>
    `${workspaceId}:${threadId}`,
  normalizePinnedThreadOrder: (
    pinned: Record<string, number>,
    order: string[],
  ) => {
    const normalized = order.filter(
      (entry, index) => entry in pinned && order.indexOf(entry) === index,
    );
    Object.entries(pinned)
      .sort(([, a], [, b]) => a - b)
      .map(([key]) => key)
      .forEach((key) => {
        if (!normalized.includes(key)) {
          normalized.push(key);
        }
      });
    return normalized;
  },
  savePinnedThreadOrder: vi.fn(),
  savePinnedThreads: vi.fn(),
  saveThreadActivity: vi.fn(),
}));

describe("useThreadStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads initial data and updates custom names on storage events", async () => {
    vi.mocked(loadThreadActivity).mockReturnValue({
      "ws-1": { "thread-1": 101 },
    });
    vi.mocked(loadPinnedThreads).mockReturnValue({ "ws-1:thread-1": 202 });
    vi.mocked(loadPinnedThreadOrder).mockReturnValue(["ws-1:thread-1"]);
    vi
      .mocked(loadCustomNames)
      .mockReturnValueOnce({ "ws-1:thread-1": "Custom" })
      .mockReturnValueOnce({ "ws-1:thread-1": "Custom" })
      .mockReturnValueOnce({ "ws-1:thread-1": "Updated" });

    const { result } = renderHook(() => useThreadStorage());

    expect(result.current.threadActivityRef.current).toEqual({
      "ws-1": { "thread-1": 101 },
    });
    expect(result.current.pinnedThreadsRef.current).toEqual({
      "ws-1:thread-1": 202,
    });

    expect(result.current.getCustomName("ws-1", "thread-1")).toBe("Custom");

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY_CUSTOM_NAMES }),
      );
    });

    await waitFor(() => {
      expect(result.current.getCustomName("ws-1", "thread-1")).toBe("Updated");
    });
  });

  it("records thread activity and persists updates", () => {
    vi.mocked(loadThreadActivity).mockReturnValue({});
    vi.mocked(loadPinnedThreads).mockReturnValue({});
    vi.mocked(loadPinnedThreadOrder).mockReturnValue([]);
    vi.mocked(loadCustomNames).mockReturnValue({});

    const { result } = renderHook(() => useThreadStorage());

    act(() => {
      result.current.recordThreadActivity("ws-2", "thread-9", 999);
    });

    expect(result.current.threadActivityRef.current).toEqual({
      "ws-2": { "thread-9": 999 },
    });
    expect(saveThreadActivity).toHaveBeenCalledWith({
      "ws-2": { "thread-9": 999 },
    });
  });

  it("pins and unpins threads while updating persistence", () => {
    vi.mocked(loadThreadActivity).mockReturnValue({});
    vi.mocked(loadPinnedThreads).mockReturnValue({});
    vi.mocked(loadPinnedThreadOrder).mockReturnValue([]);
    vi.mocked(loadCustomNames).mockReturnValue({});

    const { result } = renderHook(() => useThreadStorage());

    let pinResult = false;
    act(() => {
      pinResult = result.current.pinThread("ws-1", "thread-1");
    });

    expect(pinResult).toBe(true);
    expect(result.current.isThreadPinned("ws-1", "thread-1")).toBe(true);
    expect(savePinnedThreads).toHaveBeenCalledWith({
      "ws-1:thread-1": expect.any(Number),
    });
    expect(savePinnedThreadOrder).toHaveBeenCalledWith(["ws-1:thread-1"]);

    const versionAfterPin = result.current.pinnedThreadsVersion;

    act(() => {
      result.current.unpinThread("ws-1", "thread-1");
    });

    expect(result.current.isThreadPinned("ws-1", "thread-1")).toBe(false);
    expect(savePinnedThreads).toHaveBeenCalledWith({});
    expect(savePinnedThreadOrder).toHaveBeenCalledWith([]);
    expect(result.current.pinnedThreadsVersion).toBe(versionAfterPin + 1);
  });

  it("reorders pinned threads and persists the explicit pinned order", () => {
    vi.mocked(loadThreadActivity).mockReturnValue({});
    vi.mocked(loadPinnedThreads).mockReturnValue({
      "ws-1:thread-1": 100,
      "ws-2:thread-2": 200,
      "ws-3:thread-3": 300,
    });
    vi
      .mocked(loadPinnedThreadOrder)
      .mockReturnValue(["ws-1:thread-1", "ws-2:thread-2", "ws-3:thread-3"]);
    vi.mocked(loadCustomNames).mockReturnValue({});

    const { result } = renderHook(() => useThreadStorage());

    act(() => {
      result.current.reorderPinnedThread(
        "ws-3",
        "thread-3",
        "ws-1",
        "thread-1",
        "before",
      );
    });

    expect(savePinnedThreads).toHaveBeenLastCalledWith({
      "ws-1:thread-1": 100,
      "ws-2:thread-2": 200,
      "ws-3:thread-3": 300,
    });
    expect(savePinnedThreadOrder).toHaveBeenLastCalledWith([
      "ws-3:thread-3",
      "ws-1:thread-1",
      "ws-2:thread-2",
    ]);
    expect(result.current.getPinTimestamp("ws-3", "thread-3")).toBe(0);
    expect(result.current.getPinTimestamp("ws-1", "thread-1")).toBe(1);
  });

  it("ignores duplicate pins and reacts to pinned storage changes", async () => {
    vi.mocked(loadThreadActivity).mockReturnValue({});
    vi.mocked(loadPinnedThreads).mockReturnValue({ "ws-1:thread-1": 123 });
    vi.mocked(loadPinnedThreadOrder).mockReturnValue(["ws-1:thread-1"]);
    vi.mocked(loadCustomNames).mockReturnValue({});

    const { result } = renderHook(() => useThreadStorage());

    let pinResult = true;
    act(() => {
      pinResult = result.current.pinThread("ws-1", "thread-1");
    });

    expect(pinResult).toBe(false);
    expect(savePinnedThreads).not.toHaveBeenCalled();

    const versionBefore = result.current.pinnedThreadsVersion;

    vi.mocked(loadPinnedThreads).mockReturnValue({ "ws-1:thread-2": 456 });
    vi.mocked(loadPinnedThreadOrder).mockReturnValue(["ws-1:thread-2"]);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY_PINNED_THREAD_ORDER }),
      );
    });

    await waitFor(() => {
      expect(result.current.pinnedThreadsVersion).toBe(versionBefore + 1);
    });
    expect(result.current.isThreadPinned("ws-1", "thread-2")).toBe(true);
  });
});
