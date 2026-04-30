import { memo, useCallback, useEffect, useMemo } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import type {
  ConversationItem,
  OpenAppTarget,
  RequestUserInputRequest,
  RequestUserInputResponse,
  TurnPlan,
} from "../../../types";
import { PlanReadyFollowupMessage } from "../../app/components/PlanReadyFollowupMessage";
import { RequestUserInputMessage } from "../../app/components/RequestUserInputMessage";
import { useFileLinkOpener } from "../hooks/useFileLinkOpener";
import {
  formatCount,
  parseReasoning,
  type MessageListEntry,
} from "../utils/messageRenderUtils";
import {
  DiffRow,
  ExploreRow,
  MessageRow,
  ReasoningRow,
  ReviewRow,
  ToolRow,
  UserInputRow,
  WorkingIndicator,
  PlanRow,
} from "./MessageRows";
import type { MessageGroupControlsApi } from "./messageGroupControls";
import { useMessagesViewState } from "./useMessagesViewState";

type MessagesProps = {
  items: ConversationItem[];
  threadId: string | null;
  workspaceId?: string | null;
  isThinking: boolean;
  isLoadingMessages?: boolean;
  processingStartedAt?: number | null;
  lastDurationMs?: number | null;
  showPollingFetchStatus?: boolean;
  pollingIntervalMs?: number;
  workspacePath?: string | null;
  openTargets: OpenAppTarget[];
  selectedOpenAppId: string;
  codeBlockCopyUseModifier?: boolean;
  showMessageFilePath?: boolean;
  userInputRequests?: RequestUserInputRequest[];
  activePlan?: TurnPlan | null;
  onUserInputSubmit?: (
    request: RequestUserInputRequest,
    response: RequestUserInputResponse,
  ) => void;
  onPlanAccept?: () => void;
  onPlanSubmitChanges?: (changes: string) => void;
  onOpenThreadLink?: (threadId: string, workspaceId?: string | null) => void;
  onQuoteMessage?: (text: string) => void;
  onGroupControlsChange?: (controls: MessageGroupControlsApi | null) => void;
};

