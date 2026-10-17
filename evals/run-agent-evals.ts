import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { gradeApprovalRequirement, gradeToolRequirements } from "./tool-outcomes.js";
import { resolveEvalGraderConfig } from "./config.js";
import { createPiGraderClient } from "./pi-grader.js";
import {
  exposesInternalImplementationDetails,
  gradeBusinessResponse,
  unavailableBusinessGrade,
} from "./grading.js";
import {
  gradePerformance,
  isSafePublicEvent,
  resolvePerformanceBudget,
  type AgentEvalPerformance,
} from "./performance.js";

type EvalCase = {
  id: string;
  resourceType?: "lesson_file" | "semester_framework";
  prompt: string;
  requiredAnyTools?: string[];
  requiredTools?: string[];
  forbiddenTools?: string[];
  requiresApproval: boolean;
  allowsNoChange?: boolean;
  requiresSource: boolean;
  rubric: string[];
  minimumRubricScore?: number;
  minimumCoreScore?: number;
  requireDocumentGrounding?: boolean;
  requireCurriculumGrounding?: boolean;
  requireClassroomActionability?: boolean;
  rejectGeneric?: boolean;
  rejectUnsupportedPrecision?: boolean;
  rejectInternalImplementationDetails?: boolean;
};

type AgentEvent = {
  type: string;
  runId?: string;
  name?: string;
  approvalId?: string;
  source?: { id?: string };
  error?: string;
  revisionCode?: string;
  patch?: unknown;
  ok?: boolean;
};

type RunActivity = {
  run?: {
    tokenUsage?: {
      requests?: number;
      inputTokens?: number;
      cachedInputTokens?: number;
    };
  };
};

const requiredEnvironment = [
  "LESSONUP_EVAL_ACCESS_TOKEN",
  "LESSONUP_EVAL_NOTEBOOK_ID",
  "LESSONUP_EVAL_LESSON_FILE_ID",
] as const;

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`missing_required_environment:${name}`);
  }
}

const baseUrl = process.env.LESSONUP_EVAL_BASE_URL ?? "http://127.0.0.1:8787";
const headers = {
  authorization: `Bearer ${process.env.LESSONUP_EVAL_ACCESS_TOKEN}`,
  "content-type": "application/json",
};
const graderConfig = resolveEvalGraderConfig(process.env);
const performanceBudget = resolvePerformanceBudget(process.env);
const grader = createPiGraderClient({
  apiKey: graderConfig.apiKey,
  baseURL: graderConfig.baseURL,
  api: graderConfig.api,
  contextWindow: graderConfig.contextWindow,
  maxTokens: graderConfig.maxTokens,
});

const approvalFieldLabels: Record<string, string> = {
  unit: "单元",
  period: "课时",
  totalPeriods: "总课时",
  topic: "课题",
  objectives: "教学目标",
  focus: "重点难点",
  preparation: "教学准备",
  process: "教学过程",
  assessment: "评价练习",
  homework: "作业设计",
  board: "板书设计",
  reflection: "教学反思",
  mainActivity: "主要活动",
  observableProduct: "学生可观察产出",
  assessmentEvidence: "达成证据",
  anticipatedDifficulties: "预期困难",
  plannedMinutes: "计划用时",
  teacherNotes: "教师备注",
};

function teacherFacingApprovalText(patch: unknown) {
  if (!patch || typeof patch !== "object") {
    return "已生成一项待教师确认的修改。完整改动显示在确认卡中，批准前不会写入。";
  }
  const value = patch as { summary?: unknown; operations?: unknown };
  const summary = typeof value.summary === "string"
    ? Object.entries(approvalFieldLabels).reduce(
        (text, [field, label]) => text.replaceAll(field, label),
        value.summary,
      )
    : "完善当前备课内容";
  const details = Array.isArray(value.operations)
    ? value.operations.flatMap((operation) => {
        if (!operation || typeof operation !== "object") return [];
        const item = operation as { field?: unknown; replacement?: unknown };
        if (typeof item.field !== "string" || !(item.field in approvalFieldLabels)) return [];
        const replacement = typeof item.replacement === "string"
          ? item.replacement
          : JSON.stringify(item.replacement);
        return replacement
          ? [`${approvalFieldLabels[item.field]}：\n${replacement}`]
          : [];
      })
    : [];
  return [
    `已生成一项待教师确认的修改：${summary}。`,
    ...details,
    "完整改动显示在确认卡中，批准前不会写入。",
  ].join("\n\n");
}

