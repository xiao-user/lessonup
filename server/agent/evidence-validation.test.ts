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

describe("validateObservedEvidence with attempted retrievals", () => {
  const consult = plan({ writeMode: "consultative", requiredEvidenceKinds: ["curriculum_standard_search"] });

  it("counts a search that found nothing as a look, so a consultation can say so honestly", () => {
    expect(validateObservedEvidence({
      plan: consult,
      evidence: [],
      attemptedKinds: new Set(["curriculum_standard_search"]),
    })).toMatchObject({ tripwireTriggered: false, outputInfo: { code: "ok", missingKinds: [] } });
  });

  it("does not let an attempt at one kind stand in for another required kind", () => {
    expect(validateObservedEvidence({
      plan: consult,
      evidence: [],
      attemptedKinds: new Set(["knowledge_search"]),
    })).toMatchObject({
      tripwireTriggered: true,
      outputInfo: { missingKinds: ["curriculum_standard_search"] },
    });
  });

  it("ignores attempts at reads that are not direct observations", () => {
    expect(validateObservedEvidence({
      plan: plan({ writeMode: "consultative" }),
      evidence: [],
      attemptedKinds: new Set(["web_search", "source_metadata"]),
    }).tripwireTriggered).toBe(true);
  });

  it("still asks for stored records when no attempts are passed, as a write does", () => {
    expect(validateObservedEvidence({ plan: consult, evidence: [] }).tripwireTriggered).toBe(true);
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