export const Messages = memo(function Messages({
  items,
  threadId,
  workspaceId = null,
  isThinking,
  isLoadingMessages = false,
  processingStartedAt = null,
  lastDurationMs = null,
  showPollingFetchStatus = false,
  pollingIntervalMs = 12000,
  workspacePath = null,
  openTargets,
  selectedOpenAppId,
  codeBlockCopyUseModifier = false,
  showMessageFilePath = true,
  userInputRequests = [],
  activePlan = null,
  onUserInputSubmit,
  onPlanAccept,
  onPlanSubmitChanges,
  onOpenThreadLink,
  onQuoteMessage,
  onGroupControlsChange,
}: MessagesProps) {
  const activeUserInputRequestId =
    threadId && userInputRequests.length
      ? (userInputRequests.find(
          (request) =>
            request.params.thread_id === threadId &&
            (!workspaceId || request.workspace_id === workspaceId),
        )?.request_id ?? null)
      : null;
  const { openFileLink, showFileLinkMenu } = useFileLinkOpener(
    workspacePath,
    openTargets,
    selectedOpenAppId,
  );
  const handleOpenThreadLink = useCallback(
    (threadId: string) => {
      onOpenThreadLink?.(threadId, workspaceId ?? null);
    },
    [onOpenThreadLink, workspaceId],
  );

  const hasActiveUserInputRequest = activeUserInputRequestId !== null;
  const hasVisibleUserInputRequest = hasActiveUserInputRequest && Boolean(onUserInputSubmit);
  const userInputNode =
    hasActiveUserInputRequest && onUserInputSubmit ? (
      <RequestUserInputMessage
        requests={userInputRequests}
        activeThreadId={threadId}
        activeWorkspaceId={workspaceId}
        onSubmit={onUserInputSubmit}
      />
    ) : null;
  const {
    bottomRef,
    containerRef,
    updateAutoScroll,
    requestAutoScroll,
    expandedItems,
    toggleExpanded,
    collapsedToolGroups,
    toggleToolGroup,
    expandedWorkGroups,
    toggleWorkGroup,
    copiedMessageId,
    handleCopyMessage,
    handleQuoteMessage,
    reasoningMetaById,
    latestReasoningLabel,
    groupedItems,
    groupControls,
    expandAllGroups,
    collapseAllGroups,
    planFollowup,
    dismissPlanFollowup,
  } = useMessagesViewState({
    items,
    activePlan,
    threadId,
    isThinking,
    processingStartedAt,
    lastDurationMs,
    activeUserInputRequestId,
    hasVisibleUserInputRequest,
    onPlanAccept,
    onPlanSubmitChanges,
    onQuoteMessage,
  });

  const planFollowupNode =
    planFollowup.shouldShow && onPlanAccept && onPlanSubmitChanges ? (
      <PlanReadyFollowupMessage
        onAccept={() => {
          dismissPlanFollowup();
          onPlanAccept();
        }}
        onSubmitChanges={(changes) => {
          dismissPlanFollowup();
          onPlanSubmitChanges(changes);
        }}
      />
    ) : null;
  const hasRenderableEntries = groupedItems.length > 0;

  const liftedGroupControls = useMemo<MessageGroupControlsApi | null>(
    () =>
      groupControls.hasAnyGroups
        ? {
            hasAnyGroups: true,
            canExpandAny: groupControls.canExpandAny,
            canCollapseAny: groupControls.canCollapseAny,
            expandAll: expandAllGroups,
            collapseAll: collapseAllGroups,
          }
        : null,
    [collapseAllGroups, expandAllGroups, groupControls],
  );

  useEffect(() => {
    onGroupControlsChange?.(liftedGroupControls);
  }, [liftedGroupControls, onGroupControlsChange]);

  useEffect(
    () => () => {
      onGroupControlsChange?.(null);
    },
    [onGroupControlsChange],
  );

  const renderItem = (item: ConversationItem) => {
    if (item.kind === "message") {
      const isCopied = copiedMessageId === item.id;
      return (
        <MessageRow
          key={item.id}
          item={item}
          isCopied={isCopied}
          onCopy={handleCopyMessage}
          onQuote={onQuoteMessage ? handleQuoteMessage : undefined}
          codeBlockCopyUseModifier={codeBlockCopyUseModifier}
          showMessageFilePath={showMessageFilePath}
          workspacePath={workspacePath}
          onOpenFileLink={openFileLink}
          onOpenFileLinkMenu={showFileLinkMenu}
          onOpenThreadLink={handleOpenThreadLink}
        />
      );
    }
    if (item.kind === "reasoning") {
      const isExpanded = expandedItems.has(item.id);
      const parsed = reasoningMetaById.get(item.id) ?? parseReasoning(item);
      return (
        <ReasoningRow
          key={item.id}
          item={item}
          parsed={parsed}
          isExpanded={isExpanded}
          onToggle={toggleExpanded}
          showMessageFilePath={showMessageFilePath}
          workspacePath={workspacePath}
          onOpenFileLink={openFileLink}
          onOpenFileLinkMenu={showFileLinkMenu}
          onOpenThreadLink={handleOpenThreadLink}
        />
      );
    }
    if (item.kind === "review") {
      return (
        <ReviewRow
          key={item.id}
          item={item}
          showMessageFilePath={showMessageFilePath}
          workspacePath={workspacePath}
          onOpenFileLink={openFileLink}
          onOpenFileLinkMenu={showFileLinkMenu}
          onOpenThreadLink={handleOpenThreadLink}
        />
      );
    }
    if (item.kind === "userInput") {
      const isExpanded = expandedItems.has(item.id);
      return (
        <UserInputRow
          key={item.id}
          item={item}
          isExpanded={isExpanded}
          onToggle={toggleExpanded}
        />
      );
    }
    if (item.kind === "diff") {
      return <DiffRow key={item.id} item={item} />;
    }
    if (item.kind === "tool") {
      const isExpanded = expandedItems.has(item.id);
      return (
        <ToolRow
          key={item.id}
          item={item}
          isExpanded={isExpanded}
          onToggle={toggleExpanded}
          showMessageFilePath={showMessageFilePath}
          workspacePath={workspacePath}
          onOpenFileLink={openFileLink}
          onOpenFileLinkMenu={showFileLinkMenu}
          onOpenThreadLink={handleOpenThreadLink}
          onRequestAutoScroll={requestAutoScroll}
        />
      );
    }
    if (item.kind === "explore") {
      return <ExploreRow key={item.id} item={item} />;
    }
    return null;
  };

  const renderEntry = (entry: MessageListEntry) => {
    if (entry.kind === "item") {
      return renderItem(entry.item);
    }
    if (entry.kind === "toolGroup") {
      const { group } = entry;
      const isCollapsed = !collapsedToolGroups.has(group.id);
      const summaryParts = [
        formatCount(group.toolCount, "tool call", "tool calls"),
      ];
      if (group.messageCount > 0) {
        summaryParts.push(formatCount(group.messageCount, "message", "messages"));
      }
      const summaryText = summaryParts.join(", ");
      const groupBodyId = `tool-group-${group.id}`;
      const ChevronIcon = isCollapsed ? ChevronDown : ChevronUp;
      return (
        <div
          key={`tool-group-${group.id}`}
          className={`tool-group ${isCollapsed ? "tool-group-collapsed" : ""}`}
        >
          <div className="tool-group-header">
            <button
              type="button"
              className="tool-group-toggle"
              onClick={() => toggleToolGroup(group.id)}
              aria-expanded={!isCollapsed}
              aria-controls={groupBodyId}
              aria-label={isCollapsed ? "Expand tool calls" : "Collapse tool calls"}
            >
              <span className="tool-group-chevron" aria-hidden>
                <ChevronIcon size={14} />
              </span>
              <span className="tool-group-summary">{summaryText}</span>
            </button>
          </div>
          {!isCollapsed && (
            <div className="tool-group-body" id={groupBodyId}>
              {group.items.map(renderItem)}
            </div>
          )}
        </div>
      );
    }
    if (entry.kind === "plan") {
      return (
        <PlanRow
          key={`plan-${entry.plan.turnId}`}
          plan={entry.plan}
          isActive={entry.isActive}
        />
      );
    }
    const { group } = entry;
    const isExpanded = group.isActive || expandedWorkGroups.has(group.id);
    const groupBodyId = `work-group-${group.id}`;
    const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;
    return (
      <div
        key={`work-group-${group.id}`}
        className={`work-group ${isExpanded ? "work-group-expanded" : "work-group-collapsed"} ${
          group.isActive ? "work-group-active" : ""
        }`}
      >
        <button
          type="button"
          className="work-group-toggle"
          onClick={() => toggleWorkGroup(group.id)}
          aria-expanded={isExpanded}
          aria-controls={groupBodyId}
          aria-label={isExpanded ? "Collapse work group" : "Expand work group"}
        >
          <span className="work-group-chevron" aria-hidden>
            <ChevronIcon size={14} />
          </span>
          <span className="work-group-title">{group.title}</span>
        </button>
        {isExpanded && (
          <div className="work-group-body" id={groupBodyId}>
            {group.entries.map(renderEntry)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="messages messages-full"
      ref={containerRef}
      onScroll={updateAutoScroll}
    >
      <div className="messages-inner">
        {groupControls.hasAnyGroups && !onGroupControlsChange ? (
          <div className="messages-group-controls" aria-label="Group display controls">
            <button
              type="button"
              className="messages-group-control"
              onClick={expandAllGroups}
              disabled={!groupControls.canExpandAny}
            >
              Expand all
            </button>
            <button
              type="button"
              className="messages-group-control"
              onClick={collapseAllGroups}
              disabled={!groupControls.canCollapseAny}
            >
              Collapse all
            </button>
          </div>
        ) : null}
        {groupedItems.map(renderEntry)}
        {planFollowupNode}
        {userInputNode}
        <WorkingIndicator
          isThinking={isThinking}
          processingStartedAt={processingStartedAt}
          lastDurationMs={lastDurationMs}
          hasItems={hasRenderableEntries}
          reasoningLabel={latestReasoningLabel}
          showPollingFetchStatus={showPollingFetchStatus}
          pollingIntervalMs={pollingIntervalMs}
        />
        {!hasRenderableEntries && !userInputNode && !isThinking && !isLoadingMessages && (
          <div className="empty messages-empty">
            {threadId ? "Send a prompt to the agent." : "Send a prompt to start a new agent."}
          </div>
        )}
        {!hasRenderableEntries && !userInputNode && !isThinking && isLoadingMessages && (
          <div className="empty messages-empty">
            <div className="messages-loading-indicator" role="status" aria-live="polite">
              <span className="working-spinner" aria-hidden />
              <span className="messages-loading-label">Loading…</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
});
