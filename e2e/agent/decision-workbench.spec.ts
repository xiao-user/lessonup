import { expect, test } from "./fixtures.js";
import { lessonFileId } from "./test-data.js";

const evidenceCard = {
  kind: "curriculum_standard",
  level: "primary",
  source: {
    system: "curriculum_standards",
    uri: "d1://curriculum_standards/e2e",
    locator: "第三学段·阅读与鉴赏·第3条",
    version: "2022",
    capturedAt: "2026-10-18T00:00:00Z",
  },
  excerpt: "体会其表达效果。",
  claim: "目标应指向解释与表达效果。",
  supports: ["opt_b"],
  applicability: "第三学段阅读教学。",
  limitations: ["课标不规定具体活动。"],
  conflictsWith: [],
  confidence: 0.95,
  expiresAt: null,
  piiLevel: "none",
};

test("records a decision, its evidence and a post-implementation review", async ({ lessonPage: page }) => {
  const created = await page.request.post(`/api/lesson-files/${lessonFileId}/decisions`, {
    headers: { "idempotency-key": `decision-review-${Date.now()}` },
    data: {
      contextVersion: { documentVersion: 0, frameworkVersion: null },
      decisionType: "goal_evidence",
      question: "本课‘体会反复’的达成证据应该是什么？",
      options: [
        { id: "opt_a", statement: "出口条复述反复的作用", tradeoffs: ["易评分", "不能区分复述与理解"] },
        { id: "opt_b", statement: "无提示新段落中解释反复效果", tradeoffs: ["更接近迁移", "评分成本更高"] },
      ],
      chosenOptionId: "opt_b",
      rationale: "目标指向理解而非术语记忆。",
      counterevidence: ["上次出口条显示多数学生只能复述。"],
      assumptions: ["学生已能找出重复词句。"],
      uncertainties: ["新段落难度可能增加负担。"],
      confidence: 0.72,
      expectedSignal: "独立解释比例上升。",
      falsifier: "若新段落独立解释比例未上升，则本决策不成立。",
      reviewAt: null,
      evidenceCards: [evidenceCard],
      status: "proposed",
      createdBy: "teacher",
    },
  });
  expect(created.ok()).toBeTruthy();

  await page.getByRole("tab", { name: "教学决策" }).click();
  await expect(page.getByText("本课‘体会反复’的达成证据应该是什么？").first()).toBeVisible();
  await page.getByText("目标应指向解释与表达效果。").click();
  await expect(page.getByText("第三学段·阅读与鉴赏·第3条")).toBeVisible();

  await page.getByRole("button", { name: "确认采用", exact: true }).click();
  await page.getByLabel("置信度 0–1").fill("0.8");
  await page.getByRole("button", { name: "保存确认", exact: true }).click();
  await expect(page.getByText("已确认", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("状态：待确认 → 已确认")).toBeVisible();

  await page.getByRole("button", { name: "登记实施", exact: true }).click();
  await page.getByLabel("实施时间").fill("2026-10-18T00:30");
  await page.getByRole("button", { name: "保存实施登记", exact: true }).click();
  await expect(page.getByText("已实施", { exact: false }).first()).toBeVisible();

  const evidence = await page.request.post(`/api/lesson-files/${lessonFileId}/learning/evidence`, {
    headers: { "idempotency-key": `decision-evidence-${Date.now()}` },
    data: {
      documentVersion: 0,
      objective: "体会反复的表达效果",
      task: "在无提示新段落中解释反复效果",
      criterion: "能说出强调与情感之间的关系",
      learnerGroup: "五年级 2 班",
      observation: "30 人中 18 人能独立解释，其余需要提示。",
      method: "student_work",
      observedAt: "2026-10-17T17:00:00Z",
      sourceReference: "第二课时出口条",
    },
  });
  expect(evidence.ok()).toBeTruthy();
  const evidenceRecord = await evidence.json();

  await page.getByRole("button", { name: "记录审议", exact: true }).click();
  await page.getByLabel("复测证据").selectOption(evidenceRecord.id);
  await page.getByLabel("依据").fill("独立解释比例上升，但单班且未做延迟复测。");
  await page.getByLabel("限制").fill("单班、无延迟复测");
  await page.getByRole("button", { name: "保存审议", exact: true }).click();
  await expect(page.getByText("已审议", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("符合预期", { exact: false }).first()).toBeVisible();

  await expect.poll(async () => {
    const response = await page.request.get(`/api/lesson-files/${lessonFileId}/decisions/events`);
    if (!response.ok()) return [];
    return (await response.json()).events.map((event: { type: string }) => event.type);
  }).toEqual(expect.arrayContaining([
    "decision_viewed", "evidence_opened", "decision_confirmed", "implementation_recorded", "review_recorded",
  ]));
});
