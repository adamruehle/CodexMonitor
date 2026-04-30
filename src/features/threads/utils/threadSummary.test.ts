import { describe, expect, it } from "vitest";

import { buildThreadSummaryFromThread } from "./threadSummary";

describe("buildThreadSummaryFromThread", () => {
  it("prefers thread title over preview when no custom name exists", () => {
    const summary = buildThreadSummaryFromThread({
      workspaceId: "ws-1",
      thread: {
        id: "thread-1",
        title: "CMP-58835-currencies",
        preview: "very long original prompt preview",
        updatedAt: 123,
      },
      fallbackIndex: 0,
    });

    expect(summary?.name).toBe("CMP-58835-currencies");
  });

  it("still prefers an explicit custom name over thread title", () => {
    const summary = buildThreadSummaryFromThread({
      workspaceId: "ws-1",
      thread: {
        id: "thread-1",
        title: "CMP-58835-currencies",
        preview: "very long original prompt preview",
        updatedAt: 123,
      },
      fallbackIndex: 0,
      getCustomName: () => "Pinned Local Name",
    });

    expect(summary?.name).toBe("Pinned Local Name");
  });
});
