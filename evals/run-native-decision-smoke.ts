import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { hasModelProvider } from "../server/config.js";
import { MemoryLessonRepository } from "../server/repositories/memory-repository.js";
import { PiLessonAgentCoordinator } from "../server/agent-runtime/pi/coordinator.js";
import { LearningService } from "../server/learning/service.js";
import { DecisionService } from "../server/decisions/service.js";
import type { AgentTaskIntent, NormalizedAgentEvent } from "../server/domain.js";
import { resolveTeacherThinkingLevel } from "../server/agent-runtime/pi/thinking-level.js";

if (!hasModelProvider) throw new Error("model_provider_not_configured");
async function createFixture(seedEvidence: boolean) {
  const repository = new MemoryLessonRepository();
  const ownerId = crypto.randomUUID();
  const notebook = await repository.createNotebook(ownerId, {
    title: "隔离评测：真实模型决策", subject: "语文", className: "合成八年级班级", year: "2026", tone: "teal",
  });
  const file = await repository.createLessonFile(ownerId, {
    notebookId: notebook.id, title: "《春》比喻的表达效果（合成评测）", type: "阅读课", pageCount: 1,
    document: {
      unit: "写景散文", period: "2", totalPeriods: "2", topic: "《春》中比喻的表达效果", knowledgePoints: "比喻；本体与喻体；表达效果",
      continuity: "承接上节课的比喻识别",
      objectives: "学生能结合具体语句解释比喻如何增强表达效果，而不是只识别比喻。",
      focus: "从识别比喻走向解释效果", preparation: "课文、出口条",
      process: "一、回顾比喻识别\n二、比较两组解释\n三、独立解释新语句\n四、出口条",
      assessment: "出口条：从课文中找出一个比喻句，并说明它把什么比作什么。当前判据侧重识别，未要求解释效果。",
      homework: "摘抄一个比喻句并写一两句感受。", board: "比喻 → 相似点 → 表达效果",
      reflection: "",
    },
  });
  const learning = new LearningService(repository);
  const baseline = seedEvidence ? await learning.recordEvidence({ ownerId, lessonFileId: file.id }, {
    documentVersion: 0,
    objective: "解释比喻的表达效果",
    task: "在《春》中找出比喻句并说明表达效果",
    criterion: "能指出本体、喻体，并解释相似点如何增强表达效果",
    learnerGroup: "合成八年级班级 30 份匿名出口条",
    observation: "合成评测数据：30 份中 9 份解释了表达效果，21 份只标出比喻或写出本体喻体。并非真实课堂结果。",
    method: "student_work",
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    sourceReference: "隔离评测合成出口条，不代表真实学生",
    sampleSize: 30,
    meetingCriterion: 9,
  }, "synthetic-decision-baseline") : null;
  return { repository, ownerId, notebook, file, baseline };
}

const cases: Array<{ id: string; prompt: string; taskIntent: AgentTaskIntent }> = [{
  id: "goal_evidence",
  prompt: [
    "这是隔离的真实模型评测，所有学生数据均为合成标注，不代表真实课堂。",
    "请读取当前教案与已记录的学习证据，判断当前出口条是否足以检验本课目标，并准备一个关于目标与达成证据的教学决策候选。",
    "至少比较“保留现评估”和一个替代方案；写清可定位证据、反例、假设、不确定性、置信度、预期信号与证伪条件。",
    "仅准备设计对齐假设，不把合成数据当真实学生表现，不替我确认、实施或审议。",
    "证据卡逐字摘录实际工具返回的单一原文片段，使用 lessonSource.uri 或学习观察 sourceUri 与版本，保留合成标注；不要为教案内部对齐判断另设外部材料前提。",
  ].join("\n"),
  taskIntent: { type: "decision_proposal" },
}, {
  id: "insufficient_evidence",
  prompt: [
    "这是隔离的真实模型评测，尚未收集任何真实学生证据。",
    "请判断是否有足够证据断定把本课评价改成无提示新段落解释就能提高本班学习效果，并准备一个教学决策候选。",
    "没有真实学生观察时保存 status=insufficient_evidence，说明还缺什么观察。不替我确认、实施或审议；引用时逐字摘录工具原文并使用 lessonSource.uri 与版本。",
  ].join("\n"),
  taskIntent: { type: "decision_proposal" },
}];

