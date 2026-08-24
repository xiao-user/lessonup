import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { findPiCompactionCursor } from "./memory.js";
import {
  PublicTextGuard,
  repairDurableHistory,
  systemPromptWithSkills,
} from "./session-state.js";

const userMessage = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: Date.now(),
});

describe("Pi native Agent session state", () => {
  it("drops an incomplete tool protocol tail but preserves the last settled turn", () => {
    const settled = [userMessage("第一轮"), fauxAssistantMessage("已完成第一轮")];
    const repaired = repairDurableHistory([
      ...settled,
      userMessage("第二轮"),
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
    ]);
    expect(repaired).toEqual(settled);
  });

  it("never publishes provider tool protocol as assistant text", () => {
    const guard = new PublicTextGuard();
    expect(guard.push("准备调用 <tool_call>read_document")).toBe("");
    expect(guard.hasViolation).toBe(true);
    expect(guard.flush()).toBe("");
  });

  it("streams ordinary text immediately while retaining only a possible protocol marker", () => {
    const guard = new PublicTextGuard();
    expect(guard.push("正在分析当前教案。 ")).toBe("正在分析当前教案。 ");
    expect(guard.push("准备<tool_")).toBe("准备");
    expect(guard.push("call>read_document")).toBe("");
    expect(guard.hasViolation).toBe(true);
  });

  it("compacts only at a complete user-turn boundary and keeps versioned skills in the system context", () => {
    const messages = [
      userMessage("一"), fauxAssistantMessage("答一"),
      userMessage("二"), fauxAssistantMessage("答二"),
      userMessage("三"), fauxAssistantMessage("答三"),
    ];
    expect(findPiCompactionCursor(messages, 2)).toBe(4);
    expect(systemPromptWithSkills("base", [{
      id: "classroom-direction",
      version: "1.2.3",
      description: "课堂编导",
      instructions: "按学习过程组织课堂材料。",
      requiredTools: [],
      requiredMcp: [],
    }])).toContain('<skill id="classroom-direction" version="1.2.3">');
  });
});
