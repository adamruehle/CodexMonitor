import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  MAX_PINS_SOFT_LIMIT,
  STORAGE_KEY_CUSTOM_NAMES,
  STORAGE_KEY_PINNED_THREADS,
  STORAGE_KEY_PINNED_THREAD_ORDER,
  type CustomNamesMap,
  type PinnedThreadOrder,
  type PinnedThreadsMap,
  type ThreadActivityMap,
  loadCustomNames,
  loadPinnedThreadOrder,
  loadPinnedThreads,
  loadThreadActivity,
  makeCustomNameKey,
  makePinKey,
  normalizePinnedThreadOrder,
  savePinnedThreadOrder,
  savePinnedThreads,
  saveThreadActivity,
} from "@threads/utils/threadStorage";

function loadNormalizedPinnedState(): {
  pinned: PinnedThreadsMap;
  order: PinnedThreadOrder;
} {
  const pinned = loadPinnedThreads();
  return {
    pinned,
    order: normalizePinnedThreadOrder(pinned, loadPinnedThreadOrder()),
  };
}

type UseThreadStorageResult = {
  customNamesRef: MutableRefObject<CustomNamesMap>;
  pinnedThreadsRef: MutableRefObject<PinnedThreadsMap>;
  pinnedThreadOrderRef: MutableRefObject<PinnedThreadOrder>;
  threadActivityRef: MutableRefObject<ThreadActivityMap>;
  customNamesVersion: number;
  pinnedThreadsVersion: number;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  recordThreadActivity: (
    workspaceId: string,
    threadId: string,
    timestamp?: number,
  ) => void;
  pinThread: (workspaceId: string, threadId: string) => boolean;
  unpinThread: (workspaceId: string, threadId: string) => void;
  reorderPinnedThread: (
    sourceWorkspaceId: string,
    sourceThreadId: string,
    targetWorkspaceId: string,
    targetThreadId: string,
    position: "before" | "after",
  ) => void;
  isThreadPinned: (workspaceId: string, threadId: string) => boolean;
  getPinTimestamp: (workspaceId: string, threadId: string) => number | null;
};

