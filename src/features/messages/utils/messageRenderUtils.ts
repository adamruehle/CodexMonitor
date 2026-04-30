import { convertFileSrc } from "@tauri-apps/api/core";
import type { ConversationItem, TurnPlan } from "../../../types";

export type ToolSummary = {
  label: string;
  value?: string;
  detail?: string;
  output?: string;
};

export type StatusTone = "completed" | "processing" | "failed" | "unknown";

export type ParsedReasoning = {
  summaryTitle: string;
  bodyText: string;
  hasBody: boolean;
  workingLabel: string | null;
};

export type MessageImage = {
  src: string;
  label: string;
};

export type ToolGroupItem = Extract<
  ConversationItem,
  { kind: "tool" | "reasoning" | "explore" | "userInput" }
>;

export type ToolGroup = {
  id: string;
  items: ToolGroupItem[];
  toolCount: number;
  messageCount: number;
};

export type WorkGroup = {
  id: string;
  items: ConversationItem[];
  entries: MessageListEntry[];
  title: string;
  preview: string | null;
  durationMs: number | null;
  isActive: boolean;
};

export type MessageListEntry =
  | { kind: "item"; item: ConversationItem }
  | { kind: "toolGroup"; group: ToolGroup }
  | { kind: "workGroup"; group: WorkGroup }
  | { kind: "plan"; plan: TurnPlan; isActive: boolean };

type MessageEntryTimingOptions = {
  processingStartedAt?: number | null;
  lastDurationMs?: number | null;
  nowMs?: number;
};

export const SCROLL_THRESHOLD_PX = 120;
export const MAX_COMMAND_OUTPUT_LINES = 200;

