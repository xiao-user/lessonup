import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { hasModelProvider } from "../server/config.js";
import { MemoryLessonRepository } from "../server/repositories/memory-repository.js";
import { PiLessonAgentCoordinator } from "../server/agent-runtime/pi/coordinator.js";
import { LearningService } from "../server/learning/service.js";
import type { AgentTaskIntent, NormalizedAgentEvent } from "../server/domain.js";
import { resolveTeacherThinkingLevel } from "../server/agent-runtime/pi/thinking-level.js";

if (!hasModelProvider) throw new Error("model_provider_not_configured");
const repository = new MemoryLessonRepository();
const ownerId = crypto.randomUUID();
const notebook = await repository.createNotebook(ownerId, { title: "隔离评测：合成课堂", subject: "数学", className: "合成七年级班级", year: "2026", tone: "teal" });
const file = await repository.createLessonFile(ownerId, {
  notebookId: notebook.id, title: "有理数大小的比较（合成评测）", type: "教案", pageCount: 1,
  document: {
    unit: "有理数", period: "1", totalPeriods: "1", topic: "用数轴比较有理数大小", knowledgePoints: "数轴方向与有理数大小", continuity: "承接数轴标点",
    objectives: "学生能在数轴上标出两个有理数，并用左右位置解释比较结果。", focus: "负数大小与数轴位置的联系", preparation: "空白数轴任务单",
    process: "学生独立标出-3和-1，比较位置并口头说明。教师展示两份不同解释，要求学生用数轴位置检验，再独立比较-4与-2并说明依据。",
    assessment: "独立标出-4与-2并写一句比较依据。判据：点位正确、大小判断正确，并说明数轴上右侧点对应数较大。", homework: "用同一判据完成一组新的负数比较", board: "数轴位置 → 大小判断 → 解释依据", reflection: "实际表现待课后记录。",
  },
});
const learning = new LearningService(repository);
const baselineInput = {
  documentVersion: 0, objective: "用数轴位置解释有理数大小", task: "独立比较-3和-1并解释依据", criterion: "能用数轴左右位置解释大小判断",
  learnerGroup: "合成班级12份匿名作答", observation: "合成评测数据：12份作答中4份解释了位置关系，其余只给结论。并非真实课堂结果。",
  method: "assessment", observedAt: new Date(Date.now() - 60_000).toISOString(), sourceReference: "隔离评测合成样本，不代表真实学生", sampleSize: 12, meetingCriterion: 4,
};
const baseline = await learning.recordEvidence({ ownerId, lessonFileId: file.id }, baselineInput, "synthetic-baseline");
const coordinator = new PiLessonAgentCoordinator(repository, { embedQuery: null });
const results: Array<Record<string, unknown>> = [];
const thinkingLevel = resolveTeacherThinkingLevel(process.env.LESSONUP_EVAL_THINKING_LEVEL);
const cases = [
  { id: "grounded_no_change", prompt: "请先检查评价是否已经直接检验本课目标。只有确有必要时修改评价栏目；否则保留现稿，通过无修改完成说明具体理由。不要增加重复任务。", taskIntent: { type: "document_write", fields: ["assessment"] } as AgentTaskIntent },
  { id: "learning_proposal", prompt: "这是隔离的合成课堂案例。请读取当前教案与指定基线证据，比较一个主要解释和替代解释，提出可执行调整、预期信号和复测办法。只准备待采用方案，不编造实施或改善效果。", taskIntent: { type: "learning_inquiry", evidenceId: baseline.id } as AgentTaskIntent },
];
for (const testCase of cases) {
  const scope = { ownerId, lessonFileId: file.id };
  const focus = testCase.taskIntent.type === "learning_review" ? { inquiryId: testCase.taskIntent.inquiryId, evidenceId: testCase.taskIntent.evidenceId }
    : testCase.taskIntent.type === "learning_inquiry" ? { evidenceId: testCase.taskIntent.evidenceId } : {};
  const reviewMaterial = { prompt: testCase.prompt, document: file.document,
    businessContext: { fixture: "synthetic_isolated_memory", selected: await learning.readContext(scope, focus) } };
  const { thread, branch } = await repository.createThread(ownerId, { notebookId: notebook.id, lessonFileId: file.id, title: testCase.id });
  const events: NormalizedAgentEvent[] = [];
  let runId: string | undefined;
  let firstTextMs: number | null = null;
  const started = performance.now();
  const timer = setTimeout(() => { if (runId) void coordinator.cancel(ownerId, runId); }, 90_000);
  try {
    await coordinator.start({ userId: ownerId, threadId: thread.id, branchId: branch.id, message: testCase.prompt,
      taskIntent: testCase.taskIntent, activeSectionId: "assessment", documentVersion: 0, attachmentIds: [], thinkingLevel }, (event) => {
      events.push(event);
      if (event.type === "run.started") runId = event.runId;
      if (event.type === "message.delta" && firstTextMs === null) firstTextMs = Math.round(performance.now() - started);
    });
  } finally { clearTimeout(timer); }
  await repository.recoverExpiredRuns(ownerId, thread.id);
  const run = await repository.getLatestRun(ownerId, thread.id, branch.id);
  const progress = await learning.read({ ownerId, lessonFileId: file.id });
  const noChange = events.some((event) => event.type === "tool.completed" && event.name === "complete_without_change" && event.ok);
  const ownProposal = progress.inquiries.find((item) => item.sourceRunId === run?.id || item.proposedReview?.sourceRunId === run?.id);
  const response = run?.assistantMessageId ? (await repository.getMessage(ownerId, run.assistantMessageId))?.content ?? "" : "";
  const assistantResponse = ownProposal?.proposedReview ? ["待教师审议", ownProposal.proposedReview.outcome, ownProposal.proposedReview.rationale, `限制：${ownProposal.proposedReview.limitations}`].join("\n\n")
    : ownProposal ? [["主要解释", ownProposal.hypothesis], ["替代解释", ownProposal.alternativeExplanation], ["教学调整", ownProposal.intervention],
      ["预期信号", ownProposal.expectedSignal], ["复测办法", ownProposal.checkPlan]].map(([label, value]) => `${label}：${value}`).join("\n\n") : response;
  results.push({ id: testCase.id, fixture: "synthetic_isolated_memory", passed: run?.status === "completed" &&
    (testCase.id === "grounded_no_change" ? noChange : testCase.id === "learning_review"
      ? ownProposal?.state === "implemented" && Boolean(ownProposal.proposedReview) && !ownProposal.review
      : ownProposal?.state === "proposed" && !ownProposal.implementedAt)
    && !events.some((event) => event.type === "approval.required")
    && (await repository.getLessonFile(ownerId, file.id))?.documentVersion === 0,
    status: run?.status, error: run?.error, durationMs: Math.round(performance.now() - started), firstTextMs, tokenUsage: run?.tokenUsage,
    tools: events.filter((event) => event.type === "tool.completed").map((event) => ({ name: event.name, ok: event.ok })),
    documentVersion: (await repository.getLessonFile(ownerId, file.id))?.documentVersion,
    proposal: ownProposal ? { hypothesis: ownProposal.hypothesis, alternativeExplanation: ownProposal.alternativeExplanation,
      intervention: ownProposal.intervention, expectedSignal: ownProposal.expectedSignal, checkPlan: ownProposal.checkPlan, state: ownProposal.state,
      proposedReview: ownProposal.proposedReview } : null,
    response, assistantResponse, reviewMaterial,
  });
  console.log(JSON.stringify({ id: testCase.id, passed: results.at(-1)!.passed, durationMs: results.at(-1)!.durationMs }));
  if (testCase.id === "learning_proposal" && ownProposal && run?.status === "completed") {
    await learning.act({ ownerId, lessonFileId: file.id }, ownProposal.id, { action: "adopt", expectedVersion: 0 }, "synthetic-adopt");
    const implemented = await learning.act({ ownerId, lessonFileId: file.id }, ownProposal.id, { action: "implement", expectedVersion: 1 }, "synthetic-implement");
    const followup = await learning.recordEvidence({ ownerId, lessonFileId: file.id }, {
      ...baselineInput, documentVersion: 0, inquiryId: ownProposal.id, observedAt: new Date().toISOString(),
      observation: "合成后测：同一12份匿名样本中8份能独立用位置关系解释新的一组负数比较。任务熟悉度与提示可能影响结果。", meetingCriterion: 8,
      sourceReference: "隔离评测合成后测，不代表真实课堂",
    }, "synthetic-followup");
    cases.push({ id: "learning_review", prompt: "这是隔离合成复测。请核对所选方案、真实记录的合成基线和后测，检查目标、判据与群体可比性，提出待教师审议的建议。说明替代解释与限制，不把4/12到8/12的变化当作因果证明，不替教师确认效果。",
      taskIntent: { type: "learning_review", inquiryId: ownProposal.id, evidenceId: followup.id, expectedVersion: implemented.version } });
  }
}
const directory = process.env.LESSONUP_EVAL_OUTPUT_DIR ?? path.join(tmpdir(), "lessonup-evals", "native-learning");
await mkdir(directory, { recursive: true });
const report = `${JSON.stringify({ thinkingLevel, results, boundary: "Live configured model and native Pi with isolated synthetic data; not evidence of classroom effectiveness or expert accreditation." }, null, 2)}\n`;
await writeFile(path.join(directory, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), report);
await writeFile(path.join(directory, "latest.json"), report);
if (results.some((result) => !result.passed)) process.exitCode = 1;
