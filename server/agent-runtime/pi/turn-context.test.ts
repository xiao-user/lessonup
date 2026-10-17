import { describe, expect, it } from "vitest";
import type {
  CapabilityPlan,
  LessonAgentContext,
  SemesterFrameworkAgentContext,
} from "../../domain.js";
import {
  isFastExecution,
  lessonTurnContext,
  selectionTurnHint,
  semesterTurnContext,
} from "./turn-context.js";

const basePlan = {
  executionLane: "agent",
  lightweightConversation: false,
  presentationRequested: false,
  presentationThemeConfirmationRequired: false,
  presentationThemeDismissed: false,
  writeMode: "consultative",
  mcpServers: [],
  skillIds: [],
} as unknown as CapabilityPlan;

const lessonContext = {
  resourceType: "lesson_file",
  documentVersion: 7,
  activeSectionId: "objectives",
} as LessonAgentContext;

const semesterContext = {
  resourceType: "semester_framework",
  frameworkVersion: 4,
  activeUnitId: "unit-2",
} as SemesterFrameworkAgentContext;

describe("turn context policy", () => {
  it("preloads small selections but addresses oversized selections without copying their text", () => {
    expect(selectionTurnHint({ field: "process", start: 1, end: 4, text: "示例" }))
      .toMatchObject({ text: "示例", preloaded: true });
    const oversized = selectionTurnHint({ field: "process", start: 0, end: 2_401, text: "字".repeat(2_401) });
    expect(oversized).toEqual({
      field: "process",
      start: 0,
      end: 2_401,
      preloaded: false,
      originalLength: 2_401,
    });
  });

  it("keeps Fast eligibility out of continuations, attachments, and server-owned intents", () => {
    const fast = { ...basePlan, executionLane: "fast" } as CapabilityPlan;
    expect(isFastExecution(fast, {}, null)).toBe(true);
    expect(isFastExecution(fast, { attachmentIds: ["source-1"] }, null)).toBe(false);
    expect(isFastExecution(fast, { generationIntentId: "intent-1" }, null)).toBe(false);
    expect(isFastExecution(fast, {}, { status: "failed" })).toBe(false);
  });

  it("serializes lesson and semester policy without provider or repository state", () => {
    const lesson = lessonTurnContext(lessonContext, [], basePlan, "read");
    expect(lesson).toMatchObject({
      resource: { type: "lesson_file", version: 7 },
      focus: { sectionId: "objectives" },
      policy: { mode: "agent_read", completion: "analysis_only" },
    });
    const semester = semesterTurnContext(semesterContext, basePlan, "write");
    expect(semester).toMatchObject({
      resource: { type: "semester_framework", version: 4 },
      focus: { unitId: "unit-2" },
      policy: { mode: "consultative", completion: "analysis_only" },
    });
  });

  it("keeps open lesson work able to reply or create an approval proposal", () => {
    const open = { ...basePlan, writeMode: "open" } as CapabilityPlan;
    expect(lessonTurnContext(lessonContext, [], open, "write")).toMatchObject({
      policy: { mode: "open", completion: "reply_or_propose_document_patch" },
    });
  });
});
