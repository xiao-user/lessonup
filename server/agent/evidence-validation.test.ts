import { describe, expect, it } from "vitest";
import {
  evidenceRequiredToolError,
  validateObservedEvidence,
} from "./evidence-validation.js";
import type { CapabilityPlan } from "../domain.js";

const plan = (overrides: Partial<CapabilityPlan> = {}): CapabilityPlan => ({
  skillIds: [],
  toolGroups: [],
  mcpServers: [],
  specialistAgents: [],
  writeMode: "explicit",
  evidenceRequired: true,
  ...overrides,
});

describe("validateObservedEvidence", () => {
  it("reports missing required kinds so the write tool can tell the model what to read", () => {
    expect(validateObservedEvidence({
      plan: plan({ requiredEvidenceKinds: ["curriculum_standard_search"] }),
      evidence: [],
    })).toMatchObject({
      tripwireTriggered: true,
      outputInfo: {
        code: "evidence_required",
        missingKinds: ["curriculum_standard_search"],
      },
    });
  });
});

describe("evidenceRequiredToolError", () => {
  it("returns JSON that names the missing kinds and the matching read tools", () => {
    const payload = JSON.parse(evidenceRequiredToolError(["curriculum_standard_search"]).message);
    expect(payload).toEqual({
      error: "evidence_required",
      missingKinds: ["curriculum_standard_search"],
      message: expect.stringContaining("search_curriculum_standards"),
    });
    expect(payload.message).toContain("curriculum_standard_search");
  });
});