const results: Array<Record<string, unknown>> = [];
const thinkingLevel = resolveTeacherThinkingLevel(process.env.LESSONUP_EVAL_THINKING_LEVEL);
const selectedCaseIds = (process.env.LESSONUP_EVAL_CASE_IDS ?? "").split(",").filter(Boolean);
for (const testCase of cases.filter((item) => !selectedCaseIds.length || selectedCaseIds.includes(item.id))) {
  const { repository, ownerId, notebook, file, baseline } = await createFixture(testCase.id === "goal_evidence");
  const decisions = new DecisionService(repository);
  const coordinator = new PiLessonAgentCoordinator(repository, { embedQuery: null });
  const initialEvidence = await repository.listLearningEvidence(ownerId, file.id, 20);
  const initialDecisions = await repository.listDecisions(ownerId, file.id, 20);
  if (initialDecisions.length || initialEvidence.length !== (baseline ? 1 : 0)) throw new Error("smoke_fixture_contaminated");
  const { thread, branch } = await repository.createThread(ownerId, {
    notebookId: notebook.id, lessonFileId: file.id, title: testCase.id,
  });
  const events: NormalizedAgentEvent[] = [];
  let runId: string | undefined;
  let firstTextMs: number | null = null;
  const started = performance.now();
  const timer = setTimeout(() => { if (runId) void coordinator.cancel(ownerId, runId); }, 120_000);
  try {
    await coordinator.start({
      userId: ownerId, threadId: thread.id, branchId: branch.id, message: testCase.prompt,
      taskIntent: testCase.taskIntent, activeSectionId: "assessment", documentVersion: 0,
      attachmentIds: [], thinkingLevel,
    }, (event) => {
      events.push(event);
      if (event.type === "run.started") runId = event.runId;
      if (event.type === "message.delta" && firstTextMs === null) firstTextMs = Math.round(performance.now() - started);
    });
  } finally { clearTimeout(timer); }
  await repository.recoverExpiredRuns(ownerId, thread.id);
  const run = await repository.getLatestRun(ownerId, thread.id, branch.id);
  const progress = await decisions.read({ ownerId, lessonFileId: file.id }, { limit: 20 });
  const proposal = progress.decisions.find((decision) => decision.provenance.modelRunId === run?.id) ?? null;
  const evidence = proposal
    ? progress.evidenceCards.filter((card) => proposal.evidenceCardIds.includes(card.id))
    : [];
  const response = run?.assistantMessageId ? (await repository.getMessage(ownerId, run.assistantMessageId))?.content ?? "" : "";
  const completedTools = events.filter(
    (event): event is Extract<NormalizedAgentEvent, { type: "tool.completed" }> => event.type === "tool.completed",
  );
  const toolCalls = completedTools.map((event) => ({ name: event.name, ok: event.ok }));
  const toolErrors = completedTools.filter((event) => !event.ok).map((event) => ({ name: event.name, detail: event.detail }));
  const proposalOk = proposal !== null
    && ["proposed", "insufficient_evidence"].includes(proposal.status)
    && proposal.provenance.createdBy === "agent"
    && proposal.provenance.confirmedBy === null
    && proposal.version === 1 && !proposal.implementation && !proposal.review;
  const structureOk = Boolean(proposal) && (testCase.id === "goal_evidence"
    ? proposal!.status === "proposed" && proposal!.options.length >= 2 && evidence.length > 0
      && proposal!.counterevidence.length > 0 && proposal!.uncertainties.length > 0
      && Boolean(proposal!.falsifier.trim() && proposal!.expectedSignal.trim()) && proposal!.confidence !== null
    : proposal!.status === "insufficient_evidence" && proposal!.uncertainties.length > 0);
  const sourceErrors: string[] = [];
  const normalize = (value: string) => value.replace(/\s+/g, "");
  for (const card of evidence) {
    if (card.source.uri === `lessonup://lesson-files/${file.id}`) {
      if (["curriculum_standard", "textbook", "student_work", "classroom_observation"].includes(card.kind)) sourceErrors.push("document_source_kind_mismatch");
      if (card.source.version !== "0") sourceErrors.push("document_version_mismatch");
      if (!Object.values(file.document).some((value) => normalize(value).includes(normalize(card.excerpt)))) {
        sourceErrors.push("document_excerpt_not_exact");
      }
    } else if (baseline && card.source.uri === `lessonup://learning-evidence/${baseline.id}`) {
      if (!normalize(baseline.observation).includes(normalize(card.excerpt))) sourceErrors.push("observation_excerpt_not_exact");
      if (card.level !== "synthetic" || !JSON.stringify(card).includes("合成")) sourceErrors.push("synthetic_provenance_lost");
    } else sourceErrors.push(`unresolved_source:${card.source.uri}`);
    if (!card.source.locator || !card.excerpt.trim() || !card.limitations.length) sourceErrors.push("incomplete_source");
  }
  const evidenceOk = Boolean(proposal) && evidence.length === proposal!.evidenceCardIds.length && sourceErrors.length === 0;
  const passed = run?.status === "completed" && proposalOk && structureOk && evidenceOk
    && (await repository.getLessonFile(ownerId, file.id))?.documentVersion === 0;
  const session = await repository.getAgentRuntimeSession(ownerId, thread.id, branch.id, "pi");
  const failedToolResults = (session?.messages ?? []).filter((message) => {
    const item = message as { role?: string; isError?: boolean };
    return item.role === "toolResult" && item.isError;
  }).map((message) => {
    const item = message as { toolName?: string; content?: unknown };
    return { toolName: item.toolName, content: item.content };
  });
  results.push({
    id: testCase.id, passed, status: run?.status, error: run?.error, failedToolResults,
    durationMs: Math.round(performance.now() - started), firstTextMs, tokenUsage: run?.tokenUsage,
    toolCalls, toolErrors, sourceErrors,
    reviewMaterial: { prompt: testCase.prompt, document: file.document, baselineEvidence: baseline,
      initialEvidenceCount: initialEvidence.length, initialDecisionCount: initialDecisions.length },
    decision: proposal ? {
      id: proposal.id, status: proposal.status, decisionType: proposal.decisionType,
      question: proposal.question, options: proposal.options, chosenOptionId: proposal.chosenOptionId,
      rationale: proposal.rationale, counterevidence: proposal.counterevidence,
      assumptions: proposal.assumptions, uncertainties: proposal.uncertainties,
      confidence: proposal.confidence, expectedSignal: proposal.expectedSignal,
      falsifier: proposal.falsifier, evidenceCards: evidence,
      provenance: proposal.provenance,
    } : null,
    checks: { proposalOk, structureOk, evidenceOk, documentVersionUnchanged: (await repository.getLessonFile(ownerId, file.id))?.documentVersion === 0 },
    response,
  });
  console.log(JSON.stringify({ id: testCase.id, passed, status: run?.status, decisionStatus: proposal?.status,
    tools: toolCalls.map((call) => call.name), durationMs: results.at(-1)!.durationMs }));
  if (testCase.id === "goal_evidence" && baseline) {
    // Keep the seeded evidence visible in the report so a reviewer can spot unsupported claims.
    results.at(-1)!.baselineEvidence = baseline;
  }
}
if (!results.length) throw new Error("no_selected_smoke_cases");
const directory = process.env.LESSONUP_EVAL_OUTPUT_DIR ?? path.join(tmpdir(), "lessonup-evals", "native-decision");
await mkdir(directory, { recursive: true });
const report = `${JSON.stringify({
  thinkingLevel,
  results,
  boundary: "Live configured model and native Pi with isolated synthetic data. Not evidence of classroom effectiveness, external expert consensus or teacher usability.",
}, null, 2)}\n`;
await writeFile(path.join(directory, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), report);
await writeFile(path.join(directory, "latest.json"), report);
if (results.some((result) => !result.passed)) process.exitCode = 1;
