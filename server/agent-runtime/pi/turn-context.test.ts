import { describe, expect, it } from "vitest";
import type {
  CapabilityPlan,
  LessonAgentContext,
  LessonPlan,
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

  it("distinguishes teacher-defined design drafts from source-bound writes", () => {
    const draft = lessonTurnContext(lessonContext, [], { ...basePlan, writeMode: "explicit", fullRewriteRequested: true, evidenceRequired: false }, "write");
    expect(draft.policy.evidence.required).toBe(false);
    expect(draft.policy.evidence.instruction).toContain("teacher's stated goals");
    expect(draft.policy.evidence.instruction).toContain("An empty search never establishes source support");
    expect(draft.policy.evidence.instruction).not.toContain("call complete_without_change");
    const sourceBound = lessonTurnContext(lessonContext, [], { ...basePlan, writeMode: "explicit", evidenceRequired: true,
      requiredEvidenceKinds: ["curriculum_standard_search"] }, "write");
    expect(sourceBound.policy.evidence.instruction).toContain("call complete_without_change");
    expect(sourceBound.policy.evidence.instruction).toContain("An empty search is not evidence");
  });

  it("binds the current complete document to a full rewrite without a duplicate read round", () => {
    const document = {
      unit: "第一单元",
      period: "第 1 课时",
      totalPeriods: "共 2 课时",
      topic: "春日图景",
      objectives: "辨认五幅画面",
      knowledgePoints: "对象与特点",
      continuity: "承接小学写景经验",
      focus: "用证据概括",
      preparation: "课文",
      process: "圈画并概括",
      assessment: "完成概括表",
      homework: "摘录一处描写",
      board: "对象—特点",
      reflection: "",
    } satisfies LessonPlan;
    const context = lessonTurnContext(
      lessonContext,
      [],
      { ...basePlan, writeMode: "explicit", fullRewriteRequested: true },
      "write",
      undefined,
      [],
      document,
    );
    expect(context.canonicalDocument).toEqual({
      source: "server_bound_current_version",
      version: 7,
      complete: true,
      fields: document,
    });
    expect(context.policy.evidence.instruction).toContain("do not call read_document");
  });

  it("keeps open lesson work able to reply or create an approval proposal", () => {
    const open = { ...basePlan, writeMode: "open" } as CapabilityPlan;
    expect(lessonTurnContext(lessonContext, [], open, "write")).toMatchObject({
      policy: { mode: "open", completion: "reply_or_propose_document_patch" },
    });
  });
});