async function request<T>(pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `request_failed:${response.status}`);
  }
  return response.status === 204 ? null as T : response.json() as Promise<T>;
}

async function consumeSse(pathname: string, body: unknown) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) throw new Error(`stream_failed:${response.status}`);

  const events: AgentEvent[] = [];
  let firstOutputMs: number | null = null;
  let firstSafeEventMs: number | null = null;
  let firstProviderEventMs: number | null = null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) {
        const event = JSON.parse(data) as AgentEvent;
        if (event.type === "message.delta" && firstOutputMs === null) {
          firstOutputMs = Math.round(performance.now() - startedAt);
        }
        if (isSafePublicEvent(event.type) && firstSafeEventMs === null) {
          firstSafeEventMs = Math.round(performance.now() - startedAt);
        }
        if (event.type === "assistant.message.started" && firstProviderEventMs === null) {
          firstProviderEventMs = Math.round(performance.now() - startedAt);
        }
        events.push(event);
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  return { events, firstOutputMs, firstSafeEventMs, firstProviderEventMs };
}

const caseSource = await readFile(new URL("./cases.jsonl", import.meta.url), "utf8");
const selectedCaseIds = new Set(
  (process.env.LESSONUP_EVAL_CASE_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
);
const allCases = caseSource.split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvalCase);
const cases = selectedCaseIds.size
  ? allCases.filter((testCase) => selectedCaseIds.has(testCase.id))
  : allCases;
if (
  cases.some((testCase) => testCase.resourceType === "semester_framework")
  && !process.env.LESSONUP_EVAL_SEMESTER_FRAMEWORK_ID
) throw new Error("missing_required_environment:LESSONUP_EVAL_SEMESTER_FRAMEWORK_ID");
const results = [];

