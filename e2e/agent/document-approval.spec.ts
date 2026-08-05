import { createThread, expect, openLessonFile, sendPrompt, test } from "./fixtures.js";
import { approvedObjective, initialObjective, lessonFileId } from "./test-data.js";

const objectivesEditor = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "教学目标" }).first();
const assessmentEditor = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "评价练习" }).first();

test("confirms one complete lesson change and writes basis plus A4 atomically", async ({ lessonPage: page }) => {
  await sendPrompt(page, "请提交完整备课调整");
  const confirmation = page.getByRole("region", { name: "教案修改确认" });
  await expect(confirmation).toBeVisible();
  await expect(page.getByText("完整备课调整等待确认", { exact: true })).toBeVisible();
  await expect(confirmation).toContainText("你只需确认一次");
  const overflow = await confirmation.evaluate((element) => {
    const card = element.getBoundingClientRect();
    return [...element.querySelectorAll("del, ins, details")].some((child) => {
      const box = child.getBoundingClientRect();
      return box.right > card.right + 0.5 || child.scrollWidth > child.clientWidth + 1;
    });
  });
  expect(overflow).toBe(false);
  await confirmation.getByText("查看调整理由", { exact: true }).click();
  await expect(confirmation).toContainText("学生可能只给出结论，不能说明判断依据");
  await expect(confirmation.locator("ins")).toContainText("要求学生说明判断所依据的文本证据");

  await page.getByRole("button", { name: "接受修改" }).click();
  await expect(page.getByText(
    "备课调整已完成；教案正文可通过撤销恢复",
    { exact: true },
  )).toBeVisible();
  await expect(assessmentEditor(page)).toHaveValue(/要求学生说明判断所依据的文本证据/);

  const basisResponse = await page.request.get(`/api/lesson-files/${lessonFileId}/design-basis`);
  expect(basisResponse.ok()).toBeTruthy();
  const basis = await basisResponse.json();
  expect(basis.basis.version).toBe(1);
  expect(basis.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      statement: "学生可能只给出结论，不能说明判断依据。",
      teacherConfirmed: true,
    }),
  ]));
});

test("rolls back a complete lesson change when the A4 target conflicts", async ({ lessonPage: page }) => {
  await sendPrompt(page, "请提交完整备课调整");
  await expect(page.getByRole("region", { name: "教案修改确认" })).toBeVisible();

  const teacherValue = "教师自行设计了新的测评任务，不采用原评价表述。";
  await assessmentEditor(page).fill(teacherValue);
  await page.getByRole("button", { name: "接受修改" }).click();

  await expect(page.getByRole("alert")).toContainText("教案内容已在其他会话或编辑器中更新");
  await expect(assessmentEditor(page)).toHaveValue(teacherValue);
  const basisResponse = await page.request.get(`/api/lesson-files/${lessonFileId}/design-basis`);
  expect(basisResponse.ok()).toBeTruthy();
  const basis = await basisResponse.json();
  expect(basis.basis.version).toBe(0);
  expect(basis.entries).toEqual([]);
});

test("shows and applies an explicit design-basis projection without changing the basis", async ({ lessonPage: page }) => {
  const basisResponse = await page.request.get(`/api/lesson-files/${lessonFileId}/design-basis`);
  expect(basisResponse.ok()).toBeTruthy();
  const basis = await basisResponse.json();
  const entryId = crypto.randomUUID();
  const statement = "学生可能只给出判断结论，不能说明所依据的文本证据。";
  const basisPatchResponse = await page.request.patch(
    `/api/lesson-files/${lessonFileId}/design-basis`,
    {
      headers: { "idempotency-key": `e2e-basis:${entryId}` },
      data: {
        basisId: basis.basis.id,
        baseBasisVersion: basis.basis.version,
        summary: "记录学生困难",
        operations: [{
          op: "create_design_basis_entry",
          entryId,
          sortNo: 1,
          kind: "student_difficulty",
          semanticEntityId: null,
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement,
          rationale: "评价环节需要追问理由。",
          evidence: [],
          decision: "accepted",
          teacherConfirmed: true,
          origin: "teacher",
        }],
      },
    },
  );
  expect(basisPatchResponse.ok()).toBeTruthy();

  await sendPrompt(page, "请提交设计依据投影");
  const confirmation = page.getByRole("region", { name: "教案修改确认" });
  await expect(confirmation).toBeVisible();
  await expect(page.getByText("设计依据投影等待确认", { exact: true })).toBeVisible();
  await expect(confirmation).toContainText("不建立自动同步");
  await confirmation.getByText("查看调整理由", { exact: true }).click();
  await expect(confirmation.getByText(statement, { exact: true })).toBeVisible();
  await expect(confirmation.locator("ins")).toContainText("要求学生说明判断所依据的文本证据");

  await page.getByRole("button", { name: "接受修改" }).click();
  await expect(page.getByText(
    "已写入 A4，可通过教案撤销；原设计依据保持不变",
    { exact: true },
  )).toBeVisible();
  await expect(assessmentEditor(page)).toHaveValue(/要求学生说明判断所依据的文本证据/);

  const finalBasisResponse = await page.request.get(`/api/lesson-files/${lessonFileId}/design-basis`);
  const finalBasis = await finalBasisResponse.json();
  expect(finalBasis.basis.version).toBe(1);
  expect(finalBasis.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: entryId, statement }),
  ]));
});

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

test("replays the same save transaction after a committed response is lost", async ({ lessonPage: page }) => {
  const requestKeys: string[] = [];
  let loseFirstResponse = true;
  await page.route(`**/api/lesson-files/${lessonFileId}/document`, async (route) => {
    requestKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (loseFirstResponse) {
      loseFirstResponse = false;
      await route.fetch();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  const firstEdit = `${initialObjective}（首次保存）`;
  await objectivesEditor(page).fill(firstEdit);
  await objectivesEditor(page).blur();
  await expect(page.getByText("保存失败", { exact: true })).toBeVisible();

  const secondEdit = `${initialObjective}（响应丢失后继续编辑）`;
  await objectivesEditor(page).fill(secondEdit);
  await objectivesEditor(page).blur();
  await expect(page.getByText("已自动保存", { exact: false })).toBeVisible();

  expect(requestKeys.length).toBeGreaterThanOrEqual(3);
  expect(requestKeys[0]).toBeTruthy();
  expect(requestKeys[1]).toBe(requestKeys[0]);
  expect(requestKeys[2]).not.toBe(requestKeys[0]);
  const canonical = await page.request.get(`/api/lesson-files/${lessonFileId}`);
  expect(canonical.ok()).toBeTruthy();
  expect((await canonical.json()).document.objectives).toBe(secondEdit);
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
