import { describe, expect, it } from "vitest";

import { getThreadStatusClass, getWorkspaceHomeThreadState } from "./threadStatus";

describe("threadStatus", () => {
  it("prioritizes pending user input over processing state", () => {
    expect(
      getThreadStatusClass(
        { isProcessing: true, hasUnread: false, isReviewing: false },
        true,
      ),
    ).toBe("unread");
  });

  it("maps thread status to workspace home labels and classes", () => {
    expect(
      getWorkspaceHomeThreadState({
        isProcessing: true,
        hasUnread: false,
        isReviewing: false,
      }),
    ).toEqual({
      statusLabel: "Running",
      stateClass: "is-running",
      isRunning: true,
    });

    expect(
      getWorkspaceHomeThreadState({
        isProcessing: false,
        hasUnread: false,
        isReviewing: true,
      }),
    ).toEqual({
      statusLabel: "Idle",
      stateClass: "is-idle",
      isRunning: false,
    });

    expect(
      getWorkspaceHomeThreadState({
        isProcessing: false,
        hasUnread: false,
        isReviewing: false,
      }),
    ).toEqual({
      statusLabel: "Idle",
      stateClass: "is-idle",
      isRunning: false,
    });
  });

  it("shows active review state only while processing", () => {
    expect(
      getThreadStatusClass(
        { isProcessing: false, hasUnread: false, isReviewing: true },
        false,
      ),
    ).toBe("ready");
    expect(
      getThreadStatusClass(
        { isProcessing: true, hasUnread: false, isReviewing: true },
        false,
      ),
    ).toBe("reviewing");
    expect(
      getWorkspaceHomeThreadState({
        isProcessing: true,
        hasUnread: false,
        isReviewing: true,
      }),
    ).toEqual({
      statusLabel: "Reviewing",
      stateClass: "is-reviewing",
      isRunning: true,
    });
  });
});
