import type { ConversationItem } from "../types";
import { normalizeThreadTimestamp } from "./threadItems.shared";

function mergeUserInputQuestions(
  existing: Extract<ConversationItem, { kind: "userInput" }>["questions"],
  incoming: Extract<ConversationItem, { kind: "userInput" }>["questions"],
) {
  const existingById = new Map(existing.map((question) => [question.id, question]));
  const merged = incoming.map((question) => {
    const prior = existingById.get(question.id);
    if (!prior) {
      return question;
    }
    const incomingHasAnswers = question.answers.length > 0;
    return {
      ...prior,
      ...question,
      header: question.header.trim() ? question.header : prior.header,
      question: question.question.trim() ? question.question : prior.question,
      answers: incomingHasAnswers ? question.answers : prior.answers,
    };
  });
  const incomingIds = new Set(incoming.map((question) => question.id));
  const missingExisting = existing.filter((question) => !incomingIds.has(question.id));
  return [...merged, ...missingExisting];
}

function hasTurnId(item: ConversationItem) {
  return typeof item.turnId === "string" && item.turnId.trim().length > 0;
}

function normalizedTurnId(item: ConversationItem) {
  return hasTurnId(item) ? item.turnId!.trim() : null;
}

function isUserMessage(item: ConversationItem) {
  return item.kind === "message" && item.role === "user";
}

function isAssistantMessage(item: ConversationItem) {
  return item.kind === "message" && item.role === "assistant";
}

function isRepairableWorkItem(item: ConversationItem) {
  if (
    item.kind === "tool" ||
    item.kind === "reasoning" ||
    item.kind === "explore" ||
    item.kind === "userInput"
  ) {
    return true;
  }
  return (
    item.kind === "message" &&
    item.role === "assistant" &&
    item.text.trim() === "Session stopped."
  );
}

function itemTimestamp(item: ConversationItem) {
  const normalized = normalizeThreadTimestamp(item.timestampMs);
  return normalized > 0 ? normalized : null;
}

function mergeItemMetadata<T extends ConversationItem>(preferred: T, fallback: T): T {
  return {
    ...preferred,
    turnId: preferred.turnId ?? fallback.turnId ?? null,
    timestampMs: preferred.timestampMs ?? fallback.timestampMs ?? null,
  } as T;
}

function buildSyntheticTurnId(item: ConversationItem, index: number) {
  const basis = item.id?.trim() ? item.id.trim() : `index-${index + 1}`;
  return `synthetic-turn-${basis}`;
}

function isToolLikeTurnItem(item: ConversationItem) {
  return (
    item.kind === "tool" ||
    item.kind === "reasoning" ||
    item.kind === "explore" ||
    item.kind === "userInput"
  );
}

function findTurnRelativeInsertAt(
  merged: ConversationItem[],
  item: ConversationItem,
) {
  const turnId = normalizedTurnId(item);
  if (!turnId) {
    return null;
  }

  const turnIndices = merged.flatMap((candidate, index) =>
    normalizedTurnId(candidate) === turnId ? [index] : [],
  );
  if (turnIndices.length === 0) {
    return null;
  }

  if (isUserMessage(item)) {
    for (let cursor = turnIndices.length - 1; cursor >= 0; cursor -= 1) {
      const index = turnIndices[cursor];
      if (isUserMessage(merged[index])) {
        return index + 1;
      }
    }
    return turnIndices[0];
  }

  let finalAssistantIndex: number | null = null;
  for (let cursor = turnIndices.length - 1; cursor >= 0; cursor -= 1) {
    const index = turnIndices[cursor];
    const candidate = merged[index];
    if (!isAssistantMessage(candidate)) {
      continue;
    }
    const trailingTurnItems = turnIndices
      .slice(cursor + 1)
      .map((turnIndex) => merged[turnIndex]);
    if (!trailingTurnItems.some(isToolLikeTurnItem)) {
      finalAssistantIndex = index;
      break;
    }
  }

  if (finalAssistantIndex !== null) {
    return finalAssistantIndex;
  }
  return turnIndices[turnIndices.length - 1] + 1;
}