export function basename(path: string) {
  if (!path) {
    return "";
  }
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function parseToolArgs(detail: string) {
  if (!detail) {
    return null;
  }
  try {
    return JSON.parse(detail) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstStringField(
  source: Record<string, unknown> | null,
  keys: string[],
) {
  if (!source) {
    return "";
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function formatCollabAgentLabel(agent: {
  threadId: string;
  nickname?: string;
  role?: string;
}) {
  const nickname = agent.nickname?.trim();
  const role = agent.role?.trim();
  if (nickname && role) {
    return `${nickname} [${role}]`;
  }
  if (nickname) {
    return nickname;
  }
  if (role) {
    return `${agent.threadId} [${role}]`;
  }
  return agent.threadId;
}

function summarizeCollabLabel(title: string, status?: string) {
  const tool = title.replace(/^collab:\s*/i, "").trim().toLowerCase();
  const tone = statusToneFromText(status);
  if (tool.includes("wait")) {
    return tone === "processing" ? "waiting for" : "waited for";
  }
  if (tool.includes("resume")) {
    return tone === "processing" ? "resuming" : "resumed";
  }
  if (tool.includes("close")) {
    return tone === "processing" ? "closing" : "closed";
  }
  if (tool.includes("spawn")) {
    return tone === "processing" ? "spawning" : "spawned";
  }
  if (tool.includes("send") || tool.includes("interaction")) {
    return tone === "processing" ? "sending to" : "sent to";
  }
  return "sub-agent";
}

function summarizeCollabReceiver(
  item: Extract<ConversationItem, { kind: "tool" }>,
) {
  const receivers =
    item.collabReceivers && item.collabReceivers.length > 0
      ? item.collabReceivers
      : item.collabReceiver
        ? [item.collabReceiver]
        : [];
  if (receivers.length === 0) {
    return item.title || "";
  }
  if (receivers.length === 1) {
    return formatCollabAgentLabel(receivers[0]);
  }
  return `${formatCollabAgentLabel(receivers[0])} +${receivers.length - 1}`;
}

export function toolNameFromTitle(title: string) {
  if (!title.toLowerCase().startsWith("tool:")) {
    return "";
  }
  const [, toolPart = ""] = title.split(":");
  const segments = toolPart.split("/").map((segment) => segment.trim());
  return segments.length ? segments[segments.length - 1] : "";
}

export function formatCount(value: number, singular: string, plural: string) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function sanitizeReasoningTitle(title: string) {
  return title
    .replace(/[`*_~]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .trim();
}

export function parseReasoning(
  item: Extract<ConversationItem, { kind: "reasoning" }>,
): ParsedReasoning {
  const summary = item.summary ?? "";
  const content = item.content ?? "";
  const hasSummary = summary.trim().length > 0;
  const titleSource = hasSummary ? summary : content;
  const titleLines = titleSource.split("\n");
  const trimmedLines = titleLines.map((line) => line.trim());
  const titleLineIndex = trimmedLines.findIndex(Boolean);
  const rawTitle = titleLineIndex >= 0 ? trimmedLines[titleLineIndex] : "";
  const cleanTitle = sanitizeReasoningTitle(rawTitle);
  const summaryTitle = cleanTitle
    ? cleanTitle.length > 80
      ? `${cleanTitle.slice(0, 80)}…`
      : cleanTitle
    : "Reasoning";
  const summaryLines = summary.split("\n");
  const contentLines = content.split("\n");
  const summaryBody =
    hasSummary && titleLineIndex >= 0
      ? summaryLines
          .filter((_, index) => index !== titleLineIndex)
          .join("\n")
          .trim()
      : "";
  const contentBody = hasSummary
    ? content.trim()
    : titleLineIndex >= 0
      ? contentLines
          .filter((_, index) => index !== titleLineIndex)
          .join("\n")
          .trim()
      : content.trim();
  const bodyParts = [summaryBody, contentBody].filter(Boolean);
  const bodyText = bodyParts.join("\n\n").trim();
  const hasBody = bodyText.length > 0;
  const hasAnyText = titleSource.trim().length > 0;
  const workingLabel = hasAnyText ? summaryTitle : null;
  return {
    summaryTitle,
    bodyText,
    hasBody,
    workingLabel,
  };
}

export function normalizeMessageImageSrc(path: string) {
  if (!path) {
    return "";
  }
  if (path.startsWith("data:") || path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  if (path.startsWith("file://")) {
    return path;
  }
  try {
    return convertFileSrc(path);
  } catch {
    return "";
  }
}

function isToolGroupItem(item: ConversationItem): item is ToolGroupItem {
  return (
    item.kind === "tool" ||
    item.kind === "reasoning" ||
    item.kind === "explore" ||
    item.kind === "userInput"
  );
}

function mergeExploreItems(
  items: Extract<ConversationItem, { kind: "explore" }>[],
): Extract<ConversationItem, { kind: "explore" }> {
  const first = items[0];
  const last = items[items.length - 1];
  const status = last?.status ?? "explored";
  const entries = items.flatMap((item) => item.entries);
  return {
    id: first.id,
    kind: "explore",
    status,
    entries,
  };
}

function mergeConsecutiveExploreRuns(items: ToolGroupItem[]): ToolGroupItem[] {
  const result: ToolGroupItem[] = [];
  let run: Extract<ConversationItem, { kind: "explore" }>[] = [];

  const flushRun = () => {
    if (run.length === 0) {
      return;
    }
    if (run.length === 1) {
      result.push(run[0]);
    } else {
      result.push(mergeExploreItems(run));
    }
    run = [];
  };

  items.forEach((item) => {
    if (item.kind === "explore") {
      run.push(item);
      return;
    }
    flushRun();
    result.push(item);
  });
  flushRun();
  return result;
}

export function buildToolGroups(items: ConversationItem[]): MessageListEntry[] {
  const entries: MessageListEntry[] = [];
  let buffer: ToolGroupItem[] = [];

  const flush = () => {
    if (buffer.length === 0) {
      return;
    }
    const normalizedBuffer = mergeConsecutiveExploreRuns(buffer);
    const toolCount = normalizedBuffer.reduce((total, item) => {
      if (item.kind === "tool") {
        return total + 1;
      }
      if (item.kind === "explore") {
        return total + item.entries.length;
      }
      return total;
    }, 0);
    const messageCount = normalizedBuffer.filter(
      (item) => item.kind !== "tool" && item.kind !== "explore",
    ).length;
    if (toolCount === 0 || normalizedBuffer.length === 1) {
      normalizedBuffer.forEach((item) => entries.push({ kind: "item", item }));
    } else {
      entries.push({
        kind: "toolGroup",
        group: {
          id: normalizedBuffer[0].id,
          items: normalizedBuffer,
          toolCount,
          messageCount,
        },
      });
    }
    buffer = [];
  };

  items.forEach((item) => {
    if (isToolGroupItem(item)) {
      buffer.push(item);
    } else {
      flush();
      entries.push({ kind: "item", item });
    }
  });
  flush();
  return entries;
}

function isAssistantMessage(
  item: ConversationItem,
): item is Extract<ConversationItem, { kind: "message" }> & { role: "assistant" } {
  return item.kind === "message" && item.role === "assistant";
}

function isFinalAssistantMessage(
  item: ConversationItem,
): item is Extract<ConversationItem, { kind: "message" }> & { role: "assistant" } {
  return (
    isAssistantMessage(item) &&
    typeof item.phase === "string" &&
    item.phase.trim().toLowerCase() === "final_answer"
  );
}

function isUserMessage(
  item: ConversationItem,
): item is Extract<ConversationItem, { kind: "message" }> & { role: "user" } {
  return item.kind === "message" && item.role === "user";
}

function isBookkeepingReasoning(
  item: ConversationItem,
): item is Extract<ConversationItem, { kind: "reasoning" }> {
  return (
    item.kind === "reasoning" &&
    !item.summary.trim() &&
    !item.content.trim()
  );
}

function isContextCompactionTool(
  item: ConversationItem,
): item is Extract<ConversationItem, { kind: "tool" }> {
  return (
    item.kind === "tool" &&
    item.title.trim().toLowerCase() === "context compaction"
  );
}

function isTrailingBookkeepingItem(item: ConversationItem) {
  return isBookkeepingReasoning(item) || isContextCompactionTool(item);
}

function normalizedTurnId(item: ConversationItem) {
  return typeof item.turnId === "string" && item.turnId.trim().length > 0
    ? item.turnId.trim()
    : null;
}

function formatWorkedDuration(durationMs: number) {
  const durationSeconds = Math.max(1, Math.floor(durationMs / 1000));
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ");
}

function itemTimestamp(item: ConversationItem) {
  return typeof item.timestampMs === "number" && Number.isFinite(item.timestampMs)
    ? item.timestampMs
    : null;
}

function workItemPreview(item: ToolGroupItem): string | null {
  if (item.kind === "tool") {
    const summary = buildToolSummary(item, item.title);
    const label = summary.label?.trim();
    const value = summary.value?.trim() || item.title.trim();
    if (!label && !value) {
      return null;
    }
    const verb = label ? label.charAt(0).toUpperCase() + label.slice(1) : "Used";
    return [verb, value].filter(Boolean).join(" ");
  }
  if (item.kind === "explore") {
    const lastEntry = item.entries[item.entries.length - 1];
    if (!lastEntry) {
      return item.status === "exploring" ? "Exploring" : "Explored";
    }
    return `${item.status === "exploring" ? "Exploring" : "Explored"} ${lastEntry.label}`;
  }
  if (item.kind === "reasoning") {
    const parsed = parseReasoning(item);
    return parsed.workingLabel ? `Reasoned about ${parsed.workingLabel}` : "Reasoned";
  }
  if (item.kind === "userInput") {
    return "Answered input request";
  }
  return null;
}

function shouldWrapWorkGroup(items: ConversationItem[]) {
  const workItems = items.filter(isToolGroupItem);
  if (workItems.length === 0) {
    return false;
  }
  if (items.length > 1) {
    return true;
  }
  const [first] = workItems;
  return first ? first.kind !== "explore" : false;
}

function shouldWrapCompletedTrailingWorkGroup(items: ConversationItem[]) {
  if (!shouldWrapWorkGroup(items)) {
    return false;
  }
  return items.some((item) => isAssistantMessage(item) || isUserMessage(item));
}

function buildWorkGroup(
  items: ConversationItem[],
  isActive: boolean,
  durationItems: ConversationItem[] = items,
  durationOverrideMs: number | null = null,
): WorkGroup {
  const startTimestamp =
    durationItems.find((item) => itemTimestamp(item) !== null)?.timestampMs ?? null;
  const endTimestamp =
    [...durationItems].reverse().find((item) => itemTimestamp(item) !== null)?.timestampMs ??
      null;
  const durationFromItems =
    startTimestamp !== null && endTimestamp !== null && endTimestamp >= startTimestamp
      ? endTimestamp - startTimestamp
      : null;
  const longestToolDuration = items.reduce((maxDuration, item) => {
    if (item.kind !== "tool") {
      return maxDuration;
    }
    if (typeof item.durationMs !== "number" || !Number.isFinite(item.durationMs)) {
      return maxDuration;
    }
    return Math.max(maxDuration, item.durationMs);
  }, 0);
  const durationMs =
    typeof durationOverrideMs === "number" && Number.isFinite(durationOverrideMs)
      ? Math.max(0, durationOverrideMs)
      : durationFromItems && durationFromItems > 0
      ? durationFromItems
      : longestToolDuration > 0
        ? longestToolDuration
        : null;
  const preview = Array.from(
    new Set(
      items
        .filter(isToolGroupItem)
        .map(workItemPreview)
        .filter((entry): entry is string => Boolean(entry?.trim())),
    ),
  )
    .slice(0, 3)
    .join(" • ");

  return {
    id: items[0]?.id ?? `work-${Date.now()}`,
    items,
    entries: buildToolGroups(items),
    title:
      !isActive && durationMs ? `Worked for ${formatWorkedDuration(durationMs)}` : "Worked",
    preview: preview || null,
    durationMs,
    isActive,
  };
}

function pushPlainWorkItems(entries: MessageListEntry[], items: ConversationItem[]) {
  buildToolGroups(items).forEach((entry) => entries.push(entry));
}

function buildLegacyMessageEntries(items: ConversationItem[], isThinking: boolean) {
  const entries: MessageListEntry[] = [];
  let workBuffer: ConversationItem[] = [];

  const bufferHasToolLikeWork = () => workBuffer.some(isToolGroupItem);

  const hasUpcomingToolLikeWork = (startIndex: number) => {
    for (let index = startIndex + 1; index < items.length; index += 1) {
      const next = items[index];
      if (isToolGroupItem(next)) {
        return true;
      }
      if (isUserMessage(next)) {
        return false;
      }
    }
    return false;
  };

  const flushPlain = () => {
    if (workBuffer.length === 0) {
      return;
    }
    pushPlainWorkItems(entries, workBuffer);
    workBuffer = [];
  };

  const flushWorkGroup = (active: boolean) => {
    if (workBuffer.length === 0) {
      return;
    }
    if (shouldWrapWorkGroup(workBuffer)) {
      entries.push({
        kind: "workGroup",
        group: buildWorkGroup(workBuffer, active),
      });
    } else {
      pushPlainWorkItems(entries, workBuffer);
    }
    workBuffer = [];
  };

  items.forEach((item, index) => {
    if (isToolGroupItem(item)) {
      workBuffer.push(item);
      return;
    }
    if (isAssistantMessage(item)) {
      if (isFinalAssistantMessage(item)) {
        flushWorkGroup(false);
        entries.push({ kind: "item", item });
        return;
      }
      if (workBuffer.length > 0) {
        if (bufferHasToolLikeWork()) {
          flushWorkGroup(false);
          entries.push({ kind: "item", item });
          return;
        }
        workBuffer.push(item);
        return;
      }
      if (hasUpcomingToolLikeWork(index)) {
        workBuffer.push(item);
        return;
      }
      flushPlain();
      entries.push({ kind: "item", item });
      return;
    }
    flushPlain();
    entries.push({ kind: "item", item });
  });

  if (workBuffer.length > 0) {
    if (isThinking || shouldWrapCompletedTrailingWorkGroup(workBuffer)) {
      flushWorkGroup(isThinking);
    } else {
      flushPlain();
    }
  }

  return entries;
}

function buildTurnEntries(
  items: ConversationItem[],
  isActive: boolean,
  timing: MessageEntryTimingOptions = {},
) {
  const entries: MessageListEntry[] = [];
  let index = 0;

  if (index < items.length && isUserMessage(items[index])) {
    entries.push({ kind: "item", item: items[index] });
    index += 1;
  }

  const turnResponseItems = items.slice(index);
  if (turnResponseItems.length === 0) {
    return entries;
  }

  const activeDurationOverride =
    isActive && typeof timing.processingStartedAt === "number"
      ? Math.max(0, (timing.nowMs ?? Date.now()) - timing.processingStartedAt)
      : null;
  const completedDurationOverride =
    !isActive && typeof timing.lastDurationMs === "number"
      ? Math.max(0, timing.lastDurationMs)
      : null;

  if (isActive) {
    entries.push({
      kind: "workGroup",
      group: buildWorkGroup(turnResponseItems, true, items, activeDurationOverride),
    });
    return entries;
  }

  let finalAssistantIndex = -1;
  for (let cursor = turnResponseItems.length - 1; cursor >= 0; cursor -= 1) {
    if (isFinalAssistantMessage(turnResponseItems[cursor])) {
      finalAssistantIndex = cursor;
      break;
    }
  }
  for (let cursor = turnResponseItems.length - 1; cursor >= 0; cursor -= 1) {
    if (finalAssistantIndex >= 0) {
      break;
    }
    const trailingItems = turnResponseItems.slice(cursor + 1);
    if (
      isAssistantMessage(turnResponseItems[cursor]) &&
      trailingItems.every(isTrailingBookkeepingItem)
    ) {
      finalAssistantIndex = cursor;
      break;
    }
  }

  if (finalAssistantIndex < 0) {
    if (shouldWrapCompletedTrailingWorkGroup(turnResponseItems)) {
      entries.push({
        kind: "workGroup",
        group: buildWorkGroup(
          turnResponseItems,
          false,
          items,
          completedDurationOverride,
        ),
      });
    } else {
      entries.push(...buildToolGroups(turnResponseItems));
    }
    return entries;
  }

  const workItems = [
    ...turnResponseItems.slice(0, finalAssistantIndex),
    ...turnResponseItems.slice(finalAssistantIndex + 1),
  ];
  const finalAssistant = turnResponseItems[finalAssistantIndex];

  if (workItems.length > 0) {
    entries.push({
      kind: "workGroup",
      group: buildWorkGroup(workItems, false, items, completedDurationOverride),
    });
  }

  entries.push({ kind: "item", item: finalAssistant });

  return entries;
}

export function buildMessageEntries(
  items: ConversationItem[],
  isThinking: boolean,
  timing: MessageEntryTimingOptions = {},
): MessageListEntry[] {
  const entries: MessageListEntry[] = [];
  let index = 0;

  while (index < items.length) {
    const turnId = normalizedTurnId(items[index]);
    let end = index + 1;
    if (turnId) {
      while (end < items.length && normalizedTurnId(items[end]) === turnId) {
        end += 1;
      }
      const segment = items.slice(index, end);
      entries.push(
        ...buildTurnEntries(
          segment,
          isThinking && end === items.length,
          end === items.length
            ? timing
            : {
                processingStartedAt: null,
                lastDurationMs: null,
                nowMs: timing.nowMs,
              },
        ),
      );
    } else {
      while (end < items.length && !normalizedTurnId(items[end])) {
        end += 1;
      }
      const segment = items.slice(index, end);
      entries.push(...buildLegacyMessageEntries(segment, isThinking && end === items.length));
    }
    index = end;
  }

  return entries;
}

export function cleanCommandText(commandText: string) {
  if (!commandText) {
    return "";
  }
  const trimmed = commandText.trim();
  const withoutLabel = trimmed.replace(/^Command:\s*/i, "");
  const shellMatch = trimmed.match(
    /^(?:\/\S+\/)?(?:bash|zsh|sh|fish)(?:\.exe)?\s+-lc\s+(['"])([\s\S]+)\1$/,
  );
  const inner = shellMatch ? shellMatch[2] : withoutLabel;
  const cdMatch = inner.match(
    /^\s*cd\s+[^&;]+(?:\s*&&\s*|\s*;\s*)([\s\S]+)$/i,
  );
  const stripped = cdMatch ? cdMatch[1] : inner;
  return stripped.trim();
}

export function buildToolSummary(
  item: Extract<ConversationItem, { kind: "tool" }>,
  commandText: string,
): ToolSummary {
  if (item.toolType === "commandExecution") {
    const cleanedCommand = cleanCommandText(commandText);
    return {
      label: "command",
      value: cleanedCommand || "Command",
      detail: "",
      output: item.output || "",
    };
  }

  if (item.toolType === "webSearch") {
    return {
      label: statusToneFromText(item.status) === "processing" ? "searching" : "searched",
      value: item.detail || "the web",
    };
  }

  if (item.toolType === "imageView") {
    const file = basename(item.detail || "");
    return {
      label: "read",
      value: file || "image",
    };
  }

  if (item.toolType === "hook") {
    return {
      label: "hook",
      value: item.title.replace(/^Hook:\s*/i, "").trim() || item.title || "hook",
      detail: item.detail || "",
      output: item.output || "",
    };
  }

  if (item.toolType === "collabToolCall") {
    return {
      label: summarizeCollabLabel(item.title, item.status),
      value: summarizeCollabReceiver(item),
      detail: item.detail || "",
      output: item.output || "",
    };
  }

  if (item.toolType === "mcpToolCall") {
    const toolName = toolNameFromTitle(item.title);
    const args = parseToolArgs(item.detail);
    if (toolName.toLowerCase().includes("search")) {
      return {
        label: statusToneFromText(item.status) === "processing" ? "searching" : "searched",
        value:
          firstStringField(args, ["query", "pattern", "text"]) || item.detail,
      };
    }
    if (toolName.toLowerCase().includes("read")) {
      const targetPath =
        firstStringField(args, ["path", "file", "filename"]) || item.detail;
      return {
        label: "read",
        value: basename(targetPath),
        detail: targetPath && targetPath !== basename(targetPath) ? targetPath : "",
      };
    }
    if (toolName) {
      return {
        label: "tool",
        value: toolName,
        detail: item.detail || "",
      };
    }
  }

  return {
    label: "tool",
    value: item.title || "",
    detail: item.detail || "",
    output: item.output || "",
  };
}

export function formatDurationMs(durationMs: number) {
  const durationSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const durationMinutes = Math.floor(durationSeconds / 60);
  const durationRemainder = durationSeconds % 60;
  return `${durationMinutes}:${String(durationRemainder).padStart(2, "0")}`;
}

export function statusToneFromText(status?: string): StatusTone {
  if (!status) {
    return "unknown";
  }
  const normalized = status.toLowerCase();
  if (/(fail|error)/.test(normalized)) {
    return "failed";
  }
  if (/(pending|running|processing|started|in[_\s-]?progress)/.test(normalized)) {
    return "processing";
  }
  if (/(complete|completed|success|done)/.test(normalized)) {
    return "completed";
  }
  return "unknown";
}

export function toolStatusTone(
  item: Extract<ConversationItem, { kind: "tool" }>,
  hasChanges: boolean,
): StatusTone {
  const fromStatus = statusToneFromText(item.status);
  if (fromStatus !== "unknown") {
    return fromStatus;
  }
  if (item.output || hasChanges) {
    return "completed";
  }
  return "processing";
}

export function formatToolStatusLabel(
  item: Extract<ConversationItem, { kind: "tool" }>,
) {
  if (item.toolType !== "hook") {
    return "";
  }
  const parts: string[] = [];
  const status = (item.status ?? "").trim().toLowerCase();
  if (status) {
    parts.push(status.replace(/[_-]+/g, " "));
  }
  if (typeof item.durationMs === "number" && Number.isFinite(item.durationMs)) {
    parts.push(formatDurationMs(item.durationMs));
  }
  return parts.join(" • ");
}


export type PlanFollowupState = {
  shouldShow: boolean;
  planItemId: string | null;
};

export function computePlanFollowupState({
  threadId,
  items,
  isThinking,
  hasVisibleUserInputRequest,
}: {
  threadId: string | null;
  items: ConversationItem[];
  isThinking: boolean;
  hasVisibleUserInputRequest: boolean;
}): PlanFollowupState {
  if (!threadId) {
    return { shouldShow: false, planItemId: null };
  }
  if (hasVisibleUserInputRequest) {
    return { shouldShow: false, planItemId: null };
  }

  let planIndex = -1;
  let planItem: Extract<ConversationItem, { kind: "tool" }> | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "tool" && item.toolType === "plan") {
      planIndex = index;
      planItem = item;
      break;
    }
  }

  if (!planItem) {
    return { shouldShow: false, planItemId: null };
  }

  const planItemId = planItem.id;

  if (!(planItem.output ?? "").trim()) {
    return { shouldShow: false, planItemId };
  }

  const planTone = toolStatusTone(planItem, false);
  if (planTone === "failed") {
    return { shouldShow: false, planItemId };
  }

  // Some backends stream plan output deltas without a final status update. As
  // soon as the turn stops thinking, treat the latest plan output as ready.
  if (isThinking && planTone !== "completed") {
    return { shouldShow: false, planItemId };
  }

  for (let index = planIndex + 1; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === "message" && item.role === "user") {
      return { shouldShow: false, planItemId };
    }
  }

  return { shouldShow: true, planItemId };
}

export function scrollKeyForItems(items: ConversationItem[]) {
  if (!items.length) {
    return "empty";
  }
  const last = items[items.length - 1];
  switch (last.kind) {
    case "message":
      return `${last.id}-${last.text.length}`;
    case "userInput":
      return `${last.id}-${last.status}-${last.questions.length}`;
    case "reasoning":
      return `${last.id}-${last.summary.length}-${last.content.length}`;
    case "explore":
      return `${last.id}-${last.status}-${last.entries.length}`;
    case "tool":
      return `${last.id}-${last.status ?? ""}-${last.output?.length ?? 0}`;
    case "diff":
      return `${last.id}-${last.status ?? ""}-${last.diff.length}`;
    case "review":
      return `${last.id}-${last.state}-${last.text.length}`;
    default: {
      const _exhaustive: never = last;
      return _exhaustive;
    }
  }
}

export function exploreKindLabel(
  kind: Extract<ConversationItem, { kind: "explore" }>["entries"][number]["kind"],
) {
  return kind[0].toUpperCase() + kind.slice(1);
}
