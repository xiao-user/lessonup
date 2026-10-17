import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, openLessonFile, sendPrompt, test } from "./fixtures.js";
import { lessonFileId } from "./test-data.js";
import { gradeFrontendPerformance, resolveFrontendPerformanceBudget } from "../../evals/performance.js";

const performanceBudget = resolveFrontendPerformanceBudget(process.env);

async function sampleStart(page: Page) {
  await page.evaluate(() => {
    const data = { longTasks: [] as number[], frames: [] as number[], stopped: false };
    const observer = new PerformanceObserver((list) => data.longTasks.push(...list.getEntries().map((item) => item.duration)));
    observer.observe({ type: "longtask" });
    let previous = performance.now();
    const frame = (now: number) => { if (data.stopped) return; data.frames.push(now - previous); previous = now; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    Object.assign(window, { lessonupPerfSample: { data, observer } });
  });
}

async function sampleEnd(page: Page) {
  return page.evaluate(() => {
    const { data, observer } = (window as any).lessonupPerfSample;
    data.stopped = true; observer.disconnect();
    const frames = data.frames.toSorted((a: number, b: number) => a - b);
    return { longTasks: data.longTasks, blockingTimeMs: data.longTasks.reduce((sum: number, value: number) => sum + value - 50, 0),
      frameGapP95Ms: frames[Math.floor(frames.length * 0.95)] ?? null, maximumFrameGapMs: frames.at(-1) ?? null };
  });
}

const longProcess = Array.from({ length: 35 }, (_, index) => [
  `## 活动${index + 1}：观察、比较与独立解释`,
  "- 学生阅读两份不同的解释，圈画=={pink}关键证据==，说明证据与判断的联系。",
  "- 教师检查独立作答，比较概念理解、先备知识与表达负担三种解释，保留反例。",
  "- 学生使用新的材料独立解释，小组讨论不会代替每个人的独立评价证据。",
].join("\n")).join("\n\n");

test("long A4 streaming stays isolated, accepts input and preserves measured breaks after adoption", async ({ lessonPage: page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const file = await page.request.get(`/api/lesson-files/${lessonFileId}`).then((r) => r.json());
  const saved = await page.request.patch(`/api/lesson-files/${lessonFileId}/document`, {
    headers: { "idempotency-key": crypto.randomUUID() }, data: { baseVersion: file.documentVersion,
      document: { ...file.document, process: longProcess }, pageCount: 10, source: "manual" },
  });
  expect(saved.ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.getByRole("button", { name: "新增备课本", exact: true })).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await sampleStart(page);
  const opened = performance.now();
  await openLessonFile(page);
  await expect(page.getByLabel("向备课助手提问")).toBeEnabled();
  await expect(page).toHaveTitle(/LessonUp/);
  await expect(page).toHaveURL(new RegExp(`/lesson-files/${lessonFileId}$`));
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const openMs = performance.now() - opened;
  const opening = await sampleEnd(page);
  const pages = page.locator(".lesson-document-pages:visible .lesson-sheet-slot");
  expect(await pages.count()).toBeGreaterThan(5);
  if (process.env.LESSONUP_PERF_PROFILE === "1") { await cdp.send("Profiler.enable"); await cdp.send("Profiler.start"); }
  await sampleStart(page);
  await sendPrompt(page, "长教案流式提交修改");
  await expect(page.getByText("正在生成草稿…", { exact: true })).toBeVisible();
  const composer = page.getByLabel("向备课助手提问");
  const typingStart = performance.now();
  await composer.fill("继续保留这段未发送输入");
  await expect(composer).toHaveValue("继续保留这段未发送输入");
  const inputMs = performance.now() - typingStart;
  await expect(page.getByRole("button", { name: "采用修改", exact: true })).toBeEnabled({ timeout: 60_000 });
  const streaming = await sampleEnd(page);
  if (process.env.LESSONUP_PERF_PROFILE === "1") {
    const { profile } = await cdp.send("Profiler.stop");
    await writeFile(testInfo.outputPath("streaming.cpuprofile"), JSON.stringify(profile));
  }
  const before = await page.request.get(`/api/lesson-files/${lessonFileId}`).then((r) => r.json());
  expect(before.document.process).toBe(longProcess);
  const breaks = await pages.evaluateAll((slots) => slots.map((slot) => [...slot.querySelectorAll('[data-lesson-section="process"] .lesson-tiptap-field')].map((field) => field.textContent).join("")));
  await page.screenshot({ path: testInfo.outputPath("long-stream-desktop.png") });
  await page.getByRole("button", { name: "采用修改", exact: true }).click();
  await expect(page.getByText("修改已写入教案", { exact: true })).toBeVisible();
  await expect.poll(() => pages.evaluateAll((slots) => slots.map((slot) => [...slot.querySelectorAll('[data-lesson-section="process"] .lesson-tiptap-field')].map((field) => field.textContent).join("")))).toEqual(breaks);
  await expect(composer).toHaveValue("继续保留这段未发送输入");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".lesson-document-scroll")).toBeVisible();
  await expect(page.locator("#lesson-assistant-panel")).toBeHidden();
  await expect(page.locator("#lesson-outline-panel")).toBeHidden();
  expect(await page.locator(".lesson-document-scroll").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(391);
  await page.screenshot({ path: testInfo.outputPath("long-adopted-mobile.png") });
  expect(errors).toEqual([]);
  await writeFile(testInfo.outputPath("performance.json"), JSON.stringify({ cpuSlowdown: 4, characters: longProcess.length,
    pages: breaks.length, openMs, inputMs, opening, streaming, performanceBudget,
    boundary: "Synthetic transport and local headless Chromium with 4x CPU slowdown. Model latency and classroom validity are separate." }, null, 2));
  await cdp.detach();
  expect(gradeFrontendPerformance({ inputMs, streaming }, performanceBudget)).toEqual([]);
});

test("cancels a long streaming draft without an adoptable result, write or resend after reload", async ({ lessonPage: page }, testInfo) => {
  const file = await page.request.get(`/api/lesson-files/${lessonFileId}`).then((r) => r.json());
  await page.request.patch(`/api/lesson-files/${lessonFileId}/document`, {
    headers: { "idempotency-key": crypto.randomUUID() }, data: { baseVersion: file.documentVersion,
      document: { ...file.document, process: longProcess }, pageCount: 7, source: "manual" },
  });
  await page.reload(); await openLessonFile(page);
  let requests = 0;
  page.on("request", (request) => { if (/\/api\/agent\/threads\/[^/]+\/runs$/.test(new URL(request.url()).pathname) && request.method() === "POST") requests += 1; });
  await sendPrompt(page, "长教案流式提交修改");
  await expect(page.getByText("正在生成草稿…", { exact: true })).toBeVisible();
  const stopped = performance.now();
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(page.getByLabel("A4 草稿操作")).toHaveCount(0);
  await expect(page.getByLabel("向备课助手提问")).toBeEnabled();
  const cancellationMs = performance.now() - stopped;
  const after = await page.request.get(`/api/lesson-files/${lessonFileId}`).then((r) => r.json());
  expect(after.document.process).toBe(longProcess);
  await page.reload(); await openLessonFile(page);
  await expect(page.getByLabel("向备课助手提问")).toBeEnabled();
  await expect(page.getByLabel("A4 草稿操作")).toHaveCount(0);
  expect(requests).toBe(1);
  await writeFile(testInfo.outputPath("cancellation.json"), JSON.stringify({ cancellationMs, requests, boundary: "Deterministic browser transport; native cancellation is independently tested in coordinator.integration.test.ts." }, null, 2));
});