export function repairMissingTurnIds(items: ConversationItem[]) {
  let changed = false;
  const next = [...items];

  const explicitTurnIdBefore = (index: number) => {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = items[cursor];
      if (hasTurnId(candidate)) {
        return candidate.turnId ?? null;
      }
    }
    return null;
  };

  const explicitTurnIdAfter = (index: number) => {
    for (let cursor = index + 1; cursor < items.length; cursor += 1) {
      const candidate = items[cursor];
      if (hasTurnId(candidate)) {
        return candidate.turnId ?? null;
      }
    }
    return null;
  };

  let index = 0;
  while (index < items.length) {
    if (hasTurnId(items[index])) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < items.length && !hasTurnId(items[index])) {
      index += 1;
    }
    const end = index - 1;
    const run = items.slice(start, end + 1);
    const previousTurnId = explicitTurnIdBefore(start);
    const nextTurnId = explicitTurnIdAfter(end);
    const hasUserMessage = run.some(isUserMessage);
    const hasRepairableWork = run.some(isRepairableWorkItem);

    let inferredTurnId: string | null = null;
    if (previousTurnId && nextTurnId && previousTurnId === nextTurnId) {
      inferredTurnId = previousTurnId;
    } else if (!hasUserMessage && hasRepairableWork && previousTurnId && !nextTurnId) {
      inferredTurnId = previousTurnId;
    } else if (!hasUserMessage && hasRepairableWork && !previousTurnId && nextTurnId) {
      inferredTurnId = nextTurnId;
    }

    if (!inferredTurnId) {
      continue;
    }

    for (let cursor = start; cursor <= end; cursor += 1) {
      if (hasTurnId(items[cursor])) {
        continue;
      }
      next[cursor] = {
        ...items[cursor],
        turnId: inferredTurnId,
      };
      changed = true;
    }
  }

  let activeSyntheticTurnId: string | null = null;
  let previousAssignedItem: ConversationItem | null = null;
  for (let cursor = 0; cursor < next.length; cursor += 1) {
    const item = next[cursor];
    const explicitTurnId = normalizedTurnId(item);
    if (explicitTurnId) {
      activeSyntheticTurnId = explicitTurnId;
      previousAssignedItem = item;
      continue;
    }

    const shouldStartSyntheticTurn =
      !activeSyntheticTurnId ||
      (isUserMessage(item) &&
        previousAssignedItem !== null &&
        !isUserMessage(previousAssignedItem));
    if (shouldStartSyntheticTurn) {
      activeSyntheticTurnId = buildSyntheticTurnId(item, cursor);
    }
    if (!activeSyntheticTurnId) {
      continue;
    }

    next[cursor] = {
      ...item,
      turnId: activeSyntheticTurnId,
    };
    changed = true;
    previousAssignedItem = next[cursor];
  }

  return changed ? next : items;
}

export function repairMissingTimestamps(items: ConversationItem[]) {
  const timestamps = items.map(itemTimestamp);
  if (timestamps.every((timestamp) => timestamp !== null)) {
    return items;
  }

  let changed = false;
  const next = [...items];
  let index = 0;

  while (index < items.length) {
    if (timestamps[index] !== null) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < items.length && timestamps[index] === null) {
      index += 1;
    }
    const end = index - 1;
    const runLength = end - start + 1;
    const previousTimestamp = start > 0 ? timestamps[start - 1] : null;
    const nextTimestamp = index < items.length ? timestamps[index] : null;

    for (let offset = 0; offset < runLength; offset += 1) {
      const cursor = start + offset;
      let inferredTimestamp: number;
      if (
        previousTimestamp !== null &&
        nextTimestamp !== null &&
        nextTimestamp > previousTimestamp
      ) {
        inferredTimestamp = Math.round(
          previousTimestamp +
            ((nextTimestamp - previousTimestamp) * (offset + 1)) / (runLength + 1),
        );
      } else if (previousTimestamp !== null) {
        inferredTimestamp = previousTimestamp + offset + 1;
      } else if (nextTimestamp !== null) {
        inferredTimestamp = Math.max(1, nextTimestamp - (runLength - offset));
      } else {
        inferredTimestamp = cursor + 1;
      }

      next[cursor] = {
        ...items[cursor],
        timestampMs: inferredTimestamp,
      };
      changed = true;
    }
  }

  return changed ? next : items;
}

