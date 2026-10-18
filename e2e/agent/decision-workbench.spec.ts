import { expect, test } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { lessonFileId } from "./test-data.js";

const plan = {
  kind: "design_check", objective: "目标与评价任务对齐", task: "核对独立解释任务及其评分判据", criterion: "评价任务要求独立解释，评分依据具体词句与表达效果的联系",
  learnerGroup: "当前课时教案", method: "document_check", conditions: "核对当前教案原文", baselineEvidenceId: null,
};
const evidenceCard = {
  kind: "curriculum_standard", level: "primary", source: { system: "curriculum_standards", uri: "d1://curriculum_standards/e2e", locator: "第三学段·阅读与鉴赏·第3条", version: "2022", capturedAt: "2026-10-18T00:00:00Z" },
  excerpt: "体会其表达效果。", claim: "目标应指向解释与表达效果。", supports: ["opt_b"], applicability: "第三学段阅读教学。", limitations: ["课标不规定具体活动。"], conflictsWith: [], confidence: 0.95, expiresAt: null, piiLevel: "none",
};
async function fillTeacherDraft(page: Page) {
  await page.getByRole("button", { name: "记录已有判断", exact: true }).click();
  const form = page.getByRole("form", { name: "教师记录判断" });
  await form.getByLabel("判断类型", { exact: true }).selectOption("assessment");
  await form.getByLabel("需要决定的问题", { exact: true }).fill("怎样核对出口条是否覆盖解释目标？");
  await form.getByLabel("方案 1", { exact: true }).fill("增加独立解释题和对应评分判据");
  await form.getByLabel("方案 1 的取舍（每行一项）", { exact: true }).fill("覆盖核心目标\n需要核对作答时间");
  await form.getByLabel("方案 2", { exact: true }).fill("保留现稿，先核对现有过程评价记录");
  await form.getByLabel("方案 2 的取舍（每行一项）", { exact: true }).fill("改动较少\n依据可能仍不足");
  await form.getByLabel("我的判断理由", { exact: true }).fill("先核对评价覆盖，再判断是否需要修改教案。");
  await form.getByLabel("判断前提（每行一项）", { exact: true }).fill("本课目标仍为独立解释\n过程评价可作为原文依据");
  return form;
}

