import { describe, expect, it } from "vitest";

import {
  agentActivitySummary,
  agentTurnPhases,
  deriveAgentTurnPhase,
  presentAgentActivities,
  presentConversationMessages,
  shouldShowAgentThinking,
} from "./agent-turn-presentation.js";

describe("deriveAgentTurnPhase", () => {
  it("keeps the otherwise invisible gap after tools visible as awaiting", () => {
    const phase = deriveAgentTurnPhase({
      status: "streaming",
      responseText: "",
      activities: [{ id: "tool-1", label: "读取教案栏目", state: "completed" }],
    });

    expect(phase).toBe(agentTurnPhases.awaiting);
    expect(shouldShowAgentThinking(phase)).toBe(true);
    expect(agentActivitySummary([{ label: "读取教案栏目", state: "completed" }], phase))
      .toBe("任务完成，正在组织回复");
  });

  it("prefers visible response streaming over a completed tool state", () => {
    expect(deriveAgentTurnPhase({
      status: "streaming",
      responseText: "正在生成回答",
      activities: [{ id: "tool-1", label: "读取教案栏目", state: "completed" }],
    })).toBe(agentTurnPhases.streaming);
  });

  it("shows active tools without labeling their output as model reasoning", () => {
    const activities = [{ id: "tool-1", label: "联网搜索", state: "running" }];
    const phase = deriveAgentTurnPhase({ status: "streaming", responseText: "", activities });

    expect(phase).toBe(agentTurnPhases.toolActive);
    expect(shouldShowAgentThinking(phase)).toBe(false);
    expect(agentActivitySummary(activities, phase)).toBe("正在执行：联网搜索");
  });
});

describe("presentConversationMessages", () => {
  it("keeps approval and its continuation in one stable assistant turn", () => {
    const messages = [
      { id: "user", role: "user", content: "生成教案", status: "completed" },
      { id: "proposal", role: "assistant", content: "", status: "completed", sources: [{ id: "s1" }] },
      { id: "continuation", role: "assistant", content: "教案已写入。", status: "completed" },
    ];
    expect(presentConversationMessages(messages, [{
      assistantMessageId: "proposal",
      continuationMessageId: "continuation",
    }])).toEqual([
      messages[0],
      expect.objectContaining({
        id: "proposal",
        content: "教案已写入。",
        continuationMessageId: "continuation",
      }),
    ]);
  });
});

describe("presentAgentActivities", () => {
  it("keeps a small number of section reads specific", () => {
    expect(presentAgentActivities([
      { id: "1", name: "read_section", label: "读取教学目标", groupKey: "document-read", state: "completed" },
      { id: "2", name: "read_section", label: "读取教学过程", groupKey: "document-read", state: "completed" },
    ]).map((activity) => activity.label)).toEqual(["读取教学目标", "读取教学过程"]);
  });

  it("collapses a broad review into one whole-document activity", () => {
    const activities = ["基本信息", "教学目标", "重点难点", "教学过程", "评价练习"].map((label, index) => ({
      id: String(index),
      name: "read_section",
      label: `读取${label}`,
      groupKey: "document-read",
      state: "completed",
    }));

    expect(presentAgentActivities(activities)).toEqual([expect.objectContaining({
      label: "读取整份教案（5 个栏目）",
      state: "completed",
    })]);
  });

  it("deduplicates repeated identical activities", () => {
    expect(presentAgentActivities([
      { id: "1", name: "search_web", label: "联网搜索", state: "running" },
      { id: "2", name: "search_web", label: "联网搜索", state: "completed" },
    ])).toEqual([expect.objectContaining({ label: "联网搜索", state: "completed", attempts: 2 })]);
  });

  it("shows a proposal retry as correction instead of a generic reply wait", () => {
    const activities = presentAgentActivities([
      { id: "1", name: "propose_document_patch", label: "准备修改建议", state: "failed" },
      { id: "2", name: "propose_document_patch", label: "准备修改建议", state: "running" },
    ]);
    expect(agentActivitySummary(activities, agentTurnPhases.toolActive))
      .toBe("正在修正：准备修改建议");
  });
});
