import { describe, expect, it } from "vitest";

import type { CapabilityPlan } from "../domain.js";
import { validateObservedEvidence } from "./output-guardrails.js";

const evidencePlan: CapabilityPlan = {
  skillIds: [],
  toolGroups: ["document-read", "document-write"],
  mcpServers: ["knowledge"],
  specialistAgents: [],
  evidenceRequired: true,
};

describe("validateObservedEvidence", () => {
  it("rejects a consultation answer that never read evidence", () => {
    expect(validateObservedEvidence({ plan: evidencePlan, evidence: [] })).toMatchObject({
      tripwireTriggered: true,
      outputInfo: { code: "evidence_required" },
    });
  });

  it("does not treat web result titles as opened evidence", () => {
    expect(validateObservedEvidence({
      plan: evidencePlan,
      evidence: [{
        ownerId: "user-1",
        runId: "run-1",
        kind: "web_search",
        source: { id: "web-1", title: "搜索结果标题", kind: "web" },
        createdAt: new Date().toISOString(),
      }],
    }).tripwireTriggered).toBe(true);
  });

  it("requires a direct attachment read when the task names an attachment", () => {
    const plan: CapabilityPlan = {
      ...evidencePlan,
      requiredEvidenceKinds: ["attachment_read"],
    };
    expect(validateObservedEvidence({
      plan,
      evidence: [{
        ownerId: "user-1",
        runId: "run-1",
        kind: "knowledge_search",
        source: { id: "source-1", title: "其他知识", kind: "private" },
        createdAt: new Date().toISOString(),
      }],
    }).tripwireTriggered).toBe(true);
  });
});
