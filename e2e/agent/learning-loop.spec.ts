import { test, expect } from "./fixtures.js";
import { lessonFileId } from "./test-data.js";
import { writeFile } from "node:fs/promises";

const localTime = () => {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23).replace(/0+$/, "").replace(/\.$/, "").replace(/:00$/, "");
};

test("records evidence, adopts and implements a plan, then reviews actual follow-up evidence", async ({ lessonPage: page }, testInfo) => {
  await page.getByRole("tab", { name: "学习验证", exact: true }).click();
  const workbench = page.getByRole("region", { name: "学习验证", exact: true });
  await workbench.getByRole("button", { name: "记录学习证据", exact: true }).click();
  await workbench.getByLabel("本次学习目标", { exact: true }).fill("用具体词句解释春日意象");
  await workbench.getByLabel("学生完成的任务", { exact: true }).fill("独立选择一处词句并写出解释");
  await workbench.getByLabel("成功判据", { exact: true }).fill("解释词句与意象之间的联系");
  await workbench.getByLabel("实际观察", { exact: true }).fill("学生能找词句，但多数解释只复述句意");
  await workbench.getByLabel("证据来源与定位", { exact: true }).fill("第一课时出口条汇总");
  await workbench.getByLabel("取证条件", { exact: true }).fill("同一任务、同一出口条判据、独立完成、无提示");
  await workbench.getByRole("button", { name: "保存证据", exact: true }).click();
  await expect(workbench.getByText("学生能找词句，但多数解释只复述句意", { exact: false })).toBeVisible();
  await workbench.getByRole("button", { name: "自行记录方案", exact: true }).click();
  for (const [label, value] of [
    ["主要解释（待检验）", "可能未理解词句与意象之间的联系"], ["另一种可能解释", "也可能书面表达负担较大"],
    ["准备怎样调整", "先口头比较两种解释，再独立写一句联系"], ["预期看到的信号", "学生能独立说明词句的作用"],
    ["后续怎样检查", "使用同一成功判据比较第二次独立作答"],
  ]) await workbench.getByLabel(label, { exact: true }).fill(value);
  await workbench.getByRole("button", { name: "保存待采用方案", exact: true }).click();
  await workbench.getByRole("button", { name: "采用方案", exact: true }).click();
  await expect(workbench.getByText("已采用，待实施", { exact: true })).toBeVisible();
  await workbench.getByRole("button", { name: "确认已经实施", exact: true }).click();
  await expect(workbench.getByText("已实施，待复测", { exact: true })).toBeVisible();
  await workbench.getByRole("button", { name: "记录复测", exact: true }).click();
  await workbench.getByLabel("学生完成的任务", { exact: true }).fill("独立解释另一处词句的作用");
  await workbench.getByLabel("实际观察", { exact: true }).fill("更多学生能解释词句与意象的联系，仍有几份只复述句意");
  await workbench.getByLabel("证据来源与定位", { exact: true }).fill("第二次独立解释卡汇总");
  await workbench.getByLabel("取证条件", { exact: true }).fill("同一任务、同一出口条判据、独立完成、无提示");
  await workbench.getByLabel("观察时间", { exact: true }).fill(localTime());
  await workbench.getByRole("button", { name: "保存证据", exact: true }).click();
  await workbench.getByRole("button", { name: "审议复测", exact: true }).click();
  await workbench.getByLabel("本次判断", { exact: true }).selectOption("supported");
  await workbench.getByLabel("判断依据", { exact: true }).fill("相同群体和判据下，独立解释出现增加");
  await workbench.getByLabel("证据限制与仍需检查的条件", { exact: true }).fill("熟悉任务和口头提示也可能影响表现，需要延迟检查");
  await workbench.getByRole("button", { name: "确认复测判断", exact: true }).click();
  await expect(workbench.getByText("已审议", { exact: true })).toBeVisible();
  await expect(workbench.getByText("符合预期", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("learning-review.png"), fullPage: false });
  await page.reload();
  await page.getByRole("tab", { name: "学习验证", exact: true }).click();
  await expect(page.getByRole("region", { name: "学习验证", exact: true }).getByText("已审议", { exact: true })).toBeVisible();
  await workbench.getByRole("button", { name: "以复测继续改进", exact: true }).click();
  await expect(workbench.getByRole("status")).toContainText("已选中本次复测证据");
  await expect(workbench.getByLabel("基线证据", { exact: true }).locator("option:checked")).toHaveText(/^复测/);
});

test("recovers a committed evidence save after a lost response without creating a duplicate", async ({ lessonPage: page }) => {
  await page.getByRole("tab", { name: "学习验证", exact: true }).click();
  const panel = page.getByRole("region", { name: "学习验证", exact: true });
  let posts = 0;
  await page.route(`**/api/lesson-files/${lessonFileId}/learning/evidence`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    posts += 1; await route.fetch(); await route.abort("failed");
  });
  await panel.getByRole("button", { name: "记录学习证据", exact: true }).click();
  for (const [label, value] of [["学生完成的任务", "独立解释词句"], ["成功判据", "能说清作用"], ["实际观察", "多数学生能解释一处词句"], ["证据来源与定位", "课堂记录汇总"]]) {
    await panel.getByLabel(label, { exact: true }).fill(value);
  }
  await panel.getByRole("button", { name: "保存证据", exact: true }).click();
  await expect(panel.getByRole("button", { name: "保存证据", exact: true })).toHaveCount(0);
  await expect(panel.getByText("多数学生能解释一处词句", { exact: false })).toBeVisible();
  expect(posts).toBe(1);
  const progress = await page.request.get(`/api/lesson-files/${lessonFileId}/learning`).then((response) => response.json());
  expect(progress.evidence).toHaveLength(1);
});

