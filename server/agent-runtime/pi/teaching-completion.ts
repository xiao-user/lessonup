import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export type TeachingNoChange = { kind: "no_change_needed" | "insufficient_evidence"; reason: string };

/** A no-op is an explicit, grounded result, not a missing write or text guess. */
export function withTeachingCompletion(
  tools: AgentTool<any>[],
  hasProposal: () => boolean,
  options: { decisionCandidateRequired?: boolean; canonicalContentBound?: boolean } = {},
) {
  const observed = new Set<string>(options.canonicalContentBound ? ["server_bound_current_version"] : []);
  let outcome: TeachingNoChange | null = null;
  let writeAttempted = false;
  const canonicalReads = new Set(["read_document", "read_section", "read_semester_framework", "read_semester_unit"]);
  const wrapped = tools.map((tool) => ({
    ...tool,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      if (outcome && tool.name.startsWith("propose_")) throw new Error("teaching_result_already_completed");
      if (tool.name.startsWith("propose_")) writeAttempted = true;
      const result = await tool.execute(...args);
      if (canonicalReads.has(tool.name)) observed.add(tool.name);
      return result;
    },
  }));
  const complete: AgentTool<any> = {
    name: "complete_without_change", label: "说明保留现稿或证据缺口",
    description: "依据已读取或服务端已绑定的当前规范正文，明确说明无需改动或证据不足。完成本轮但不写入、不生成审批。不能与任何修改提案同时提交。",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("no_change_needed"), Type.Literal("insufficient_evidence")]),
      reason: Type.String({ minLength: 10, maxLength: 2_000 }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_callId, input) => {
      if (options.decisionCandidateRequired) throw new Error("decision_candidate_required:use propose_decision with status insufficient_evidence when evidence is missing; this does not confirm or implement a change");
      if (!observed.size) throw new Error("canonical_read_required");
      if (hasProposal()) throw new Error("teaching_result_already_completed");
      outcome = input as TeachingNoChange;
      return { content: [{ type: "text", text: JSON.stringify({ status: "completed_without_change", ...outcome }) }], details: { publicOutcome: "no_change" }, terminate: true };
    },
  };
  return { tools: [...wrapped, complete], getNoChange: () => outcome, hasWriteAttempt: () => writeAttempted };
}
