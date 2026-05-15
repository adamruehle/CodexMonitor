import { useCallback, useState } from "react";
import type {
  ThreadListOrganizeMode,
  ThreadListSortKey,
  ThreadProviderFilter,
} from "../../../types";

const THREAD_LIST_SORT_KEY_STORAGE_KEY = "codexmonitor.threadListSortKey";
const THREAD_LIST_ORGANIZE_MODE_STORAGE_KEY = "codexmonitor.threadListOrganizeMode";
const THREAD_PROVIDER_FILTER_STORAGE_KEY = "codexmonitor.threadProviderFilter";

function getStoredThreadListSortKey(): ThreadListSortKey {
  if (typeof window === "undefined") {
    return "updated_at";
  }
  const stored = window.localStorage.getItem(THREAD_LIST_SORT_KEY_STORAGE_KEY);
  if (stored === "created_at" || stored === "updated_at") {
    return stored;
  }
  return "updated_at";
}

function getStoredThreadListOrganizeMode(): ThreadListOrganizeMode {
  if (typeof window === "undefined") {
    return "by_project";
  }
  const stored = window.localStorage.getItem(THREAD_LIST_ORGANIZE_MODE_STORAGE_KEY);
  if (stored === "by_project" || stored === "by_project_activity" || stored === "threads_only") {
    return stored;
  }
  return "by_project";
}

function getStoredThreadProviderFilter(): ThreadProviderFilter {
  if (typeof window === "undefined") {
    return "all";
  }
  const stored = window.localStorage.getItem(THREAD_PROVIDER_FILTER_STORAGE_KEY);
  if (stored === "all" || stored === "codex" || stored === "claude") {
    return stored;
  }
  return "all";
}

export function useThreadListSortKey() {
  const [threadListSortKey, setThreadListSortKeyState] = useState<ThreadListSortKey>(
    () => getStoredThreadListSortKey(),
  );
  const [threadListOrganizeMode, setThreadListOrganizeModeState] = useState<ThreadListOrganizeMode>(
    () => getStoredThreadListOrganizeMode(),
  );
  const [threadProviderFilter, setThreadProviderFilterState] = useState<ThreadProviderFilter>(
    () => getStoredThreadProviderFilter(),
  );

  const setThreadListSortKey = useCallback((nextSortKey: ThreadListSortKey) => {
    setThreadListSortKeyState(nextSortKey);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THREAD_LIST_SORT_KEY_STORAGE_KEY, nextSortKey);
    }
  }, []);

  const setThreadListOrganizeMode = useCallback(
    (nextOrganizeMode: ThreadListOrganizeMode) => {
      setThreadListOrganizeModeState(nextOrganizeMode);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          THREAD_LIST_ORGANIZE_MODE_STORAGE_KEY,
          nextOrganizeMode,
        );
      }
    },
    [],
  );

  const setThreadProviderFilter = useCallback((nextProviderFilter: ThreadProviderFilter) => {
    setThreadProviderFilterState(nextProviderFilter);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        THREAD_PROVIDER_FILTER_STORAGE_KEY,
        nextProviderFilter,
      );
    }
  }, []);

  return {
    threadListSortKey,
    setThreadListSortKey,
    threadListOrganizeMode,
    setThreadListOrganizeMode,
    threadProviderFilter,
    setThreadProviderFilter,
  };
}
