import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { withTeachingCompletion } from "./teaching-completion.js";

const tool = (name: string, execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "当前规范内容" }], details: null }))) => ({
  name, label: name, description: name, parameters: Type.Object({}), execute,
} satisfies AgentTool<any>);

describe("grounded no-change completion", () => {
  it("keeps an evidence-gap decision open until a candidate is saved", async () => {
    const proposal = tool("propose_decision");
    const runtime = withTeachingCompletion([tool("read_document"), proposal], () => false, { decisionCandidateRequired: true });
    await runtime.tools[0]!.execute("read", {});
    await expect(runtime.tools.at(-1)!.execute("complete", { kind: "insufficient_evidence", reason: "缺少本班真实观察，需要先收集。" }))
      .rejects.toThrow("decision_candidate_required");
    expect(runtime.getNoChange()).toBeNull();
    await runtime.tools[1]!.execute("proposal", {});
    expect(proposal.execute).toHaveBeenCalledOnce();
  });
  it("requires a successful canonical content read and blocks later mutation proposals", async () => {
    const write = tool("propose_document_patch");
    const runtime = withTeachingCompletion([tool("read_document"), write], () => false);
    const complete = runtime.tools.at(-1)!;
    const outcome = { kind: "no_change_needed", reason: "当前评价已经直接检验中心目标，继续增加任务没有必要。" };
    await expect(complete.execute("no-read", outcome)).rejects.toThrow("canonical_read_required");
    await runtime.tools[0]!.execute("read", {});
    await complete.execute("complete", outcome);
    expect(runtime.getNoChange()).toEqual(outcome);
    await expect(runtime.tools[1]!.execute("write", {})).rejects.toThrow("teaching_result_already_completed");
    expect(write.execute).not.toHaveBeenCalled();
  });
  it("does not count a failed read or allow a no-change result alongside an existing proposal", async () => {
    const runtime = withTeachingCompletion([tool("read_document", vi.fn(async () => { throw new Error("scope_denied"); }))], () => false);
    await expect(runtime.tools[0]!.execute("read", {})).rejects.toThrow("scope_denied");
    await expect(runtime.tools.at(-1)!.execute("complete", { kind: "insufficient_evidence", reason: "需要真实观察与课标证据，不能编造。" })).rejects.toThrow("canonical_read_required");
    const proposed = withTeachingCompletion([tool("read_section")], () => true);
    await proposed.tools[0]!.execute("read", {});
    await expect(proposed.tools.at(-1)!.execute("complete", { kind: "no_change_needed", reason: "已经产生提案，不能又声称没有修改。" })).rejects.toThrow("teaching_result_already_completed");
  });
});
