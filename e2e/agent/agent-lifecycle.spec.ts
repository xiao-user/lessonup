import { createThread, expect, openLessonFile, sendPrompt, test } from "./fixtures.js";
import { adminClient } from "./test-data.js";

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

  await page.getByRole("button", { name: "从此消息创建分支" }).click();
  await expect(page.getByLabel("切换消息分支")).toBeVisible();
  await expect(page.getByLabel("切换消息分支")).toContainText("分支");

  await createThread(page);
  await sendPrompt(page, "请制造失败");
  await expect(page.locator(".craft-turn-failed")).toContainText("备课助手本轮未能完成");
  await expect(page.locator(".lesson-agent-error")).toHaveCount(0);
  await page.reload();
  await openLessonFile(page);
  await expect(page.locator(".craft-turn-failed")).toContainText("备课助手本轮未能完成");
  await page.getByRole("button", { name: "编辑后重新发送" }).click();
  await page.getByLabel("向备课助手提问").press("Enter");
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

test("reopens a thread on the branch that owns its pending approval", async ({ lessonPage: page }) => {
  await sendPrompt(page, "先生成一个可分支的回复");
  await expect(page.getByRole("heading", { name: "确定性回复" })).toBeVisible();
  await page.getByRole("button", { name: "从此消息创建分支" }).click();
  await expect(page.getByLabel("切换消息分支")).toBeVisible();

  await sendPrompt(page, "请提交修改");
  await expect(page.getByRole("button", { name: "接受修改" })).toBeVisible();

  await page.getByLabel("切换消息分支").click();
  await page.getByRole("option").first().click();
  await expect(page.getByRole("button", { name: "接受修改" })).toHaveCount(0);

  await page.reload();
  await openLessonFile(page);
  await expect(page.getByRole("button", { name: "接受修改" })).toBeVisible();
  await expect(page.getByText("有一项修改等待确认", { exact: true })).toBeVisible();
});

test("recovers an ordinary run whose server lease expired", async ({ lessonPage: page }) => {
  const userId = process.env.LESSONUP_E2E_USER_ID!;
  const client = adminClient();
  const { data: thread, error: threadError } = await client.from("agent_threads")
    .select("id")
    .eq("owner_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (threadError) throw threadError;
  const { data: branch, error: branchError } = await client.from("agent_branches")
    .select("id")
    .eq("owner_id", userId)
    .eq("thread_id", thread.id)
    .limit(1)
    .single();
  if (branchError) throw branchError;

  const runId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const { error: messageError } = await client.from("agent_messages").insert({
    id: assistantMessageId,
    owner_id: userId,
    thread_id: thread.id,
    branch_id: branch.id,
    role: "assistant",
    content: "",
    status: "streaming",
  });
  if (messageError) throw messageError;
  const { error: runError } = await client.from("agent_runs").insert({
    id: runId,
    owner_id: userId,
    thread_id: thread.id,
    branch_id: branch.id,
    model: "expired-e2e-run",
    status: "running",
    lease_token: "dead-worker",
    lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
    assistant_message_id: assistantMessageId,
  });
  if (runError) throw runError;
  const { error: updateError } = await client.from("agent_threads")
    .update({ status: "running" })
    .eq("owner_id", userId)
    .eq("id", thread.id);
  if (updateError) throw updateError;

  await page.reload();
  await openLessonFile(page);
  await expect(page.locator(".craft-turn-failed"))
    .toContainText("服务中断后，本轮回复已安全终止");
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect(page.getByLabel("向备课助手提问")).toBeEnabled();

  const { data: recovered, error: recoveredError } = await client.from("agent_runs")
    .select("status,error")
    .eq("owner_id", userId)
    .eq("id", runId)
    .single();
  if (recoveredError) throw recoveredError;
  expect(recovered).toMatchObject({ status: "failed", error: "run_interrupted" });
});
