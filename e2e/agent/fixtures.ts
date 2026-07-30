import { expect, test as base, type Page } from "@playwright/test";
import { resetE2EState } from "./test-data.js";

type AgentFixtures = { lessonPage: Page };

export const test = base.extend<AgentFixtures>({
  lessonPage: async ({ context, page }, use) => {
    const userId = process.env.LESSONUP_E2E_USER_ID;
    if (!userId) throw new Error("LESSONUP_E2E_USER_ID_missing");
    await resetE2EState(userId);
    await context.setExtraHTTPHeaders({ "x-lessonup-user": userId });
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("lessonup:server-imported:v1", new Date().toISOString());
    });
    await page.goto("/");
    await page.getByRole("button", { name: "打开语文备课本", exact: true }).click();
    const openFile = page.getByRole("button", { name: "打开备课文件春日的第一声鸟鸣", exact: true });
    await expect(openFile).toBeVisible();
    await openFile.click();
    await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
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
  await expect(page.getByText("可以从整份教案出发提问", { exact: false })).toBeVisible();
}