test("locks an uncertain write and retries the original command", async ({ lessonPage: page }) => {
  await page.getByRole("tab", { name: "学习验证", exact: true }).click();
  const panel = page.getByRole("region", { name: "学习验证", exact: true });
  const keys: string[] = [];
  await page.route(`**/api/lesson-files/${lessonFileId}/learning/evidence`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    keys.push(route.request().headers()["idempotency-key"]!);
    const response = await route.fetch();
    if (keys.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await page.route(`**/api/lesson-files/${lessonFileId}/learning/commands/**`, (route) => route.abort("failed"));
  await panel.getByRole("button", { name: "记录学习证据", exact: true }).click();
  for (const [label, value] of [["学生完成的任务", "独立解释词句"], ["成功判据", "能说清作用"], ["实际观察", "能解释一处词句"], ["证据来源与定位", "课堂汇总"]]) {
    await panel.getByLabel(label, { exact: true }).fill(value);
  }
  await panel.getByRole("button", { name: "保存证据", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("保存结果尚未确认");
  await expect(panel.getByRole("button", { name: "保存证据", exact: true })).toBeDisabled();
  await expect(panel.getByLabel("实际观察", { exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "重试同次保存", exact: true }).click();
  await expect(panel.getByRole("button", { name: "保存证据", exact: true })).toHaveCount(0);
  expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(1);
  const progress = await page.request.get(`/api/lesson-files/${lessonFileId}/learning`).then((response) => response.json());
  expect(progress.evidence).toHaveLength(1);
});

test("starts the assistant with a bound learning intent and flushes pending editor changes", async ({ lessonPage: page }) => {
  const evidence = await page.request.post(`/api/lesson-files/${lessonFileId}/learning/evidence`, {
    headers: { "idempotency-key": crypto.randomUUID() }, data: {
      documentVersion: 0, objective: "用具体词句解释意象", task: "独立解释词句", criterion: "说明词句的作用", learnerGroup: "一班",
      observation: "只能复述句意", method: "student_work", observedAt: new Date().toISOString(), sourceReference: "解释卡汇总",
    },
  }).then((response) => response.json());
  const edit = page.locator('.lesson-tiptap-field[contenteditable="true"][aria-label="评价练习"]:visible').first();
  await edit.fill("独立选择另一处词句并解释作用");
  await page.getByRole("tab", { name: "学习验证", exact: true }).click();
  await page.route("**/api/agent/threads/*/runs", (route) => route.abort("failed"));
  const request = page.waitForRequest((item) => /\/api\/agent\/threads\/[^/]+\/runs$/.test(item.url()) && item.method() === "POST");
  await page.getByRole("button", { name: "请助手提出改进方案", exact: true }).click();
  const input = (await request).postDataJSON();
  expect(input.taskIntent).toEqual({ type: "learning_inquiry", evidenceId: evidence.id });
  const file = await page.request.get(`/api/lesson-files/${lessonFileId}`).then((response) => response.json());
  expect(file.document.assessment).toBe("独立选择另一处词句并解释作用");
  expect(input.documentVersion).toBe(file.documentVersion);
});

test("does not continuously poll idle presentation material", async ({ lessonPage: page }, testInfo) => {
  let reads = 0;
  page.on("request", (request) => { if (request.method() === "GET" && /\/lesson-files\/[^/]+\/(?:presentations|presentation-generation)$/.test(new URL(request.url()).pathname)) reads += 1; });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const metrics = { longTasks: [] as number[], frameGaps: [] as number[], stopped: false };
    const observer = new PerformanceObserver((list) => metrics.longTasks.push(...list.getEntries().map((entry) => entry.duration)));
    observer.observe({ type: "longtask" });
    let previous = performance.now();
    const frame = (now: number) => { if (metrics.stopped) return; metrics.frameGaps.push(now - previous); previous = now; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    Object.assign(window, { lessonupQaMetrics: metrics, lessonupQaObserver: observer });
  });
  await page.waitForTimeout(4_500);
  expect(reads).toBeLessThanOrEqual(2);
  const metrics = await page.evaluate(() => {
    const { lessonupQaMetrics: data, lessonupQaObserver: observer } = window as unknown as {
      lessonupQaMetrics: { longTasks: number[]; frameGaps: number[]; stopped: boolean }; lessonupQaObserver: PerformanceObserver;
    };
    data.stopped = true; observer.disconnect();
    const sorted = data.frameGaps.slice().sort((a, b) => a - b);
    return { longTasks: data.longTasks, frameGapP95Ms: sorted[Math.floor(sorted.length * 0.95)], frames: sorted.length };
  });
  await writeFile(testInfo.outputPath("idle-performance.json"), JSON.stringify({ ...metrics, presentationReads: reads, boundary: "Local headless production-preview idle observation; not a streaming or device-wide frame-rate guarantee." }, null, 2));
});
