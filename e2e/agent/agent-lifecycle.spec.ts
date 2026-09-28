import { createThread, expect, openLessonFile, sendPrompt, test } from "./fixtures.js";
import { lessonFileId, notebookId } from "./test-data.js";

test("covers empty state, streaming, tools, sources, sessions, retry, cancel and branches", async ({ lessonPage: page }) => {
  await expect(page.getByText("可结合当前教案继续备课", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "教学情境" }).click();
  await page.getByLabel("本课时分钟").fill("40");
  await page.getByLabel("学情特征").fill("已完成预习，能够独立朗读文本。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("教学情境已更新")).toBeVisible();

  await sendPrompt(page, "请进行普通工具调用");
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await expect(page.getByText("读取教学目标", { exact: true })).toBeVisible();
  await expect(page.getByText(/^用时 .*秒$/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "确定性回复" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "已读取当前教案栏目。" })).toBeVisible();
  await expect(page.getByText("1 个来源", { exact: true })).toBeVisible();
  await expect(page.getByText("完成", { exact: true })).toBeVisible();
  await expect(page.getByText("工作范围", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "备课助手回复" })).toHaveCSS("min-width", "0px");
  await expect(page.getByRole("button", { name: "读取教学目标 完成" })).toHaveCount(1);
  await expect(page.locator(".lesson-assistant-rail")).toHaveCSS("padding-left", "0px");
  await expect(page.locator(".lesson-document-scroll")).toHaveCSS("scrollbar-color", "auto");
  await expect(page.locator(".lesson-document-scroll")).toHaveCSS("scrollbar-width", "auto");
  await expect(page.locator(".lesson-agent-title")).toContainText("请进行普通工具调用");
  await expect(page.getByLabel("切换备课会话")).not.toContainText("请进行普通工具调用");
  await expect(page.getByLabel("切换备课会话")).toHaveCSS("width", "32px");
  await expect(page.getByLabel("切换备课会话")).toHaveCSS("height", "32px");
  await expect(page.getByLabel("切换备课会话").locator("svg")).toHaveCount(1);
  const headingActionStyles = await Promise.all(
    ["切换备课会话", "新建会话", "会话操作"].map((name) => page.getByRole("button", { name }).evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        backgroundColor: styles.backgroundColor,
        borderColor: styles.borderColor,
        borderStyle: styles.borderStyle,
        boxShadow: styles.boxShadow,
      };
    })),
  );
  expect(headingActionStyles[0]).toEqual(headingActionStyles[1]);
  expect(headingActionStyles[0]).toEqual(headingActionStyles[2]);

  const historyTrigger = page.getByRole("button", { name: "切换备课会话" });
  await historyTrigger.click();
  const historyMenu = page.getByRole("menu");
  await expect(historyMenu).toBeVisible();
  const [historyTriggerBox, historyMenuBox] = await Promise.all([historyTrigger.boundingBox(), historyMenu.boundingBox()]);
  expect(historyTriggerBox).not.toBeNull();
  expect(historyMenuBox).not.toBeNull();
  expect(historyMenuBox.y).toBeGreaterThanOrEqual(historyTriggerBox.y + historyTriggerBox.height);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "重命名" }).click();
  const threadNameInput = page.getByRole("textbox", { name: "会话名称", exact: true });
  await expect(threadNameInput).toBeVisible();
  await threadNameInput.fill("教案结构检查");
  await page.getByRole("button", { name: "保存会话名称" }).click();
  await expect(page.locator(".lesson-agent-title")).toHaveText("教案结构检查");

  await page.getByRole("button", { name: "从此创建分支" }).click();
  await expect(page.getByLabel("切换消息分支")).toBeVisible();
  await expect(page.getByLabel("切换消息分支")).toContainText("分支");

  await createThread(page);
  await sendPrompt(page, "请制造失败");
  const failedResponse = page.getByRole("article", { name: "备课助手回复" }).last();
  await expect(failedResponse).toContainText("备课助手本轮未能完成");
  await expect(failedResponse).toContainText("已完成问题定位");
  await expect(failedResponse).toContainText("已生成的内容仍保留");
  await expect(page.locator(".lesson-agent-error")).toHaveCount(0);
  await page.reload();
  await openLessonFile(page);
  await expect(page.getByRole("article", { name: "备课助手回复" }).last()).toContainText("备课助手本轮未能完成");
  await expect(page.getByRole("article", { name: "备课助手回复" }).last()).toContainText("已完成问题定位");
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("heading", { name: "确定性回复" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "已读取当前教案栏目。" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await createThread(page);
  await sendPrompt(page, "请等待取消");
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect(page.getByLabel("向备课助手提问")).toBeEnabled();

  await createThread(page);
  await page.getByLabel("切换备课会话").click();
  await expect(page.getByRole("menuitem", { name: "教案结构检查" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "请制造失败" })).toBeVisible();
  await page.getByRole("menuitem", { name: "请等待取消" }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect(page.getByLabel("向备课助手提问")).toBeEnabled();
});

test("routes a theme Approval Card answer into the next Turn instead of the Pi queue", async ({ lessonPage: page }) => {
  await sendPrompt(page, "请请求主题选择");
  await expect(page.getByRole("region", { name: "选择一个视觉主题" })).toBeVisible();

  await page.getByRole("button", { name: /theme02 · 炫光紫绿风/ }).click();

  await expect(page.getByRole("region", { name: "选择一个视觉主题" })).toHaveCount(0);
  await expect(page.getByText("已加入 Pi 队列", { exact: true })).toHaveCount(0);
  await expect(page.getByText("已接收主题 theme02，并进入下一步。", { exact: true })).toBeVisible();
});

test("isolates drafts on their proposing branch and recovers them on reopen", async ({ lessonPage: page }) => {
  await sendPrompt(page, "先生成一个可分支的回复");
  await expect(page.getByRole("heading", { name: "确定性回复" })).toBeVisible();
  await page.getByRole("button", { name: "从此创建分支" }).click();
  await expect(page.getByLabel("切换消息分支")).toBeVisible();

  await sendPrompt(page, "请提交修改");
  await expect(page.getByRole("button", { name: "采用修改" })).toBeVisible();

  await page.getByLabel("切换消息分支").click();
  await page.getByRole("listbox").getByRole("option").first().click();
  await expect(page.getByRole("button", { name: "采用修改" })).toHaveCount(0);

  await page.reload();
  await openLessonFile(page);
  await expect(page.getByRole("button", { name: "采用修改" })).toBeVisible();
  await expect(page.getByText("草稿尚未保存，对话可以继续。", { exact: true })).toBeVisible();
});

test("deletes an unsent composer attachment when the user starts another thread", async ({ lessonPage: page }) => {
  await sendPrompt(page, "先完成一轮对话以便新建会话");
  await expect(page.getByRole("heading", { name: "确定性回复" })).toBeVisible();

  await page.getByLabel("选择备课资料").setInputFiles({
    name: "temporary-draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("这是一份不会发送的非敏感临时验收资料。"),
  });
  await expect(page.getByText("temporary-draft.txt", { exact: true })).toBeVisible();

  await createThread(page);
  await expect.poll(async () => {
    const response = await page.request.get(
      `/api/knowledge/uploads?lessonFileId=${encodeURIComponent(lessonFileId)}`,
    );
    if (!response.ok()) return `status:${response.status()}`;
    return (await response.json()).length;
  }).toBe(0);
});

test("replays one atomic thread and main-branch creation", async ({ lessonPage: page }) => {
  const idempotencyKey = crypto.randomUUID();
  const data = {
    notebookId,
    lessonFileId,
    title: "原子创建验收",
  };
  const first = await page.request.post("/api/agent/threads", {
    headers: { "idempotency-key": idempotencyKey },
    data,
  });
  const replay = await page.request.post("/api/agent/threads", {
    headers: { "idempotency-key": idempotencyKey },
    data,
  });
  expect(first.ok()).toBeTruthy();
  expect(replay.ok()).toBeTruthy();
  const firstAggregate = await first.json();
  const replayedAggregate = await replay.json();
  expect(replayedAggregate.thread.id).toBe(firstAggregate.thread.id);
  expect(replayedAggregate.branch.id).toBe(firstAggregate.branch.id);
  const removed = await page.request.delete(`/api/agent/threads/${firstAggregate.thread.id}`);
  expect(removed.ok()).toBeTruthy();
});

test("recovers an ordinary run whose server lease expired", async ({ lessonPage: page }) => {
  const seeded = await page.request.post("/api/__e2e/runs/expired");
  expect(seeded.ok()).toBeTruthy();
  const runId = (await seeded.json()).id;

  await page.reload();
  await openLessonFile(page);
  await expect(page.getByRole("article", { name: "备课助手回复" }).last())
    .toContainText("服务中断后，本轮回复已安全终止");
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect(page.getByLabel("向备课助手提问")).toBeEnabled();

  const recoveredResponse = await page.request.get(`/api/__e2e/runs/${runId}`);
  expect(recoveredResponse.ok()).toBeTruthy();
  expect(await recoveredResponse.json()).toMatchObject({ status: "failed", error: "run_interrupted" });
});