export function upsertItem(list: ConversationItem[], item: ConversationItem) {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) {
    return [...list, item];
  }
  const existing = list[index];
  const next = [...list];

  if (existing.kind !== item.kind) {
    next[index] = item;
    return next;
  }

  if (existing.kind === "message" && item.kind === "message") {
    const existingText = existing.text ?? "";
    const incomingText = item.text ?? "";
    next[index] = {
      ...existing,
      ...item,
      turnId: item.turnId ?? existing.turnId ?? null,
      timestampMs: item.timestampMs ?? existing.timestampMs ?? null,
      text: incomingText.length >= existingText.length ? incomingText : existingText,
      images: item.images?.length ? item.images : existing.images,
    };
    return next;
  }

  if (existing.kind === "userInput" && item.kind === "userInput") {
    next[index] = {
      ...existing,
      ...item,
      turnId: item.turnId ?? existing.turnId ?? null,
      timestampMs: item.timestampMs ?? existing.timestampMs ?? null,
      questions: mergeUserInputQuestions(existing.questions, item.questions),
    };
    return next;
  }

  if (existing.kind === "reasoning" && item.kind === "reasoning") {
    const existingSummary = existing.summary ?? "";
    const incomingSummary = item.summary ?? "";
    const existingContent = existing.content ?? "";
    const incomingContent = item.content ?? "";
    next[index] = {
      ...existing,
      ...item,
      turnId: item.turnId ?? existing.turnId ?? null,
      timestampMs: item.timestampMs ?? existing.timestampMs ?? null,
      summary:
        incomingSummary.length >= existingSummary.length
          ? incomingSummary
          : existingSummary,
      content:
        incomingContent.length >= existingContent.length
          ? incomingContent
          : existingContent,
    };
    return next;
  }

  if (existing.kind === "tool" && item.kind === "tool") {
    const existingOutput = existing.output ?? "";
    const incomingOutput = item.output ?? "";
    const hasIncomingOutput = incomingOutput.trim().length > 0;
    const hasIncomingChanges = (item.changes?.length ?? 0) > 0;
    next[index] = {
      ...existing,
      ...item,
      turnId: item.turnId ?? existing.turnId ?? null,
      timestampMs: item.timestampMs ?? existing.timestampMs ?? null,
      title: item.title?.trim() ? item.title : existing.title,
      detail: item.detail?.trim() ? item.detail : existing.detail,
      status: item.status?.trim() ? item.status : existing.status,
      output: hasIncomingOutput ? incomingOutput : existingOutput,
      changes: hasIncomingChanges ? item.changes : existing.changes,
      durationMs:
        typeof item.durationMs === "number" ? item.durationMs : existing.durationMs,
    };
    return next;
  }

  if (existing.kind === "diff" && item.kind === "diff") {
    const existingDiff = existing.diff ?? "";
    const incomingDiff = item.diff ?? "";
    next[index] = {
      ...existing,
      ...item,
      turnId: item.turnId ?? existing.turnId ?? null,
      timestampMs: item.timestampMs ?? existing.timestampMs ?? null,
      title: item.title?.trim() ? item.title : existing.title,
      status: item.status?.trim() ? item.status : existing.status,
      diff: incomingDiff.length >= existingDiff.length ? incomingDiff : existingDiff,
    };
    return next;
  }

  if (existing.kind === "review" && item.kind === "review") {
    const existingText = existing.text ?? "";
    const incomingText = item.text ?? "";
    next[index] = {
      ...existing,
      ...item,
      turnId: item.turnId ?? existing.turnId ?? null,
      timestampMs: item.timestampMs ?? existing.timestampMs ?? null,
      text: incomingText.length >= existingText.length ? incomingText : existingText,
    };
    return next;
  }

  next[index] = { ...existing, ...item };
  return next;
}

export function getThreadTimestamp(thread: Record<string, unknown>) {
  const raw =
    (thread.updatedAt ?? thread.updated_at ?? thread.createdAt ?? thread.created_at) ??
    0;
  return normalizeThreadTimestamp(raw);
}

export function getThreadCreatedTimestamp(thread: Record<string, unknown>) {
  const raw = (thread.createdAt ?? thread.created_at) ?? 0;
  return normalizeThreadTimestamp(raw);
}

