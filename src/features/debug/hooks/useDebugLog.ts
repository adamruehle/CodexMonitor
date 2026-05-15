import { useCallback, useRef, useState } from "react";
import type { DebugEntry } from "../../../types";
import { appendDevLog } from "../../../services/tauri";

const MAX_DEBUG_ENTRIES = 200;

function summarizePayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return { _type: "array", count: payload.length, sample: payload.slice(0, 5) };
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const summarized: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key])) {
        summarized[key] = { _type: "array", count: (obj[key] as unknown[]).length };
      } else {
        summarized[key] = obj[key];
      }
    }
    return summarized;
  }
  return payload;
}

export function useDebugLog() {
  const [debugOpen, setDebugOpenState] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [hasDebugAlerts, setHasDebugAlerts] = useState(false);
  const [debugPinned, setDebugPinned] = useState(false);
  const debugOpenRef = useRef(debugOpen);
  debugOpenRef.current = debugOpen;

  const isAlertEntry = useCallback((entry: DebugEntry) => {
    if (entry.source === "error" || entry.source === "stderr") {
      return true;
    }
    const label = entry.label.toLowerCase();
    if (label.includes("warn") || label.includes("warning")) {
      return true;
    }
    if (typeof entry.payload === "string") {
      const payload = entry.payload.toLowerCase();
      return payload.includes("warn") || payload.includes("warning");
    }
    return false;
  }, []);

  const shouldPersistEntry = useCallback(
    (entry: DebugEntry) => {
      if (isAlertEntry(entry)) {
        return true;
      }
      if (entry.source === "client" || entry.source === "server") {
        return true;
      }
      const label = entry.label.toLowerCase();
      return (
        label.includes("turn") ||
        label.includes("thread/status") ||
        label.includes("thread/closed") ||
        label.includes("thread/error") ||
        label.includes("item/started") ||
        label.includes("item/completed") ||
        label.includes("thread/item/started") ||
        label.includes("thread/item/completed") ||
        label.includes("tool/watchdog") ||
        label.includes("message/completed") ||
        label.includes("agent_message")
      );
    },
    [isAlertEntry],
  );

  const addDebugEntry = useCallback(
    (entry: DebugEntry) => {
      if (shouldPersistEntry(entry)) {
        void appendDevLog(entry);
      }
      const isAlert = isAlertEntry(entry);
      if (!debugOpenRef.current && !isAlert) {
        return;
      }
      if (isAlert) {
        setHasDebugAlerts(true);
      }
      const compactEntry = { ...entry, payload: summarizePayload(entry.payload) };
      setDebugEntries((prev) => [...prev, compactEntry].slice(-MAX_DEBUG_ENTRIES));
    },
    [isAlertEntry, shouldPersistEntry],
  );

  const handleCopyDebug = useCallback(async () => {
    const text = debugEntries
      .map((entry) => {
        const timestamp = new Date(entry.timestamp).toLocaleTimeString();
        const payload =
          entry.payload !== undefined
            ? typeof entry.payload === "string"
              ? entry.payload
              : JSON.stringify(entry.payload, null, 2)
            : "";
        return [entry.source.toUpperCase(), timestamp, entry.label, payload]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
    if (text) {
      await navigator.clipboard.writeText(text);
    }
  }, [debugEntries]);

  const clearDebugEntries = useCallback(() => {
    setDebugEntries([]);
    setHasDebugAlerts(false);
  }, []);

  const setDebugOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setDebugOpenState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        if (resolved) {
          setDebugPinned(true);
        }
        return resolved;
      });
    },
    [],
  );

  const showDebugButton = hasDebugAlerts || debugOpen || debugPinned;

  return {
    debugOpen,
    setDebugOpen,
    debugEntries,
    hasDebugAlerts,
    showDebugButton,
    addDebugEntry,
    handleCopyDebug,
    clearDebugEntries,
  };
}