for (const testCase of cases) {
  const isFrameworkCase = testCase.resourceType === "semester_framework";
  const created = await request<{
    thread: { id: string };
    branch: { id: string };
  }>("/api/agent/threads", {
    method: "POST",
    body: JSON.stringify({
      notebookId: process.env.LESSONUP_EVAL_NOTEBOOK_ID,
      ...(isFrameworkCase
        ? { semesterFrameworkId: process.env.LESSONUP_EVAL_SEMESTER_FRAMEWORK_ID }
        : { lessonFileId: process.env.LESSONUP_EVAL_LESSON_FILE_ID }),
      title: `Eval · ${testCase.id}`,
    }),
  });

  let events: AgentEvent[] = [];
  let lessonFile: {
    title?: string;
    type?: string;
    documentVersion: number;
    document: unknown;
    contextProfile?: {
      textbookId?: string;
      lessonNodeId?: string;
      unitNodeId?: string;
      lessonDurationMinutes?: number;
      learnerProfile?: string;
    };
  } | undefined;
  let semesterFramework: {
    framework: {
      title: string;
      term: string;
      totalWeeks: number;
      weeklyPeriods: number;
      lessonDurationMinutes: number;
      capacityRatio: number;
      contextProfile: unknown;
      version: number;
    };
    units: Array<{ id: string; learningGoals: string; plannedPeriods: number; status: string }>;
    blueprints: unknown[];
    outcomeSelections: unknown[];
  } | undefined;
  let designBasis: unknown;
  let curriculumKnowledge: unknown;
  let frameworkContinuity: unknown;
  let classroomFeedback: unknown;
  let assistantResponse = "";
  let approvalPatch: unknown;
  let runActivity: RunActivity | null = null;
  let metrics: AgentEvalPerformance = {
    durationMs: 0,
    firstSafeEventMs: null,
    firstProviderEventMs: null,
    firstOutputMs: null,
    modelRequests: null,
    toolCalls: 0,
    inputTokens: null,
    cachedInputTokens: null,
  };
  try {
    if (isFrameworkCase) {
      semesterFramework = await request<NonNullable<typeof semesterFramework>>(
        `/api/semester-frameworks/${process.env.LESSONUP_EVAL_SEMESTER_FRAMEWORK_ID}`,
      );
      frameworkContinuity = await request(
        `/api/semester-frameworks/${process.env.LESSONUP_EVAL_SEMESTER_FRAMEWORK_ID}/continuity`,
      ).catch(() => null);
      classroomFeedback = await request(
        `/api/semester-frameworks/${process.env.LESSONUP_EVAL_SEMESTER_FRAMEWORK_ID}/class-feedback`,
      );
    } else {
      lessonFile = await request<NonNullable<typeof lessonFile>>(
        `/api/lesson-files/${process.env.LESSONUP_EVAL_LESSON_FILE_ID}`,
      );
      designBasis = await request(
        `/api/lesson-files/${process.env.LESSONUP_EVAL_LESSON_FILE_ID}/design-basis`,
      ).catch(() => null);
      classroomFeedback = await request(
        `/api/lesson-files/${process.env.LESSONUP_EVAL_LESSON_FILE_ID}/class-feedback`,
      );
      const textbookId = lessonFile.contextProfile?.textbookId;
      const curriculumNodeId = lessonFile.contextProfile?.lessonNodeId
        ?? lessonFile.contextProfile?.unitNodeId;
      curriculumKnowledge = textbookId && curriculumNodeId
        ? await request(
            `/api/curriculum/textbooks/${encodeURIComponent(textbookId)}/nodes/${encodeURIComponent(curriculumNodeId)}/knowledge-points`,
          ).catch(() => null)
        : null;
    }
    const startedAt = performance.now();
    const streamed = await consumeSse(`/api/agent/threads/${created.thread.id}/runs`, {
      branchId: created.branch.id,
      message: testCase.prompt,
      activeSectionId: isFrameworkCase ? "overview" : "basics",
      activeUnitId: isFrameworkCase ? semesterFramework?.units[0]?.id : undefined,
      documentVersion: isFrameworkCase
        ? semesterFramework!.framework.version
        : lessonFile!.documentVersion,
    });
    events = streamed.events;
    metrics.durationMs = Math.round(performance.now() - startedAt);
    metrics.firstSafeEventMs = streamed.firstSafeEventMs;
    metrics.firstProviderEventMs = streamed.firstProviderEventMs;
    metrics.firstOutputMs = streamed.firstOutputMs;
    runActivity = await request<RunActivity>(
      `/api/agent/threads/${created.thread.id}/activity?branchId=${created.branch.id}`,
    ).catch(() => null);
    const messages = await request<Array<{ role: string; content: string }>>(
      `/api/agent/threads/${created.thread.id}/messages?branchId=${created.branch.id}`,
    );
    assistantResponse = [...messages].reverse()
      .find((message) => message.role === "assistant")?.content ?? "";
    const approval = events.find((event) => event.type === "approval.required");
    approvalPatch = approval?.patch;
    if (!assistantResponse && approval?.patch) {
      assistantResponse = teacherFacingApprovalText(approval.patch);
    }
    if (approval?.approvalId && approval.runId) {
      await consumeSse(
        `/api/agent/runs/${approval.runId}/approvals/${approval.approvalId}`,
        { approved: false },
      );
    }
  } finally {
    await request(`/api/agent/threads/${created.thread.id}`, { method: "DELETE" }).catch(() => null);
  }

  const toolNames = events
    .filter((event) => event.type === "tool.started" && event.name)
    .map((event) => event.name as string);
  metrics.toolCalls = toolNames.length;
  metrics.modelRequests = runActivity?.run?.tokenUsage?.requests ?? null;
  metrics.inputTokens = runActivity?.run?.tokenUsage?.inputTokens ?? null;
  metrics.cachedInputTokens = runActivity?.run?.tokenUsage?.cachedInputTokens ?? null;
  const proposalRevisionCodes = events
    .filter((event) => event.type === "tool.completed" && event.revisionCode)
    .map((event) => event.revisionCode as string);
  const toolOutcomes = events
    .filter((event) => event.type === "tool.completed" && event.name)
    .map((event) => ({ name: event.name as string, ok: event.ok !== false }));
  const runErrors = events
    .filter((event) => event.type === "run.failed" && event.error)
    .map((event) => event.error as string);
  const failures = gradeToolRequirements(testCase, events);
  const hasApproval = events.some((event) => event.type === "approval.required");
  failures.push(...gradeApprovalRequirement(testCase, events));
  const hasSource = events.some((event) => event.type === "source.added");
  if (testCase.requiresSource && !hasSource) failures.push("missing_source");
  if (events.some((event) => event.type === "run.failed")) failures.push("run_failed");
  failures.push(...gradePerformance(metrics, performanceBudget));
  if (
    testCase.rejectInternalImplementationDetails !== false
    && exposesInternalImplementationDetails(assistantResponse)
  ) failures.push("internal_implementation_exposed");
  const rubric = {
    criteria: testCase.rubric,
    minimumScore: testCase.minimumRubricScore ?? 0.75,
    minimumCoreScore: testCase.minimumCoreScore ?? 0.75,
    requireDocumentGrounding: testCase.requireDocumentGrounding,
    requireCurriculumGrounding: testCase.requireCurriculumGrounding,
    requireClassroomActionability: testCase.requireClassroomActionability,
    rejectGeneric: testCase.rejectGeneric,
    rejectUnsupportedPrecision: testCase.rejectUnsupportedPrecision,
    rejectInternalImplementationDetails: testCase.rejectInternalImplementationDetails,
  };
  const businessGrade = await gradeBusinessResponse({
    client: grader,
    model: graderConfig.model,
    prompt: testCase.prompt,
    response: assistantResponse,
    document: isFrameworkCase ? semesterFramework : lessonFile?.document,
    businessContext: {
      resourceType: isFrameworkCase ? "semester_framework" : "lesson_file",
      lessonFile: lessonFile ? {
        title: lessonFile.title,
        type: lessonFile.type,
        contextProfile: lessonFile.contextProfile,
      } : null,
      designBasis,
      curriculumKnowledge,
      semesterFramework,
      frameworkContinuity,
      classroomFeedback,
    },
    rubric,
    observed: {
      toolNames,
      hasApproval,
      hasSource,
      approvalPatch,
      proposalRevisionCodes,
      toolOutcomes,
      runErrors,
    },
  }).catch((error: unknown) => unavailableBusinessGrade(
    rubric,
    error instanceof Error ? error.message : "unknown_grader_error",
  ));
  failures.push(...businessGrade.failures);

  results.push({
    id: testCase.id,
    resourceType: isFrameworkCase ? "semester_framework" : "lesson_file",
    passed: failures.length === 0,
    failures,
    observed: {
      toolNames,
      hasApproval,
      hasSource,
      terminalEvent: events.at(-1)?.type,
      proposalRevisionCodes,
      toolOutcomes,
      runErrors,
    },
    performance: metrics,
    assistantResponse,
    reviewMaterial: { prompt: testCase.prompt, document: isFrameworkCase ? semesterFramework : lessonFile?.document,
      businessContext: { resourceType: isFrameworkCase ? "semester_framework" : "lesson_file",
        designBasis, curriculumKnowledge, semesterFramework, frameworkContinuity, classroomFeedback } },
    businessGrade,
  });
}

const output = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  performanceBudget,
  cases: results,
  passed: results.filter((result) => result.passed).length,
  total: results.length,
};
const resultsDir = path.resolve(process.env.LESSONUP_EVAL_OUTPUT_DIR ?? path.join(tmpdir(), "lessonup-evals", "agent"));
await mkdir(resultsDir, { recursive: true });
await writeFile(path.join(resultsDir, "latest.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Agent evals: ${output.passed}/${output.total} automated gates passed.`);
for (const result of results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.id}${result.failures.length ? ` ${result.failures.join(",")}` : ""}`);
}
if (output.passed !== output.total) process.exitCode = 1;
