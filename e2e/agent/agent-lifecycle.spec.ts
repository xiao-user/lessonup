import { createThread, expect, sendPrompt, test } from "./fixtures.js";

test("covers empty state, streaming, tools, sources, sessions, retry, cancel and branches", async ({ lessonPage: page }) => {
  await expect(page.getByText("可以从整份教案出发提问", { exact: false })).toBeVisible();

  await sendPrompt(page, "请进行普通工具调用");
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await expect(page.getByText("思考中…", { exact: true })).toBeVisible();
  await expect(page.getByText("读取教学目标", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/任务组：/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "确定性回复" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "已读取当前教案栏目。" })).toBeVisible();
  await expect(page.getByText("1 个来源", { exact: true })).toBeVisible();
  await expect(page.getByText("完成", { exact: true })).toBeVisible();
  await expect(page.getByText("工作范围", { exact: true })).toHaveCount(0);
  await expect(page.locator(".craft-response-content")).toHaveCSS("max-height", "none");
  await expect(page.locator(".craft-response-card")).toHaveCSS("box-shadow", "none");
  await expect(page.locator(".lesson-assistant-rail")).toHaveCSS("padding-left", "0px");
  await expect(page.locator(".lesson-document-scroll")).toHaveCSS("scrollbar-color", "auto");
  await expect(page.locator(".lesson-document-scroll")).toHaveCSS("scrollbar-width", "auto");
  await expect(page.locator(".lesson-agent-title")).toContainText("请进行普通工具调用");
  await expect(page.getByLabel("切换备课会话")).not.toContainText("请进行普通工具调用");

  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "重命名" }).click();
  const threadNameInput = page.getByRole("textbox", { name: "会话名称", exact: true });
  await expect(threadNameInput).toBeVisible();
  await threadNameInput.fill("教案结构检查");
  await page.getByRole("button", { name: "保存会话名称" }).click();
  await expect(page.locator(".lesson-agent-title")).toHaveText("教案结构检查");

  await page.getByRole("button", { name: "从此消息创建分支" }).click();
  await expect(page.getByLabel("切换消息分支")).toBeVisible();
  await expect(page.getByLabel("切换消息分支")).toContainText("分支");

  await createThread(page);
  await sendPrompt(page, "请制造失败");
  await expect(page.getByRole("alert")).toContainText("deterministic_agent_failure");
  await page.getByRole("button", { name: "重试上一轮" }).click();
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
  await expect(page.getByRole("option", { name: "教案结构检查" })).toBeVisible();
  await expect(page.getByRole("option", { name: "请制造失败" })).toBeVisible();
  await page.getByRole("option", { name: "请等待取消" }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect(page.getByLabel("向备课助手提问")).toBeEnabled();
});
