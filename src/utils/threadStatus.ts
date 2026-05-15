export type ThreadStatusFlags = {
  isProcessing?: boolean;
  hasUnread?: boolean;
  isReviewing?: boolean;
};

export type ThreadStatusById = Record<string, ThreadStatusFlags>;

export type ThreadStatusClass = "processing" | "reviewing" | "unread" | "ready";

export function getThreadStatusClass(
  status: ThreadStatusFlags | undefined,
  hasPendingUserInput: boolean,
): ThreadStatusClass {
  if (hasPendingUserInput) {
    return "unread";
  }
  if (status?.isProcessing) {
    return status?.isReviewing ? "reviewing" : "processing";
  }
  if (status?.hasUnread) {
    return "unread";
  }
  return "ready";
}

type WorkspaceHomeThreadState = {
  statusLabel: "Running" | "Reviewing" | "Idle";
  stateClass: "is-running" | "is-reviewing" | "is-idle";
  isRunning: boolean;
};

export function getWorkspaceHomeThreadState(
  status: ThreadStatusFlags | undefined,
): WorkspaceHomeThreadState {
  if (status?.isProcessing) {
    return status?.isReviewing
      ? { statusLabel: "Reviewing", stateClass: "is-reviewing", isRunning: true }
      : { statusLabel: "Running", stateClass: "is-running", isRunning: true };
  }
  return { statusLabel: "Idle", stateClass: "is-idle", isRunning: false };
}
