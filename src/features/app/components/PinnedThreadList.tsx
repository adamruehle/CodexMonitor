import { useMemo, useState, type DragEvent, type MouseEvent } from "react";

import type { ThreadSummary } from "../../../types";
import type { ThreadStatusById } from "../../../utils/threadStatus";
import { splitRowsByRoot } from "./threadSearchUtils";
import { ThreadRow } from "./ThreadRow";
import { buildThreadRowVisibility } from "./threadRowVisibility";

type PinnedThreadRow = {
  thread: ThreadSummary;
  depth: number;
  workspaceId: string;
};

type PinnedThreadListProps = {
  rows: PinnedThreadRow[];
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  threadStatusById: ThreadStatusById;
  pendingUserInputKeys?: Set<string>;
  getWorkspaceLabel?: (workspaceId: string) => string | null;
  getThreadTime: (thread: ThreadSummary) => string | null;
  getThreadArgsBadge?: (workspaceId: string, threadId: string) => string | null;
  isThreadPinned: (workspaceId: string, threadId: string) => boolean;
  canReorder?: boolean;
  onReorderPinnedThread?: (
    sourceWorkspaceId: string,
    sourceThreadId: string,
    targetWorkspaceId: string,
    targetThreadId: string,
    position: "before" | "after",
  ) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onShowThreadMenu: (
    event: MouseEvent,
    workspaceId: string,
    threadId: string,
    canPin: boolean,
  ) => void;
};

export function PinnedThreadList({
  rows,
  activeWorkspaceId,
  activeThreadId,
  threadStatusById,
  pendingUserInputKeys,
  getWorkspaceLabel,
  getThreadTime,
  getThreadArgsBadge,
  isThreadPinned,
  canReorder = false,
  onReorderPinnedThread,
  onSelectThread,
  onShowThreadMenu,
}: PinnedThreadListProps) {
  const [collapsedThreadKeys, setCollapsedThreadKeys] = useState<Set<string>>(new Set());
  const [draggingThread, setDraggingThread] = useState<{
    key: string;
    workspaceId: string;
    threadId: string;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    key: string;
    position: "before" | "after";
  } | null>(null);
  const visibility = useMemo(
    () =>
      buildThreadRowVisibility(
        rows,
        (row) => collapsedThreadKeys.has(`${row.workspaceId}:${row.thread.id}`),
      ),
    [collapsedThreadKeys, rows],
  );
  const visibleRootGroups = useMemo(
    () => splitRowsByRoot(visibility.visibleRows),
    [visibility.visibleRows],
  );

  const toggleThreadSubagents = (workspaceId: string, threadId: string) => {
    const threadKey = `${workspaceId}:${threadId}`;
    setCollapsedThreadKeys((prev) => {
      const next = new Set(prev);
      if (next.has(threadKey)) {
        next.delete(threadKey);
      } else {
        next.add(threadKey);
      }
      return next;
    });
  };

  const handleDragStart = (
    event: DragEvent<HTMLDivElement>,
    workspaceId: string,
    threadId: string,
  ) => {
    if (!canReorder) {
      return;
    }
    const threadKey = `${workspaceId}:${threadId}`;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", threadKey);
    setDraggingThread({
      key: threadKey,
      workspaceId,
      threadId,
    });
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    setDraggingThread(null);
    setDropTarget(null);
  };

  const handleDragOver = (
    event: DragEvent<HTMLDivElement>,
    workspaceId: string,
    threadId: string,
  ) => {
    if (!canReorder || !draggingThread) {
      return;
    }
    const targetKey = `${workspaceId}:${threadId}`;
    if (targetKey === draggingThread.key) {
      setDropTarget(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position =
      event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDropTarget((current) => {
      if (current?.key === targetKey && current.position === position) {
        return current;
      }
      return { key: targetKey, position };
    });
  };

  const handleDrop = (
    event: DragEvent<HTMLDivElement>,
    targetWorkspaceId: string,
    targetThreadId: string,
  ) => {
    if (!canReorder || !draggingThread || !onReorderPinnedThread) {
      return;
    }
    event.preventDefault();
    const targetKey = `${targetWorkspaceId}:${targetThreadId}`;
    const position =
      dropTarget?.key === targetKey ? dropTarget.position : "before";
    onReorderPinnedThread(
      draggingThread.workspaceId,
      draggingThread.threadId,
      targetWorkspaceId,
      targetThreadId,
      position,
    );
    handleDragEnd();
  };

  return (
    <div className="thread-list pinned-thread-list">
      {visibleRootGroups.map((group) => {
        const rootRow = group.root;
        const rootThreadKey = `${rootRow.workspaceId}:${rootRow.thread.id}`;
        const isDragSource = draggingThread?.key === rootThreadKey;
        const dropPosition =
          dropTarget?.key === rootThreadKey ? dropTarget.position : null;
        return (
          <div
            key={rootThreadKey}
            className={`pinned-thread-group${
              canReorder ? " is-reorderable" : ""
            }${isDragSource ? " is-dragging" : ""}${
              dropPosition ? ` drop-${dropPosition}` : ""
            }`}
            onDragOver={(event) =>
              handleDragOver(event, rootRow.workspaceId, rootRow.thread.id)
            }
            onDrop={(event) =>
              handleDrop(event, rootRow.workspaceId, rootRow.thread.id)
            }
          >
            {group.rows.map((row) => {
              const { thread, depth, workspaceId } = row;
              const threadKey = `${workspaceId}:${thread.id}`;
              const rowNode = (
                <ThreadRow
                  key={`${workspaceId}:${thread.id}`}
                  thread={thread}
                  depth={depth}
                  workspaceId={workspaceId}
                  indentUnit={14}
                  activeWorkspaceId={activeWorkspaceId}
                  activeThreadId={activeThreadId}
                  threadStatusById={threadStatusById}
                  pendingUserInputKeys={pendingUserInputKeys}
                  workspaceLabel={getWorkspaceLabel?.(workspaceId) ?? null}
                  getThreadTime={getThreadTime}
                  getThreadArgsBadge={getThreadArgsBadge}
                  isThreadPinned={isThreadPinned}
                  onSelectThread={onSelectThread}
                  onShowThreadMenu={onShowThreadMenu}
                  hasSubagentChildren={visibility.rowsWithChildren.has(row)}
                  subagentsExpanded={!collapsedThreadKeys.has(threadKey)}
                  onToggleSubagents={toggleThreadSubagents}
                  showPinnedLabel={false}
                />
              );
              if (depth > 0) {
                return rowNode;
              }
              return (
                <div
                  key={`drag-root-${workspaceId}-${thread.id}`}
                  className="pinned-thread-root"
                  draggable={canReorder}
                  onDragStart={(event) => handleDragStart(event, workspaceId, thread.id)}
                  onDragEnd={handleDragEnd}
                >
                  {rowNode}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
