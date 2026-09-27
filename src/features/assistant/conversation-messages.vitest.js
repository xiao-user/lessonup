import { describe, expect, it } from "vitest";

import { presentConversationMessages } from "./conversation-messages.js";

const proposal = {
  id: "asst-1",
  role: "assistant",
  content: "建议改评价练习。",
  status: "completed",
  turn: { startedAt: "2026-09-02T04:00:00.000Z", completedAt: "2026-09-02T04:00:23.100Z", status: "completed" },
};

describe("presentConversationMessages", () => {
  it("folds a durable continuation into the proposing turn without concatenating bodies", () => {
    const continuation = {
      id: "asst-2",
      role: "assistant",
      content: "修改已确认写入：评价练习第2条现在有了明确的达成线。",
      status: "completed",
    };
    const presented = presentConversationMessages(
      [proposal, continuation],
      [{ assistantMessageId: "asst-1", continuationMessageId: "asst-2", state: "approved" }],
    );

    expect(presented).toHaveLength(1);
    expect(presented[0].id).toBe("asst-1");
    expect(presented[0].content).toBe("建议改评价练习。");
    expect(presented[0].continuationContent).toBe("修改已确认写入：评价练习第2条现在有了明确的达成线。");
    expect(presented[0].continuationMessageId).toBe("asst-2");
  });

  it("folds the in-flight continuation stream before continuationMessageId arrives", () => {
    const stream = {
      id: "stream-run-2",
      role: "assistant",
      content: "修改已确认写入：",
      status: "streaming",
    };
    const presented = presentConversationMessages(
      [proposal, stream],
      [{ assistantMessageId: "asst-1", state: "approved", continuationStatus: "running" }],
    );

    expect(presented).toHaveLength(1);
    expect(presented[0].continuationContent).toBe("修改已确认写入：");
    expect(presented[0].status).toBe("streaming");
  });

  it("still folds after the continuation run settles, before continuationMessageId is hydrated", () => {
    const finished = {
      id: "asst-2",
      role: "assistant",
      content: "修改已确认写入：评价练习第2条现在有了明确的达成线。",
      status: "completed",
    };
    const presented = presentConversationMessages(
      [proposal, finished],
      [{ assistantMessageId: "asst-1", state: "approved", decision: "approved" }],
    );

    expect(presented).toHaveLength(1);
    expect(presented[0].continuationContent).toContain("修改已确认写入");
  });

  it("does not steal a later turn after a user message", () => {
    const later = { id: "asst-3", role: "assistant", content: "下一问的回复", status: "completed" };
    const presented = presentConversationMessages(
      [proposal, { id: "user-2", role: "user", content: "再改一处" }, later],
      [{ assistantMessageId: "asst-1", state: "approved", decision: "approved" }],
    );

    expect(presented.map((message) => message.id)).toEqual(["asst-1", "user-2", "asst-3"]);
    expect(presented[0].continuationContent).toBeUndefined();
  });
});
