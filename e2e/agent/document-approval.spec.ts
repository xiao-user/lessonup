import { createThread, expect, openLessonFile, sendPrompt, test } from "./fixtures.js";
import { approvedObjective, initialObjective, lessonFileId } from "./test-data.js";

const fieldEditor = (page: import("@playwright/test").Page, label: string) => page
  .locator(`.lesson-tiptap-field[aria-label="${label}"]:visible`)
  .first();
const objectivesEditor = (page: import("@playwright/test").Page) => fieldEditor(page, "教学目标");
const assessmentEditor = (page: import("@playwright/test").Page) => fieldEditor(page, "评价练习");
const approvalCard = (page: import("@playwright/test").Page) => page
  .getByLabel("A4 草稿操作");
const approvalDiff = (page: import("@playwright/test").Page) => page
  .getByText("教案修改对比", { exact: true })
  .locator("xpath=../..");

test("pending A4 draft uses the same measured page breaks as the adopted document", async ({ lessonPage: page }) => {
  const file = await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json();
  const process = Array.from({ length: 8 }, (_, index) => [
    `## 活动${index + 1} · 观察、比较与说明`,
    "- 学生圈画=={pink}关键证据==，比较两种理解并记录理由。",
    "- 教师根据学生的解释追问依据，组织同伴补充和修正。",
    "- 小组用自己的话归纳判断方法，再用新材料检验。",
  ].join("\n")).join("\n\n");
  const saved = await page.request.patch(`/api/lesson-files/${lessonFileId}/document`, {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: { baseVersion: file.documentVersion, document: { ...file.document, process }, pageCount: 3, source: "manual" },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.reload();
  await openLessonFile(page);
  expect((await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json()).document.process).toBe(process);

  const processByPage = () => page.locator(".lesson-document-pages:visible .lesson-sheet-slot").evaluateAll((slots) => (
    slots.map((slot) => [...slot.querySelectorAll('[data-lesson-section="process"] .lesson-tiptap-field')]
      .map((field) => field.textContent).join(""))
  ));
  await sendPrompt(page, "请提交修改");
  await expect(page.getByRole("button", { name: "采用修改" })).toBeEnabled();
  expect((await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json()).document.process).toBe(process);
  const draftBreaks = await processByPage();
  expect(draftBreaks.filter(Boolean).length).toBeGreaterThan(1);

  await page.getByRole("button", { name: "采用修改" }).click();
  await expect(page.getByText("修改已写入教案", { exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json()).document.process).toBe(process);
  await expect.poll(processByPage).toEqual(draftBreaks);
});

test("streams an isolated A4 draft, keeps chat available, and recovers before adoption", async ({ lessonPage: page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", error => consoleErrors.push(error.message));
  await sendPrompt(page, "请提交修改");
  await expect(page.getByText("正在生成草稿…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "采用修改" })).toBeDisabled();
  await expect(objectivesEditor(page)).toHaveAttribute("contenteditable", "false");
  const canonicalBefore = await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json();
  expect(canonicalBefore.document.objectives).toContain(initialObjective);
  await expect(page.getByRole("button", { name: "采用修改" })).toBeEnabled();
  // Streaming can finish before this assertion runs. Assert the actual draft
  // instead of assuming the final text must be longer than an earlier frame.
  await expect(objectivesEditor(page)).toContainText(approvedObjective.replace(/^\d+\.\s*/, ""));
  await expect(page.getByLabel("向备课助手提问")).toBeEnabled();
  await page.screenshot({ path: "/tmp/lessonup-a4-draft-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#lesson-assistant-panel")).toBeHidden();
  await expect(page.locator("#lesson-outline-panel")).toBeHidden();
  await expect(approvalCard(page)).toBeVisible();
  await page.getByRole("button", { name: "采用修改" }).click({ trial: true });
  expect(await approvalCard(page).evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/lessonup-a4-draft-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await openLessonFile(page);
  await expect(page.getByRole("button", { name: "采用修改" })).toBeEnabled();
  await sendPrompt(page, "继续讨论教学方法");
  await expect(page.getByRole("heading", { name: "确定性回复" })).toBeVisible();
  const canonicalAfterChat = await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json();
  expect(canonicalAfterChat.document).toEqual(canonicalBefore.document);
  expect(canonicalAfterChat.documentVersion).toBe(canonicalBefore.documentVersion);
  await page.getByRole("button", { name: "采用修改" }).click();
  await expect(page.getByText("修改已写入教案", { exact: true })).toBeVisible();
  await expect(objectivesEditor(page)).toContainText(approvedObjective.replace(/^\d+\.\s*/, ""));
  await expect(page.getByLabel("向备课助手提问")).toBeEnabled();
  expect(consoleErrors).toEqual([]);
});

test("confirms one complete lesson change and writes basis plus A4 atomically", async ({ lessonPage: page }) => {
  await sendPrompt(page, "请提交完整备课调整");
  const confirmation = approvalCard(page);
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("补充学生困难并落实到评价练习");
  await expect(confirmation).toContainText("草稿尚未保存，对话可以继续。");
  const overflow = await approvalDiff(page).evaluate((element) => {
    const card = element.getBoundingClientRect();
    return [...element.querySelectorAll("del, ins, details")].some((child) => {
      const box = child.getBoundingClientRect();
      return box.right > card.right + 0.5 || child.scrollWidth > child.clientWidth + 1;
    });
  });
  expect(overflow).toBe(false);
  await expect(approvalDiff(page).locator("ins")).toContainText("要求学生说明判断所依据的文本证据");

  await page.getByRole("button", { name: "采用修改" }).click();
  await expect(page.getByText("修改已写入教案", { exact: true })).toBeVisible();
  await expect(assessmentEditor(page)).toContainText("要求学生说明判断所依据的文本证据");

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
  await expect(approvalCard(page)).toBeVisible();

  const teacherValue = "教师自行设计了新的测评任务，不采用原评价表述。";
  await page.getByRole("button", { name: "查看原文" }).click();
  await assessmentEditor(page).fill(teacherValue);
  await expect(page.getByRole("button", { name: "采用修改" })).toBeDisabled();
  await expect(page.getByText(/原文已变化，请重新生成/)).toBeVisible();
  await expect(assessmentEditor(page)).toContainText(teacherValue);
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
  const confirmation = approvalCard(page);
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("把已确认的学生困难落实到评价练习");
  await expect(confirmation).toContainText("草稿尚未保存，对话可以继续。");
  await expect(approvalDiff(page).locator("ins")).toContainText("要求学生说明判断所依据的文本证据");

  await page.getByRole("button", { name: "采用修改" }).click();
  await expect(page.getByText("修改已写入教案", { exact: true })).toBeVisible();
  await expect(assessmentEditor(page)).toContainText("要求学生说明判断所依据的文本证据");

  const finalBasisResponse = await page.request.get(`/api/lesson-files/${lessonFileId}/design-basis`);
  const finalBasis = await finalBasisResponse.json();
  expect(finalBasis.basis.version).toBe(1);
  expect(finalBasis.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: entryId, statement }),
  ]));
});

test("covers approval diff, refresh recovery, reject, approve, safe rebase and undo", async ({ lessonPage: page }) => {
  await sendPrompt(page, "请提交修改并展示 diff");
  const confirmation = approvalCard(page);
  await expect(confirmation).toBeVisible();
  await expect(approvalDiff(page).locator("del")).toHaveText(initialObjective);
  await expect(approvalDiff(page).locator("ins")).toHaveText(approvedObjective);

  await page.reload();
  await openLessonFile(page);
  await expect(approvalCard(page)).toBeVisible();
  await page.getByRole("button", { name: "放弃修改" }).click();
  await expect(page.getByText("已保留原文", { exact: true })).toBeVisible();
  await expect(objectivesEditor(page)).toContainText(initialObjective.replace(/^\d+\.\s*/, ""));

  await createThread(page);
  await sendPrompt(page, "请提交修改");
  await page.getByRole("button", { name: "采用修改" }).click();
  await expect(page.getByText("修改已写入教案", { exact: true })).toBeVisible();
  await expect(objectivesEditor(page)).toContainText(approvedObjective.replace(/^\d+\.\s*/, ""));
  await expect(page.getByRole("button", { name: "撤销" })).toBeEnabled();
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(objectivesEditor(page)).toContainText(initialObjective.replace(/^\d+\.\s*/, ""));
  await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();

  await createThread(page);
  await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
  await sendPrompt(page, "请提交修改以验证版本冲突");
  await expect(approvalCard(page)).toBeVisible();
  await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
  const manualValue = `${initialObjective}（并发编辑）\n2. 在观察、比较与讨论中形成解决问题的方法。`;
  await page.getByRole("button", { name: "查看原文" }).click();
  await objectivesEditor(page).fill(manualValue);
  await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
  await objectivesEditor(page).blur();
  await expect(page.getByText("已自动保存", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "采用修改" }).click();
  await expect(page.getByText("修改已写入教案", { exact: true })).toBeVisible();
  await expect(objectivesEditor(page)).toContainText("能从文本证据中解释春日意象的形成。（并发编辑）");
});

test("flushes a pending manual edit before starting a document-writing run", async ({ lessonPage: page }) => {
  const latestObjective = "1. 先观察春日声音，再用文本证据说明判断。";
  await objectivesEditor(page).fill(`${latestObjective}\n2. 在讨论中形成解释。`);

  await sendPrompt(page, "请提交修改");

  const confirmation = approvalCard(page);
  await expect(confirmation).toBeVisible();
  await expect(approvalDiff(page).locator("del")).toContainText("先观察春日声音，再用文本证据说明判断。");
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
  await expect(approvalCard(page)).toBeVisible();

  const unsavedValue = `${initialObjective}（审批前继续编辑）\n2. 保留教师刚刚补充的内容。`;
  await page.getByRole("button", { name: "查看原文" }).click();
  await objectivesEditor(page).fill(unsavedValue);
  await page.getByRole("button", { name: "采用修改" }).click();

  const mergedValue = `${approvedObjective}（审批前继续编辑）\n2. 保留教师刚刚补充的内容。`;
  await expect(page.getByText("修改已写入教案", { exact: true })).toBeVisible();
  await expect(objectivesEditor(page)).toContainText("能从文本证据中解释春日意象的形成。（审批前继续编辑）");
  await page.reload();
  await openLessonFile(page);
  await expect(objectivesEditor(page)).toContainText("能从文本证据中解释春日意象的形成。（审批前继续编辑）");
});

test("rejects a true conflict when the teacher changes the proposed target", async ({ lessonPage: page }) => {
  await sendPrompt(page, "请提交修改");
  await expect(approvalCard(page)).toBeVisible();

  const teacherValue = "1. 教师已将本项目标改为观察声音线索。\n2. 保留教师自己的教学判断。";
  await page.getByRole("button", { name: "查看原文" }).click();
  await objectivesEditor(page).fill(teacherValue);
  await expect(page.getByRole("button", { name: "采用修改" })).toBeDisabled();
  await expect(page.getByText(/原文已变化，请重新生成/)).toBeVisible();
  await expect(objectivesEditor(page)).toContainText("教师已将本项目标改为观察声音线索");
});

test("recovers a committed decision after a lost response without starting a reply run", async ({ lessonPage: page }) => {
  await sendPrompt(page, "请提交修改并验证续跑恢复");
  await expect(page.getByRole("button", { name: "采用修改" })).toBeEnabled();
  const before = await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json();
  await page.route("**/api/agent/runs/*/approvals/*", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "采用修改" }).click();
  await expect(page.getByText("修改已写入教案", { exact: true })).toBeVisible();
  await page.reload();
  await openLessonFile(page);
  await expect(page.getByText("修改已写入教案", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试回复" })).toHaveCount(0);
  const canonical = await page.request.get(`/api/lesson-files/${lessonFileId}`);
  expect((await canonical.json()).documentVersion).toBe(before.documentVersion + 1);
  await expect(objectivesEditor(page)).toContainText(approvedObjective.replace(/^\d+\.\s*/, ""));
});
