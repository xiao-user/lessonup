import { createThread, expect, openLessonFile, sendPrompt, test } from "./fixtures.js";
import { approvedObjective, initialObjective } from "./test-data.js";

const objectivesEditor = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "教学目标" }).first();

test("covers approval diff, refresh recovery, reject, approve, safe rebase and undo", async ({ lessonPage: page }) => {
  await sendPrompt(page, "请提交修改并展示 diff");
  const confirmation = page.getByRole("region", { name: "教案修改确认" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.locator("del")).toHaveText(initialObjective);
  await expect(confirmation.locator("ins")).toHaveText(approvedObjective);

  await page.reload();
  await openLessonFile(page);
  await expect(page.getByRole("region", { name: "教案修改确认" })).toBeVisible();
  await page.getByRole("button", { name: "拒绝" }).click();
  await expect(page.getByText("已保留原文", { exact: true })).toBeVisible();
  await expect(objectivesEditor(page)).toHaveValue(new RegExp(`^${initialObjective.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  await createThread(page);
  await sendPrompt(page, "请提交修改");
  await page.getByRole("button", { name: "接受修改" }).click();
  await expect(page.getByText("修改已写入，可通过教案撤销恢复", { exact: true })).toBeVisible();
  await expect(objectivesEditor(page)).toHaveValue(new RegExp(`^${approvedObjective.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await expect(page.getByRole("button", { name: "撤销" })).toBeEnabled();
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(objectivesEditor(page)).toHaveValue(new RegExp(`^${initialObjective.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();

  await createThread(page);
  await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
  await sendPrompt(page, "请提交修改以验证版本冲突");
  await expect(page.getByRole("region", { name: "教案修改确认" })).toBeVisible();
  await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
  const manualValue = `${initialObjective}（并发编辑）\n2. 在观察、比较与讨论中形成解决问题的方法。`;
  await objectivesEditor(page).fill(manualValue);
  await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
  await objectivesEditor(page).blur();
  await expect(page.getByText("已自动保存", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "接受修改" }).click();
  await expect(page.getByText("修改已写入，可通过教案撤销恢复", { exact: true })).toBeVisible();
  await expect(objectivesEditor(page)).toHaveValue(
    `${approvedObjective}（并发编辑）\n2. 在观察、比较与讨论中形成解决问题的方法。`,
  );
});

test("flushes a pending manual edit before starting a document-writing run", async ({ lessonPage: page }) => {
  const latestObjective = "1. 先观察春日声音，再用文本证据说明判断。";
  await objectivesEditor(page).fill(`${latestObjective}\n2. 在讨论中形成解释。`);

  await sendPrompt(page, "请提交修改");

  const confirmation = page.getByRole("region", { name: "教案修改确认" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.locator("del")).toHaveText(latestObjective);
});

test("flushes a pending edit before approval and safely preserves it", async ({ lessonPage: page }) => {
  await sendPrompt(page, "请提交修改");
  await expect(page.getByRole("region", { name: "教案修改确认" })).toBeVisible();

  const unsavedValue = `${initialObjective}（审批前继续编辑）\n2. 保留教师刚刚补充的内容。`;
  await objectivesEditor(page).fill(unsavedValue);
  await page.getByRole("button", { name: "接受修改" }).click();

  const mergedValue = `${approvedObjective}（审批前继续编辑）\n2. 保留教师刚刚补充的内容。`;
  await expect(page.getByText("修改已写入，可通过教案撤销恢复", { exact: true })).toBeVisible();
  await expect(objectivesEditor(page)).toHaveValue(mergedValue);
  await page.reload();
  await openLessonFile(page);
  await expect(objectivesEditor(page)).toHaveValue(mergedValue);
});

test("rejects a true conflict when the teacher changes the proposed target", async ({ lessonPage: page }) => {
  await sendPrompt(page, "请提交修改");
  await expect(page.getByRole("region", { name: "教案修改确认" })).toBeVisible();

  const teacherValue = "1. 教师已将本项目标改为观察声音线索。\n2. 保留教师自己的教学判断。";
  await objectivesEditor(page).fill(teacherValue);
  await page.getByRole("button", { name: "接受修改" }).click();

  await expect(page.getByRole("alert")).toContainText("教案内容已在其他会话或编辑器中更新");
  await expect(page.getByRole("button", { name: "基于最新内容重新生成" })).toBeVisible();
  await expect(objectivesEditor(page)).toHaveValue(teacherValue);
});

test("recovers a committed approval after continuation failure without applying the patch twice", async ({ lessonPage: page }) => {
  await sendPrompt(page, "请提交修改并验证续跑恢复");
  await page.getByRole("button", { name: "接受修改" }).click();

  await expect(page.getByText(
    "修改决定已经保存，但后续回复未能恢复。教案状态不会被重复写入。",
    { exact: true },
  )).toBeVisible();
  await expect(page.locator(".lesson-agent-error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "继续生成" })).toBeVisible();
  await expect(objectivesEditor(page)).toHaveValue(
    new RegExp(`^${approvedObjective.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );

  await page.reload();
  await openLessonFile(page);
  await expect(page.getByRole("button", { name: "继续生成" })).toBeVisible();
  await page.getByRole("button", { name: "继续生成" }).click();

  await expect(page.getByText("修改已按确认写入教案。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "继续生成" })).toHaveCount(0);
  await expect(objectivesEditor(page)).toHaveValue(
    new RegExp(`^${approvedObjective.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
});
