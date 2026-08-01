import { expect, test as base, type Page } from "@playwright/test";
import { lessonFileId, resetE2EState } from "./test-data.js";

type AgentFixtures = { collectionPage: Page; lessonPage: Page };

export const test = base.extend<AgentFixtures>({
  collectionPage: async ({ context, page }, use) => {
    const userId = process.env.LESSONUP_E2E_USER_ID;
    if (!userId) throw new Error("LESSONUP_E2E_USER_ID_missing");
    await resetE2EState(userId);
    await context.setExtraHTTPHeaders({ "x-lessonup-user": userId });
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("lessonup:server-imported:v1", new Date().toISOString());
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "新增备课本", exact: true })).toBeVisible();
    await use(page);
  },
  lessonPage: async ({ collectionPage }, use) => {
    const page = collectionPage;
    await openLessonFile(page);
    await expect(page.getByLabel("向备课助手提问")).toBeEnabled();
    await use(page);
  },
});

export { expect } from "@playwright/test";

export async function sendPrompt(page: Page, prompt: string) {
  const composer = page.getByLabel("向备课助手提问");
  await composer.fill(prompt);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}

export async function createThread(page: Page) {
  await page.getByRole("button", { name: "新建会话" }).click();
  await expect(page.getByText("可结合当前教案继续备课", { exact: true })).toBeVisible();
}

export async function openLessonFile(page: Page) {
  if (new URL(page.url()).pathname === `/lesson-files/${lessonFileId}`) {
    await page.goto("/");
  }
  await page.getByRole("button", { name: "打开语文备课本", exact: true }).click();
  const paper = page.getByRole("button", {
    name: "打开备课文件春日的第一声鸟鸣",
    exact: true,
  });
  await expect(paper).toBeVisible();
  await expect(paper).toHaveAttribute("tabindex", "0");
  await paper.focus();
  await paper.press("Enter");
  await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
}
