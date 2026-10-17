import { describe, expect, it } from "vitest";
import { gradeApprovalRequirement, gradeToolRequirements } from "./tool-outcomes.js";

describe("successful evidence gates", () => {
  const requirements = { requiredTools: ["read_document"], requiredAnyTools: ["search_knowledge", "search_curriculum_standards"] };
  it("does not count a started or failed read as evidence", () => {
    expect(gradeToolRequirements(requirements, [
      { type: "tool.started", name: "read_document" },
      { type: "tool.completed", name: "read_document", ok: false },
      { type: "tool.started", name: "search_knowledge" },
    ])).toEqual(["missing_required_tool:read_document", "missing_required_tool_group:search_knowledge|search_curriculum_standards"]);
  });
  it("allows recovery after an error only when a later call succeeds", () => {
    expect(gradeToolRequirements(requirements, [
      { type: "tool.completed", name: "read_document", ok: false },
      { type: "tool.completed", name: "read_document", ok: true },
      { type: "tool.completed", name: "search_curriculum_standards", ok: true },
    ])).toEqual([]);
  });
  it("rejects even an unsuccessful forbidden write attempt", () => {
    expect(gradeToolRequirements({ forbiddenTools: ["propose_document_patch"] }, [
      { type: "tool.started", name: "propose_document_patch" },
      { type: "tool.completed", name: "propose_document_patch", ok: false },
    ])).toEqual(["forbidden_tool:propose_document_patch"]);
  });
  it("allows a successful no-op only for conditional cases, while preserving required reads", () => {
    const events = [{ type: "tool.completed", name: "complete_without_change", ok: true }];
    const conditional = { allowsNoChange: true, requiredTools: ["read_document"], requiredAnyTools: ["propose_document_patch"] };
    expect(gradeToolRequirements(conditional, events)).toEqual(["missing_required_tool:read_document"]);
    expect(gradeApprovalRequirement({ requiresApproval: true, allowsNoChange: true }, events)).toEqual([]);
    expect(gradeApprovalRequirement({ requiresApproval: true }, events)).toEqual(["approval_mismatch:false"]);
    expect(gradeApprovalRequirement({ requiresApproval: true, allowsNoChange: true }, [...events, { type: "approval.required" }])).toEqual(["conflicting_completion"]);
    expect(gradeToolRequirements(conditional, [{ ...events[0], ok: false }])).toHaveLength(2);
  });
});
