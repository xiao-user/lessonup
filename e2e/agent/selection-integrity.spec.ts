import { expect, openLessonFile, sendPrompt, test } from "./fixtures.js";
import { lessonFileId } from "./test-data.js";
import { prepareCurrentSelection } from "../../server/agent-runtime/pi/selection-snapshot.js";

// Public canonical v2 objectives from the production incident. The original
// request selection was not retained; this test never invents that payload.
const incidentObjectives = [
  '1. 能借助注释疏通《咏雪》文意，用"谁+做了什么+结果"格式复述故事。',
  '2. 掌握"俄而、骤、欣然、差、拟、未若"的语境义。',
  '3. 从形态、动态、意境三个维度比较"撒盐空中"与"柳絮因风起"，并说出有依据的理由。',
  '4. 把"读—查—接—说"方法迁移到《陈太丘与友期行》的自读初疏，为第 2 课时做准备。',
].join("\n");
const canonical = async (page: import("@playwright/test").Page) => (await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json());

for (const undo of ["button", "keyboard", "adopted"] as const) {
  test(`incident v2 → manual pink v3 → ${undo} undo v4 → 补上 preserves selection integrity`, async ({ lessonPage: page }) => {
    // Seed the exact v2 through the existing API: this isolates the incident's
    // text/editor timeline rather than pretending to replay model generation.
    for (const objectives of undo === "adopted" ? [incidentObjectives] : ["过渡原稿", incidentObjectives]) {
      const file = await canonical(page);
      const response = await page.request.patch(`/api/lesson-files/${lessonFileId}/document`, {
        headers: { "idempotency-key": crypto.randomUUID() },
        data: { baseVersion: file.documentVersion, document: { ...file.document, objectives }, pageCount: 1, source: "manual" },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    await page.reload();
    await openLessonFile(page);
    if (undo === "adopted") {
      // The existing harness replaces the first objective with fixed fixture
      // text. This variant covers real approval events; the other two retain
      // the exact incident source, without claiming to replay its model.
      await sendPrompt(page, "重新生成当前教案，精简一些，请提交修改");
      await expect(page.getByRole("button", { name: "采用修改", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "采用修改", exact: true }).click();
      await expect(page.getByText("修改已写入教案", { exact: true })).toBeVisible();
    }
    const v2 = await canonical(page);
    expect(v2.documentVersion).toBe(2);
    const expectedObjectives = v2.document.objectives;
    await sendPrompt(page, "有哪些使用马克笔重点突出的");
    await expect(page.getByRole("heading", { name: "确定性回复" })).toBeVisible();
    const objectives = page.locator('.lesson-tiptap-field[aria-label="教学目标"]:visible').first();
    await objectives.locator("li").first().click();
    await objectives.locator("li").first().evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const toolbar = page.getByRole("toolbar", { name: "标记选中文字" });
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "粉色荧光" }).click();
    await expect(objectives.locator('mark[data-tone="pink"]')).toBeVisible();
    await expect.poll(async () => (await canonical(page)).documentVersion).toBe(3);
    expect((await canonical(page)).document.objectives).toContain("=={pink}");
    if (undo !== "keyboard") await page.getByRole("button", { name: "撤销", exact: true }).click();
    else {
      await objectives.focus();
      await page.keyboard.press("Meta+z");
    }
    await expect.poll(async () => (await canonical(page)).documentVersion).toBe(4);
    await expect(objectives.locator("mark")).toHaveCount(0);
    const v4 = await canonical(page); expect(v4.document.objectives).toBe(expectedObjectives);
    if (undo === "keyboard") {
      await objectives.locator("li").first().click();
      await objectives.locator("li").first().evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await expect(page.getByRole("toolbar", { name: "标记选中文字" })).toBeVisible();
    }
    const requests: any[] = [];
    page.on("request", request => {
      if (request.method() === "POST" && /\/api\/agent\/threads\/[^/]+\/runs$/.test(new URL(request.url()).pathname)) requests.push(request.postDataJSON());
    });
    await sendPrompt(page, "补上");
    await expect.poll(() => requests.length).toBe(1);
    const input = requests[0]; expect(input.documentVersion).toBe(4);
    if (undo === "keyboard") expect(input.selection).toMatchObject({ field: "objectives", fieldSnapshot: incidentObjectives, documentVersion: 4, text: incidentObjectives.split("\n")[0].slice(3) });
    else expect(input.selection).toBeUndefined();
    // Fixture transport doesn't run Pi preparation. Check the genuine guard
    // with the actual browser payload, not a hypothetical stale selection.
    expect(() => prepareCurrentSelection(input.selection, v4.document, v4.documentVersion)).not.toThrow();
    await expect(page.getByRole("heading", { name: "确定性回复" })).toHaveCount(2);
    expect(requests).toHaveLength(1);
    expect((await canonical(page)).documentVersion).toBe(4);
  });
}

test("once-decoded entity quote remains genuine from browser DOM to the server guard", async ({ lessonPage: page }) => {
  const file = await canonical(page);
  const source = "讨论 =={pink}**&amp;lt;原句&amp;gt;**== 的作用";
  const response = await page.request.patch(`/api/lesson-files/${lessonFileId}/document`, {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: { baseVersion: file.documentVersion, document: { ...file.document, objectives: source }, pageCount: 1, source: "manual" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.reload(); await openLessonFile(page);
  const objectives = page.locator('.lesson-tiptap-field[aria-label="教学目标"]:visible').first();
  await expect(objectives).toHaveText("讨论 &lt;原句&gt; 的作用");
  await objectives.click();
  await objectives.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByRole("toolbar", { name: "标记选中文字" })).toBeVisible();
  const requests: any[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && /\/api\/agent\/threads\/[^/]+\/runs$/.test(new URL(request.url()).pathname)) requests.push(request.postDataJSON());
  });
  await sendPrompt(page, "解释选中文字");
  await expect.poll(() => requests.length).toBe(1);
  const input = requests[0];
  expect(input.selection.text).toBe("讨论 &lt;原句&gt; 的作用");
  expect(input.selection.fieldSnapshot).toBe(source);
  const saved = await canonical(page);
  expect(prepareCurrentSelection(input.selection, saved.document, saved.documentVersion)?.text).toBe(input.selection.text);
  await expect(page.getByRole("heading", { name: "确定性回复" })).toBeVisible();
  expect(requests).toHaveLength(1);
});