export function useThreadStorage(): UseThreadStorageResult {
  const threadActivityRef = useRef<ThreadActivityMap>(loadThreadActivity());
  const initialPinnedStateRef = useRef(loadNormalizedPinnedState());
  const pinnedThreadsRef = useRef<PinnedThreadsMap>(initialPinnedStateRef.current.pinned);
  const pinnedThreadOrderRef = useRef<PinnedThreadOrder>(initialPinnedStateRef.current.order);
  const customNamesRef = useRef<CustomNamesMap>(loadCustomNames());
  const [customNamesVersion, setCustomNamesVersion] = useState(0);
  const [pinnedThreadsVersion, setPinnedThreadsVersion] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    customNamesRef.current = loadCustomNames();
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY_CUSTOM_NAMES) {
        customNamesRef.current = loadCustomNames();
        setCustomNamesVersion((version) => version + 1);
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const getCustomName = useCallback((workspaceId: string, threadId: string) => {
    const key = makeCustomNameKey(workspaceId, threadId);
    return customNamesRef.current[key];
  }, []);

  const recordThreadActivity = useCallback(
    (workspaceId: string, threadId: string, timestamp = Date.now()) => {
      const nextForWorkspace = {
        ...(threadActivityRef.current[workspaceId] ?? {}),
        [threadId]: timestamp,
      };
      const next = {
        ...threadActivityRef.current,
        [workspaceId]: nextForWorkspace,
      };
      threadActivityRef.current = next;
      saveThreadActivity(next);
    },
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const reloadPinnedState = () => {
      const next = loadNormalizedPinnedState();
      pinnedThreadsRef.current = next.pinned;
      pinnedThreadOrderRef.current = next.order;
    };
    reloadPinnedState();
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key !== STORAGE_KEY_PINNED_THREADS &&
        event.key !== STORAGE_KEY_PINNED_THREAD_ORDER
      ) {
        return;
      }
      reloadPinnedState();
      setPinnedThreadsVersion((version) => version + 1);
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const persistPinnedState = useCallback(
    (nextPinned: PinnedThreadsMap, nextOrder: PinnedThreadOrder) => {
      const normalizedOrder = normalizePinnedThreadOrder(nextPinned, nextOrder);
      pinnedThreadsRef.current = nextPinned;
      pinnedThreadOrderRef.current = normalizedOrder;
      savePinnedThreads(nextPinned);
      savePinnedThreadOrder(normalizedOrder);
      setPinnedThreadsVersion((version) => version + 1);
    },
    [],
  );

  const pinThread = useCallback((workspaceId: string, threadId: string): boolean => {
    const key = makePinKey(workspaceId, threadId);
    if (key in pinnedThreadsRef.current) {
      return false;
    }
    const currentPinsForWorkspace = Object.keys(pinnedThreadsRef.current).filter(
      (entry) => entry.startsWith(`${workspaceId}:`),
    ).length;
    if (currentPinsForWorkspace >= MAX_PINS_SOFT_LIMIT) {
      console.warn(
        `Pin limit reached (${MAX_PINS_SOFT_LIMIT}). Consider unpinning some threads.`,
      );
    }
    const next = { ...pinnedThreadsRef.current, [key]: Date.now() };
    persistPinnedState(next, [...pinnedThreadOrderRef.current, key]);
    return true;
  }, [persistPinnedState]);

  const unpinThread = useCallback((workspaceId: string, threadId: string) => {
    const key = makePinKey(workspaceId, threadId);
    if (!(key in pinnedThreadsRef.current)) {
      return;
    }
    const { [key]: _removed, ...rest } = pinnedThreadsRef.current;
    persistPinnedState(
      rest,
      pinnedThreadOrderRef.current.filter((entry) => entry !== key),
    );
  }, [persistPinnedState]);

  const reorderPinnedThread = useCallback(
    (
      sourceWorkspaceId: string,
      sourceThreadId: string,
      targetWorkspaceId: string,
      targetThreadId: string,
      position: "before" | "after",
    ) => {
      const sourceKey = makePinKey(sourceWorkspaceId, sourceThreadId);
      const targetKey = makePinKey(targetWorkspaceId, targetThreadId);
      if (sourceKey === targetKey) {
        return;
      }
      if (!(sourceKey in pinnedThreadsRef.current) || !(targetKey in pinnedThreadsRef.current)) {
        return;
      }
      const normalizedOrder = normalizePinnedThreadOrder(
        pinnedThreadsRef.current,
        pinnedThreadOrderRef.current,
      );
      const sourceIndex = normalizedOrder.indexOf(sourceKey);
      const targetIndex = normalizedOrder.indexOf(targetKey);
      if (sourceIndex === -1 || targetIndex === -1) {
        return;
      }
      const nextOrder = normalizedOrder.filter((entry) => entry !== sourceKey);
      const insertIndexBase = nextOrder.indexOf(targetKey);
      if (insertIndexBase === -1) {
        return;
      }
      const insertIndex =
        position === "after" ? insertIndexBase + 1 : insertIndexBase;
      nextOrder.splice(insertIndex, 0, sourceKey);
      persistPinnedState(pinnedThreadsRef.current, nextOrder);
    },
    [persistPinnedState],
  );

  const isThreadPinned = useCallback(
    (workspaceId: string, threadId: string): boolean => {
      const key = makePinKey(workspaceId, threadId);
      return key in pinnedThreadsRef.current;
    },
    [],
  );

  const getPinTimestamp = useCallback(
    (workspaceId: string, threadId: string): number | null => {
      const key = makePinKey(workspaceId, threadId);
      if (!(key in pinnedThreadsRef.current)) {
        return null;
      }
      const orderIndex = pinnedThreadOrderRef.current.indexOf(key);
      if (orderIndex !== -1) {
        return orderIndex;
      }
      return pinnedThreadsRef.current[key] ?? null;
    },
    [],
  );

  return {
    customNamesRef,
    pinnedThreadsRef,
    pinnedThreadOrderRef,
    threadActivityRef,
    customNamesVersion,
    pinnedThreadsVersion,
    getCustomName,
    recordThreadActivity,
    pinThread,
    unpinThread,
    reorderPinnedThread,
    isThreadPinned,
    getPinTimestamp,
  };
}
