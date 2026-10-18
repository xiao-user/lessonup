import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import {
  bindFastProviderContext,
  bindProviderContext,
  FAST_SYSTEM_INSTRUCTIONS,
  STATIC_SYSTEM_INSTRUCTIONS,
  conversationalTurns,
  turnContextMessage,
} from "./prompt-layout.js";
import type { PiMemorySummary } from "./memory.js";

const userMessage = (text: string): AgentMessage => ({
  role: "user",
  timestamp: 1,
  content: [{ type: "text", text }],
});

const summary: PiMemorySummary = {
  schemaVersion: 1,
  runtime: "pi",
  summarizedThrough: 2,
  goals: ["修订教学过程"],
  durableFacts: [],
  decisions: [],
  resourceReferences: [],
  evidence: [],
  unresolved: [],
  rejectedOrSuperseded: [],
};

describe("provider-bound prompt layout", () => {
  it("keeps per-turn server policy out of the cacheable system prefix", () => {
    expect(STATIC_SYSTEM_INSTRUCTIONS).toContain("<lessonup_turn_context>");
    expect(STATIC_SYSTEM_INSTRUCTIONS).not.toContain('trust="server-policy"');
    expect(STATIC_SYSTEM_INSTRUCTIONS).not.toContain('"sectionId"');
  });

  it("makes A4 subheadings conditional on real content structure", () => {
    expect(STATIC_SYSTEM_INSTRUCTIONS).toContain("段落或清单已能表达清楚时不加小标题");
    expect(STATIC_SYSTEM_INSTRUCTIONS).toContain("仅当同一栏确有需要区分的主题或阶段");
    expect(STATIC_SYSTEM_INSTRUCTIONS).not.toContain("优先用简短标题");
  });

  it("keeps importance-first marker composition in the shared authoring instructions", () => {
    expect(STATIC_SYSTEM_INSTRUCTIONS).toContain("先辨认真正支撑本课理解与实施的重要内容");
    expect(STATIC_SYSTEM_INSTRUCTIONS).toContain("最短但语义完整片段");
    expect(STATIC_SYSTEM_INSTRUCTIONS).toContain("与正文一次生成");
    expect(STATIC_SYSTEM_INSTRUCTIONS).toContain("不要留到教师要求涂色时才处理");
    expect(STATIC_SYSTEM_INSTRUCTIONS).toContain("保留教师已有标记");
    expect(STATIC_SYSTEM_INSTRUCTIONS).toContain("不规定数量、密度、每栏必标");
    for (const example of ["==文字==", "=={pink}文字==", "=={green}文字==", "=={blue}文字==", "=={red}文字=="]) {
      expect(STATIC_SYSTEM_INSTRUCTIONS).toContain(example);
    }
  });

  it("appends the current turn context after history so two turns share a prefix", () => {
    const history = [userMessage("教学过程写得怎么样？"), fauxAssistantMessage("已经完整。")];
    const first = bindProviderContext({ messages: history, turnContext: { focus: { sectionId: "process" } } });
    const second = bindProviderContext({
      messages: [...history, userMessage("那教学准备呢？")],
      turnContext: { focus: { sectionId: "preparation" } },
    });

    expect(first.at(-1)).toEqual(turnContextMessage({ focus: { sectionId: "process" } }));
    expect(second.at(-1)).toEqual(turnContextMessage({ focus: { sectionId: "preparation" } }));
    expect(second.slice(0, history.length)).toEqual(history);
    expect(first.slice(0, history.length)).toEqual(history);
  });

  it("does not persist the turn context into the next request's history prefix", () => {
    const history = [userMessage("先看教学过程")];
    const first = bindProviderContext({
      messages: history,
      turnContext: { policy: { completion: "analysis_only" } },
    });
    const nextHistory = [...history, fauxAssistantMessage("过程已经完整。")];
    const second = bindProviderContext({
      messages: nextHistory,
      turnContext: { policy: { completion: "brief_reply_only" } },
    });

    expect(second.some((message) => JSON.stringify(message).includes("analysis_only"))).toBe(false);
    expect(first.at(-1)).not.toEqual(second[history.length]);
  });

  it("still places a compact memory summary in front of the retained tail", () => {
    const messages = [
      userMessage("旧一"),
      fauxAssistantMessage("旧答"),
      userMessage("最近一轮"),
      fauxAssistantMessage("最近回答"),
    ];
    const bound = bindProviderContext({
      messages,
      memory: summary,
      turnContext: { focus: { sectionId: "process" } },
    });

    expect(JSON.stringify(bound[0])).toContain("<lessonup_memory");
    expect(bound.slice(1, -1)).toEqual(messages.slice(2));
    expect(bound.at(-1)).toEqual(turnContextMessage({ focus: { sectionId: "process" } }));
  });

  it("gives Fast chat a compact conversation view without tool internals", () => {
    const history = [
      userMessage("请修改评价练习"),
      {
        role: "assistant" as const,
        timestamp: 2,
        content: [
          { type: "text" as const, text: "已提交确认。" },
          { type: "toolCall" as const, id: "c1", name: "propose_document_patch", arguments: { field: "assessment" } },
        ],
      },
      userMessage("好的 谢谢"),
    ];
    const bound = bindFastProviderContext({
      messages: history as never,
      turnContext: { policy: { completion: "brief_reply_only" } },
    });

    expect(FAST_SYSTEM_INSTRUCTIONS).toContain("没有工具");
    expect(FAST_SYSTEM_INSTRUCTIONS).not.toBe(STATIC_SYSTEM_INSTRUCTIONS);
    expect(JSON.stringify(bound)).not.toContain("propose_document_patch");
    expect(bound).toHaveLength(4);
    expect(bound.at(-1)).toEqual(turnContextMessage({ policy: { completion: "brief_reply_only" } }));
  });

  it("budgets Fast history by tokens while always retaining the current message", () => {
    const selected = conversationalTurns([
      userMessage("很早的背景".repeat(1_000)),
      fauxAssistantMessage("很早的回答".repeat(1_000)),
      userMessage("当前问题"),
    ], 100);
    expect(selected).toEqual([userMessage("当前问题")]);
  });

  it("does not inject long-term memory into the isolated Fast inference view", () => {
    const bound = bindFastProviderContext({
      messages: [userMessage("谢谢")],
      turnContext: { policy: { completion: "brief_reply_only" } },
    });
    expect(JSON.stringify(bound)).not.toContain("lessonup_memory");
  });
});
