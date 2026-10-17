import { expect, test as base, type Page } from "@playwright/test";
import { initialNotebookGraph, lessonFileId } from "./test-data.js";

type AgentFixtures = { collectionPage: Page; lessonPage: Page };

export const test = base.extend<AgentFixtures>({
  collectionPage: async ({ context, page }, use) => {
    const userId = crypto.randomUUID();
    await context.setExtraHTTPHeaders({ authorization: `Bearer ${userId}` });
    const imported = await page.request.post("/api/bootstrap/import", {
      data: { notebooks: initialNotebookGraph },
    });
    if (!imported.ok()) throw new Error(`agent_e2e_seed_failed:${imported.status()}`);
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("lessonup:server-imported:v1", new Date().toISOString());
    });
    await page.addInitScript((session) => {
      localStorage.setItem("lessonup.session.v1", JSON.stringify(session));
    }, {
      accessToken: userId,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      account: { id: userId, loginName: "e2e", createdAt: new Date().toISOString() },
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "新增备课本", exact: true })).toBeVisible();
    await use(page);
  },
  lessonPage: async ({ collectionPage }, use) => {
    const page = collectionPage;
    await openLessonFile(page);
    await expect(page.getByLabel("向备课助手提问")).toBeEnabled();
    await expect(page.locator(".lesson-file-workspace")).toHaveAttribute("data-motion", "idle");
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