export function previewThreadName(text: string, fallback: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed;
}

function chooseRicherItem(remote: ConversationItem, local: ConversationItem) {
  if (remote.kind !== local.kind) {
    return remote;
  }
  if (remote.kind === "message" && local.kind === "message") {
    const preferred = local.text.length > remote.text.length ? local : remote;
    const fallback = preferred === local ? remote : local;
    return {
      ...mergeItemMetadata(preferred, fallback),
      phase: preferred.phase ?? fallback.phase ?? null,
      images: preferred.images?.length ? preferred.images : fallback.images,
    };
  }
  if (remote.kind === "userInput" && local.kind === "userInput") {
    const remoteScore = remote.questions.reduce(
      (total, question) =>
        total + question.question.length + question.answers.join("\n").length,
      0,
    );
    const localScore = local.questions.reduce(
      (total, question) =>
        total + question.question.length + question.answers.join("\n").length,
      0,
    );
    const preferred = localScore > remoteScore ? local : remote;
    const fallback = preferred === local ? remote : local;
    return mergeItemMetadata(preferred, fallback);
  }
  if (remote.kind === "reasoning" && local.kind === "reasoning") {
    const remoteLength = remote.summary.length + remote.content.length;
    const localLength = local.summary.length + local.content.length;
    const preferred = localLength > remoteLength ? local : remote;
    const fallback = preferred === local ? remote : local;
    return mergeItemMetadata(preferred, fallback);
  }
  if (remote.kind === "tool" && local.kind === "tool") {
    const remoteOutput = remote.output ?? "";
    const localOutput = local.output ?? "";
    const hasRemoteOutput = remoteOutput.trim().length > 0;
    const remoteStatus = remote.status?.trim();
    return {
      ...remote,
      turnId: remote.turnId ?? local.turnId ?? null,
      timestampMs: remote.timestampMs ?? local.timestampMs ?? null,
      status: remoteStatus ? remote.status : local.status,
      output: hasRemoteOutput ? remoteOutput : localOutput,
      changes: remote.changes ?? local.changes,
      collabSender: remote.collabSender ?? local.collabSender,
      collabReceiver: remote.collabReceiver ?? local.collabReceiver,
      collabReceivers:
        (remote.collabReceivers?.length ?? 0) > 0
          ? remote.collabReceivers
          : local.collabReceivers,
      collabStatuses:
        (remote.collabStatuses?.length ?? 0) > 0
          ? remote.collabStatuses
          : local.collabStatuses,
    };
  }
  if (remote.kind === "diff" && local.kind === "diff") {
    const useLocal = local.diff.length > remote.diff.length;
    const remoteStatus = remote.status?.trim();
    return {
      ...remote,
      turnId: remote.turnId ?? local.turnId ?? null,
      timestampMs: remote.timestampMs ?? local.timestampMs ?? null,
      diff: useLocal ? local.diff : remote.diff,
      status: remoteStatus ? remote.status : local.status,
    };
  }
  return remote;
}

export function mergeThreadItems(
  remoteItems: ConversationItem[],
  localItems: ConversationItem[],
) {
  if (!localItems.length) {
    return remoteItems;
  }

  const byId = new Map(remoteItems.map((item) => [item.id, item]));
  const localItemsById = new Map(localItems.map((item) => [item.id, item]));
  const merged = remoteItems.map((item) => {
    const local = localItemsById.get(item.id);
    return local ? chooseRicherItem(item, local) : item;
  });

  localItems.forEach((item) => {
    if (!byId.has(item.id)) {
      const turnInsertAt = findTurnRelativeInsertAt(merged, item);
      if (turnInsertAt !== null) {
        merged.splice(turnInsertAt, 0, item);
        return;
      }
      const timestamp = itemTimestamp(item);
      if (timestamp == null) {
        merged.push(item);
        return;
      }
      const insertAt = merged.findIndex((candidate) => {
        const candidateTimestamp = itemTimestamp(candidate);
        return candidateTimestamp != null && candidateTimestamp > timestamp;
      });
      if (insertAt === -1) {
        merged.push(item);
      } else {
        merged.splice(insertAt, 0, item);
      }
    }
  });
  return merged;
}
