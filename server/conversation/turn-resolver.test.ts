import { describe, expect, it } from "vitest";
import type { CapabilityPlan } from "../domain.js";
import { resolveTurn } from "./turn-resolver.js";

const plan = (patch: Partial<CapabilityPlan> = {}): CapabilityPlan => ({
  skillIds: [],
  toolGroups: ["document-read", "document-write"],
  mcpServers: [],
  specialistAgents: [],
  evidenceRequired: false,
  writeMode: "open",
  designBasisRequested: false,
  designBasisWriteRequested: false,
  minimalWriteRequested: false,
  fullRewriteRequested: false,
  classroomActionRequired: false,
  continuityRequested: false,
  lightweightConversation: false,
  executionLane: "agent",
  curriculumRequested: false,
  presentationRequested: false,
  presentationThemeConfirmationRequired: false,
  presentationThemeDismissed: false,
  reuseRecentEvidence: false,
  ...patch,
});

describe("turn resolver", () => {
  it("keeps an exact acknowledgement on the model-backed Fast conversation profile", () => {
    expect(resolveTurn({ plan: plan({ executionLane: "fast", lightweightConversation: true }) }))
      .toEqual({ kind: "ack", contextProfile: "fast_conversation", toolSurface: "none" });
  });

  it("keeps short conversational follow-ups tool-free", () => {
    expect(resolveTurn({ plan: plan({ executionLane: "fast" }) }))
      .toEqual({ kind: "conversation", contextProfile: "fast_conversation", toolSurface: "none" });
  });

  it("gives ordinary analysis a read-only surface", () => {
    expect(resolveTurn({ plan: plan({ writeMode: "consultative" }) }))
      .toEqual({ kind: "agent_read", contextProfile: "agent_read", toolSurface: "read" });
  });

  it("gives explicit and approval-gated mutations a write surface", () => {
    expect(resolveTurn({ plan: plan({ writeMode: "explicit" }) }).toolSurface).toBe("write");
    expect(resolveTurn({ plan: plan({ presentationRequested: true }) }).toolSurface).toBe("write");
    expect(resolveTurn({ plan: plan({ designBasisWriteRequested: true }) }).toolSurface).toBe("write");
  });

  it("keeps open mode reachable as an optional proposal surface", () => {
    expect(resolveTurn({ plan: plan({ writeMode: "open" }) }))
      .toEqual({ kind: "agent_write", contextProfile: "agent_write", toolSurface: "write" });
  });

  it("keeps non-idle interaction states outside free-form routing", () => {
    expect(resolveTurn({ interactionState: "awaiting_approval", plan: plan() }))
      .toEqual({ kind: "control", contextProfile: "control", toolSurface: "none" });
  });
});
