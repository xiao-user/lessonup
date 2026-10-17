import { expect, test } from "./fixtures.js";
import { lessonFileId } from "./test-data.js";

test.use({ reducedMotion: "no-preference" });

test("navigation remains bounded with motion enabled and a slower CPU", async ({ collectionPage: page }, testInfo) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const samples: Record<string, unknown> = {};
  const measure = async (name: string, action: () => Promise<void>, ready: () => Promise<void>) => {
    await page.evaluate(() => {
      const probe = { start: 0, previous: 0, frames: [] as number[], blocking: 0, observer: null as PerformanceObserver | null, frame: 0 };
      (window as any).__navigationProbe = probe;
      document.addEventListener("click", () => {
        probe.start = performance.now();
        probe.previous = probe.start;
        probe.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) probe.blocking += Math.max(0, entry.duration - 50);
        });
        probe.observer.observe({ type: "longtask" });
        const tick = (now: number) => {
          probe.frames.push(now - probe.previous);
          probe.previous = now;
          probe.frame = requestAnimationFrame(tick);
        };
        probe.frame = requestAnimationFrame(tick);
      }, { once: true, capture: true });
    });
    await action();
    await ready();
    samples[name] = await page.evaluate(() => {
      const probe = (window as any).__navigationProbe;
      cancelAnimationFrame(probe.frame);
      probe.observer?.disconnect();
      return { elapsed: Math.round(performance.now() - probe.start), blocking: Math.round(probe.blocking), maxFrame: Math.round(Math.max(0, ...probe.frames)) };
    });
  };
  await measure("openNotebook", () => page.getByRole("button", { name: "打开语文备课本", exact: true }).click(), async () => {
    await expect(page.locator(".book-volume.is-open")).not.toHaveClass(/is-animating/);
    await expect(page.getByRole("button", { name: "打开备课文件春日的第一声鸟鸣", exact: true })).toHaveAttribute("tabindex", "0");
  });
  await page.screenshot({ path: testInfo.outputPath("notebook.png") });
  await measure("openDetail", () => page.getByRole("button", { name: "打开备课文件春日的第一声鸟鸣", exact: true }).click(), async () => {
    await expect(page.locator(".lesson-file-workspace")).toBeVisible();
    await expect(page.locator(".lesson-file-workspace")).toHaveCSS("opacity", "1");
    await expect(page.locator(".lesson-sheet-content").first()).toHaveCSS("opacity", "1");
    await expect(page.locator(".lesson-side-rail").last()).toHaveCSS("opacity", "1");
  });
  await page.screenshot({ path: testInfo.outputPath("detail.png") });
  // Returning from a scrolled document must not wait for a scroll-to-top movie.
  await page.locator(".lesson-document-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await measure("closeDetail", () => page.getByRole("button", { name: /返回备课本/ }).click(), async () => {
    await expect(page.locator(".lesson-file-workspace")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开备课文件春日的第一声鸟鸣", exact: true })).toBeFocused();
  });
  await measure("closeNotebook", () => page.getByRole("button", { name: "返回全部备课本", exact: true }).click(), async () => {
    await expect(page.locator(".book-volume.is-open")).toHaveCount(0);
  });
  console.log("Navigation measurements", JSON.stringify(samples));
  await testInfo.attach("navigation-measurements", { body: JSON.stringify(samples, null, 2), contentType: "application/json" });
  // Broad budgets include assertion polling/transport; the animation itself is shorter.
  expect((samples.openNotebook as { elapsed: number }).elapsed).toBeLessThan(900);
  expect((samples.closeNotebook as { elapsed: number }).elapsed).toBeLessThan(800);
  expect((samples.closeDetail as { elapsed: number }).elapsed).toBeLessThan(500);
  await cdp.detach();
});

test("return flushes the last edit and retains the editor when saving fails", async ({ lessonPage: page }) => {
  let failSave = true;
  await page.route(`**/api/lesson-files/${lessonFileId}/document`, async (route) => {
    if (route.request().method() === "PATCH" && failSave) {
      await route.fulfill({ status: 503, json: { error: "temporary_failure" } });
    } else await route.continue();
  });
  const assessment = page.locator('.lesson-tiptap-field[aria-label="评价练习"]:visible').first();
  await assessment.fill("导航保存验收：最后一次编辑不能丢失。");
  await page.goBack();
  await expect(page.locator(".lesson-save-status")).toContainText("保存失败");
  await expect(page.locator(".lesson-file-workspace")).toBeVisible();
  await expect(page).toHaveURL(`/lesson-files/${lessonFileId}`);
  failSave = false;
  await page.getByRole("button", { name: /返回备课本/ }).click();
  await expect(page.locator(".lesson-file-workspace")).toHaveCount(0);
  const saved = await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json();
  expect(saved.document.assessment).toContain("最后一次编辑不能丢失");
});

test("cancelled file loading cannot reopen the detail, and retry reads the canonical file", async ({ collectionPage: page }) => {
  await page.getByRole("button", { name: "打开语文备课本", exact: true }).click();
  const paper = page.getByRole("button", { name: "打开备课文件春日的第一声鸟鸣", exact: true });
  await expect(paper).toHaveAttribute("tabindex", "0");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let completed!: () => void;
  const responded = new Promise<void>((resolve) => { completed = resolve; });
  await page.route(`**/api/lesson-files/${lessonFileId}`, async (route) => {
    const response = await route.fetch();
    await pending;
    await route.fulfill({ response });
    completed();
  }, { times: 1 });
  try {
    await paper.click();
    await expect(page.getByRole("status").filter({ hasText: "正在打开教案" })).toBeVisible();
    await expect(paper).toHaveAttribute("aria-busy", "true");
    await page.getByRole("button", { name: "取消打开", exact: true }).click();
    await expect(paper).toBeFocused();
    release();
    await responded;
    // Let the released response reach React before asserting that it stays cancelled.
    await page.waitForTimeout(200);
    await expect(page.locator(".lesson-file-workspace")).toHaveCount(0);
    await expect(page).toHaveURL("/");
    await expect(paper).not.toHaveAttribute("aria-busy");
    await paper.press("Enter");
    await expect(page).toHaveURL(`/lesson-files/${lessonFileId}`);
    await expect(page.locator(".lesson-file-workspace")).toBeVisible();
    await page.goBack();
    await expect(page.locator(".lesson-file-workspace")).toHaveCount(0);
    await expect(paper).toBeFocused();
  } finally {
    release();
  }
});
