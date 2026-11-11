import { expect, test } from "./fixtures.js";
import { lessonFileId } from "./test-data.js";

test("teacher marker selection is saved as Markdown and restored on the A4 page", async ({ lessonPage: page }) => {
  const assessment = page.locator('.lesson-tiptap-field[aria-label="评价练习"]:visible').first();
  await assessment.click();
  await assessment.press("ControlOrMeta+A");

  const toolbar = page.getByRole("toolbar", { name: "标记选中文字" });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "粉色荧光" }).click();
  await expect(assessment.locator('mark[data-tone="pink"]')).toBeVisible();
  await assessment.blur();
  await expect(page.locator(".lesson-save-status")).toContainText("已自动保存");
  await expect.poll(async () => {
    const response = await page.request.get(`/api/lesson-files/${lessonFileId}`);
    return (await response.json()).document.assessment;
  }).toContain("=={pink}");

  await page.reload();
  await expect(page.locator('.lesson-tiptap-field[aria-label="评价练习"]:visible mark[data-tone="pink"]').first()).toBeVisible();
});

test("structured teaching-process Markdown renders as readable A4 hierarchy", async ({ lessonPage: page }) => {
  const file = await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json();
  const source = "## 探究新知\n\n教师提出问题，学生圈画=={pink}关键证据==，并用=={blue}自己的话解释==。\n\n### 小组比较\n\n- 说明=={green}(3+2)+1=5+1==成立的条件。\n- 标记=={red}常见误区==并讨论修正。";
  const saved = await page.request.patch(`/api/lesson-files/${lessonFileId}/document`, {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: { baseVersion: file.documentVersion, document: { ...file.document, process: source }, pageCount: 1, source: "manual" },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.reload();
  const process = page.locator('.lesson-tiptap-field[aria-label="教学过程"]:visible').first();

  await expect(process.locator("h2")).toHaveText("探究新知");
  await expect(process.locator("h3")).toHaveText("小组比较");
  await expect(process.locator("li")).toHaveCount(2);
  for (const tone of ["pink", "blue", "green", "red"]) {
    await expect(process.locator(`mark[data-tone="${tone}"]`)).toBeVisible();
  }
  await expect(process.locator('mark[data-tone="green"]')).toHaveText("(3+2)+1=5+1");
  await process.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/lessonup-a4-markdown-markers.png" });
});
