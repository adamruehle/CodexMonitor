// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePromptHistory } from "./usePromptHistory";

const STORAGE_PREFIX = "codexmonitor.promptHistory.";

function getStorageKey(key: string) {
  return `${STORAGE_PREFIX}${key}`;
}

function createKeyEvent(key: "ArrowUp" | "ArrowDown") {
  let prevented = false;
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
}

describe("usePromptHistory", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.localStorage.clear();
  });

  it("stores and recalls history per workspace key", () => {
    globalThis.localStorage.clear();
    vi.useFakeTimers();
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    const { result, rerender, unmount } = renderHook(
      ({ historyKey }) => {
        const [text, setText] = useState("");
        const [, setSelectionStart] = useState<number | null>(null);
        const textareaRef = useRef<HTMLTextAreaElement | null>(textarea);
        const history = usePromptHistory({
          historyKey,
          text,
          disabled: false,
          isAutocompleteOpen: false,
          textareaRef,
          setText,
          setSelectionStart,
        });
        return { text, ...history };
      },
      { initialProps: { historyKey: "ws-1" } },
    );

    act(() => {
      result.current.recordHistory("first prompt");
    });
    expect(globalThis.localStorage.getItem(getStorageKey("ws-1"))).toBe(
      JSON.stringify(["first prompt"]),
    );

    rerender({ historyKey: "ws-2" });
    act(() => {
      result.current.recordHistory("second prompt");
    });
    expect(globalThis.localStorage.getItem(getStorageKey("ws-2"))).toBe(
      JSON.stringify(["second prompt"]),
    );
    expect(globalThis.localStorage.getItem(getStorageKey("ws-1"))).toBe(
      JSON.stringify(["first prompt"]),
    );

    rerender({ historyKey: "ws-1" });
    act(() => {
      result.current.handleHistoryKeyDown(createKeyEvent("ArrowUp"));
    });
    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.text).toBe("first prompt");

    unmount();
    textarea.remove();
    vi.useRealTimers();
  });

  it("does not clobber stored history when switching keys", () => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem(
      getStorageKey("ws-a"),
      JSON.stringify(["alpha prompt"]),
    );
    globalThis.localStorage.setItem(
      getStorageKey("ws-b"),
      JSON.stringify(["beta prompt"]),
    );

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    const { rerender, unmount } = renderHook(
      ({ historyKey }) => {
        const [text, setText] = useState("");
        const [, setSelectionStart] = useState<number | null>(null);
        const textareaRef = useRef<HTMLTextAreaElement | null>(textarea);
        return usePromptHistory({
          historyKey,
          text,
          disabled: false,
          isAutocompleteOpen: false,
          textareaRef,
          setText,
          setSelectionStart,
        });
      },
      { initialProps: { historyKey: "ws-a" } },
    );

    rerender({ historyKey: "ws-b" });

    expect(globalThis.localStorage.getItem(getStorageKey("ws-a"))).toBe(
      JSON.stringify(["alpha prompt"]),
    );
    expect(globalThis.localStorage.getItem(getStorageKey("ws-b"))).toBe(
      JSON.stringify(["beta prompt"]),
    );

    unmount();
    textarea.remove();
  });

  it("does not throw when browser storage is full", () => {
    globalThis.localStorage.clear();
    vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    const { result, unmount } = renderHook(() => {
      const [text, setText] = useState("");
      const [, setSelectionStart] = useState<number | null>(null);
      const textareaRef = useRef<HTMLTextAreaElement | null>(textarea);
      return usePromptHistory({
        historyKey: "ws-quota",
        text,
        disabled: false,
        isAutocompleteOpen: false,
        textareaRef,
        setText,
        setSelectionStart,
      });
    });

    expect(() => {
      act(() => {
        result.current.recordHistory("quota-safe prompt");
      });
    }).not.toThrow();

    unmount();
    textarea.remove();
  });
});