test("makes assumptions inspectable and records directly linked design evidence", async ({ lessonPage: page }) => {
  const created = await page.request.post(`/api/lesson-files/${lessonFileId}/decisions`, {
    headers: { "idempotency-key": `decision-review-${Date.now()}` }, data: {
      contextVersion: { documentVersion: 0, frameworkVersion: null }, decisionType: "goal_evidence", question: "本课‘体会反复’的达成证据应该是什么？",
      options: [{ id: "opt_a", statement: "出口条复述反复的作用", tradeoffs: ["易评分", "不能区分复述与理解"] }, { id: "opt_b", statement: "无提示新段落中解释反复效果", tradeoffs: ["更接近迁移", "评分成本更高"] }], chosenOptionId: "opt_b",
      rationale: "目标指向理解而非术语记忆。", counterevidence: ["过程评价可能已有独立解释的原文记录。"], assumptions: ["学生已能找出重复词句。", "本课保留独立解释的目标。", "出口条是正式取证任务。", "评分判据可由教师核对。"], uncertainties: ["新段落难度可能增加负担。"], confidence: 0.72,
      expectedSignal: "教案中的独立解释任务有对应评分判据。", falsifier: "若现有教案已有独立解释任务和相应评分记录，则评价未覆盖目标的判断不成立。", observationPlan: plan, reviewAt: null, evidenceCards: [evidenceCard], status: "proposed", createdBy: "teacher",
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy(); const decision = await created.json();
  await page.getByRole("tab", { name: "教学决策" }).click();
  const workbench = page.locator(".decision-workbench");
  await expect(workbench.getByText("本课‘体会反复’的达成证据应该是什么？", { exact: true })).toHaveCount(1);
  await expect(workbench.getByText("评分判据可由教师核对。", { exact: true })).toBeVisible();
  await expect(workbench.getByText("置信 72%", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: "/tmp/lessonup-task3-decision-summary.png", fullPage: true });
  await workbench.getByText("目标应指向解释与表达效果。", { exact: true }).click();
  await expect(workbench.getByText("curriculum_standards · 第三学段·阅读与鉴赏·第3条 · 版本 2022", { exact: true })).toBeVisible();
  await expect(workbench.getByText("相关性自评 95%", { exact: false })).toContainText("未校准");
  await workbench.getByRole("button", { name: "确认采用", exact: true }).click();
  await workbench.getByLabel("自评数值 0–1（可选，未校准）", { exact: true }).fill("0.8");
  await workbench.getByRole("button", { name: "保存确认", exact: true }).click();
  await expect(workbench.getByText("已确认 · v2", { exact: true })).toBeVisible();
  await workbench.getByRole("button", { name: "登记实施", exact: true }).click();
  await workbench.getByRole("button", { name: "保存实施登记", exact: true }).click();
  await expect(workbench.getByText("已实施 · v3", { exact: true })).toBeVisible();
  await workbench.getByRole("button", { name: "记录本次后续观察", exact: true }).click();
  const observationForm = workbench.getByRole("form", { name: "记录本次文档核对" });
  await expect(observationForm.getByLabel("核对任务", { exact: true })).toHaveValue(plan.task);
  await expect(observationForm.getByLabel("成功判据", { exact: true })).toHaveValue(plan.criterion);
  await expect(observationForm.getByLabel("观察人数", { exact: true })).toHaveCount(0);
  await observationForm.getByLabel("实际观察", { exact: true }).fill("验收用文档核对记录：评价任务的设计范围已检查，未据此判断学生效果。");
  await observationForm.getByLabel("证据来源与定位", { exact: true }).fill("验收课时教案·评价任务栏目");
  await observationForm.getByRole("button", { name: "保存证据", exact: true }).click();
  await expect(observationForm).toHaveCount(0);
  const evidenceResponse = await page.request.get(`/api/lesson-files/${lessonFileId}/learning?decisionId=${decision.id}`);
  const evidence = (await evidenceResponse.json()).evidence[0]; expect(evidence.decisionId).toBe(decision.id);
  await workbench.getByRole("button", { name: "记录审议", exact: true }).click();
  await workbench.getByLabel("本次关联复测证据", { exact: true }).selectOption(evidence.id);
  await workbench.getByLabel("审议结论", { exact: true }).selectOption("inconclusive");
  await workbench.getByLabel("依据", { exact: true }).fill("这是界面验收记录，尚不足以判断设计质量或学习改善。");
  await workbench.getByLabel("限制", { exact: true }).fill("未完成真实课堂与独立内容评审");
  await workbench.getByRole("button", { name: "保存审议", exact: true }).click();
  await expect(workbench.getByText("已审议 · v4", { exact: true })).toBeVisible();
  await expect(workbench.getByText("本次审议：证据不足。", { exact: false })).toBeVisible();
});

test("keeps a teacher draft across tabs and allows revising verified lesson evidence", async ({ lessonPage: page }) => {
  await page.getByRole("tab", { name: "教学决策" }).click();
  await fillTeacherDraft(page);
  await page.getByRole("tab", { name: "学习验证" }).click();
  await page.getByRole("tab", { name: "教学决策" }).click();
  const form = page.getByRole("form", { name: "教师记录判断" });
  await expect(form.getByLabel("需要决定的问题", { exact: true })).toHaveValue("怎样核对出口条是否覆盖解释目标？");
  await form.getByRole("button", { name: "保存判断草稿", exact: true }).click();
  await expect(page.getByText("草稿 · v1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "完善判断与依据", exact: true }).click();
  await form.getByText("补充依据与不确定性", { exact: true }).click();
  await form.getByLabel("引用本课栏目", { exact: true }).selectOption("topic");
  await expect(form.getByLabel("引用的教案原文", { exact: true })).toHaveValue("春日的第一声鸟鸣");
  await form.getByLabel("这段原文支持什么判断", { exact: true }).fill("核对的是当前课时而非另一份教案。");
  await form.getByText("取证计划与判断边界", { exact: true }).click();
  await form.getByRole("button", { name: "填写结构化取证计划", exact: true }).click();
  await form.getByLabel("检验类型", { exact: true }).selectOption("design_check");
  for (const [label, value] of [["核对目标", plan.objective], ["取证任务", plan.task], ["成功判据", plan.criterion], ["核对范围", plan.learnerGroup], ["取证条件", plan.conditions]]) await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByLabel("预期观察到什么", { exact: true }).fill("原文中的任务与评分判据覆盖目标。");
  await form.getByLabel("什么观察会使这项判断不成立", { exact: true }).fill("若过程评价已有相应独立产出与判据，则需重新判断。");
  await expect(form.getByLabel("自评数值 0–1（未校准，可留空）", { exact: true })).toHaveValue("");
  await form.getByRole("button", { name: "保存为待确认候选", exact: true }).click();
  await expect(page.getByText("待确认 · v2", { exact: true })).toBeVisible();
  await page.getByText("核对的是当前课时而非另一份教案。", { exact: true }).click();
  await expect(page.getByText("相关性未评分，请核对原文与适用范围。", { exact: true })).toBeVisible();
  const before = (await (await page.request.get(`/api/lesson-files/${lessonFileId}/decisions`)).json()).decisions[0];
  await page.getByRole("button", { name: "完善判断与依据", exact: true }).click();
  await form.getByLabel("我的判断理由", { exact: true }).fill("补充判断理由，但保留已核对的原文依据。");
  await form.getByRole("button", { name: "保存判断草稿", exact: true }).click();
  await expect(page.getByText("草稿 · v3", { exact: true })).toBeVisible();
  const draft = (await (await page.request.get(`/api/lesson-files/${lessonFileId}/decisions`)).json()).decisions[0];
  expect(draft.evidenceCardIds).toEqual(before.evidenceCardIds);
  await page.getByRole("button", { name: "完善判断与依据", exact: true }).click();
  await form.getByRole("button", { name: "保存为待确认候选", exact: true }).click();
  await expect(page.getByText("待确认 · v4", { exact: true })).toBeVisible();
  const proposed = (await (await page.request.get(`/api/lesson-files/${lessonFileId}/decisions`)).json()).decisions[0];
  expect(proposed.evidenceCardIds).toEqual(before.evidenceCardIds);
});

test("restores an uncertain save without automatically resending and retries the identical command", async ({ lessonPage: page }) => {
  const submissions: { key: string | undefined; input: unknown }[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === `/api/lesson-files/${lessonFileId}/decisions`) submissions.push({ key: request.headers()["idempotency-key"], input: request.postDataJSON() }); });
  const pattern = `**/api/lesson-files/${lessonFileId}/decisions`;
  await page.route(pattern, (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await page.getByRole("tab", { name: "教学决策" }).click();
  const form = await fillTeacherDraft(page);
  await form.getByRole("button", { name: "保存判断草稿", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试同次保存", exact: true })).toBeVisible();
  await expect(form.getByLabel("需要决定的问题", { exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "学习验证" }).click();
  await page.getByRole("tab", { name: "教学决策" }).click();
  await expect(page.getByRole("button", { name: "重试同次保存", exact: true })).toBeVisible();
  expect(submissions).toHaveLength(1);
  await page.unroute(pattern);
  await page.getByRole("button", { name: "重试同次保存", exact: true }).click();
  await expect(page.getByText("草稿 · v1", { exact: true })).toBeVisible();
  expect(submissions).toHaveLength(2); expect(submissions[1]).toEqual(submissions[0]);
  const result = await page.request.get(`/api/lesson-files/${lessonFileId}/decisions`);
  expect((await result.json()).decisions).toHaveLength(1);
});
