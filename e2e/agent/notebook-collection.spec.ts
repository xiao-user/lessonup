import { expect, test } from "./fixtures.js";
import { initialDocument, lessonFileId, notebookId } from "./test-data.js";

const temporaryTitle = "端到端临时备课本";

test("creates once, scrolls across the full collection and targets the active notebook", async ({ collectionPage: page }) => {
  let temporaryNotebookId: string | null = null;
  try {
    await page.route("**/api/notebooks", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 180));
      await route.continue();
    });

    await page.getByRole("button", { name: "新增备课本", exact: true }).click();
    await page.getByRole("textbox", { name: "备课本名称", exact: true }).fill(temporaryTitle);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByRole("button", { name: "创建中…", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: `打开${temporaryTitle}`, exact: true })).toBeVisible();

    const notebooksResponse = await page.request.get("/api/notebooks");
    expect(notebooksResponse.ok()).toBeTruthy();
    const notebooks = await notebooksResponse.json();
    temporaryNotebookId = notebooks.find((notebook: { title: string }) => notebook.title === temporaryTitle)?.id ?? null;
    expect(temporaryNotebookId).toBeTruthy();

    await expect(page.locator("video")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开备课本", exact: true })).toHaveCount(0);
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText(temporaryTitle);
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, 220);
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText("语文备课本");
    await page.waitForTimeout(620);
    await page.mouse.wheel(0, 900);
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText("语文备课本");

    await page.getByRole("button", { name: "新增备课文件", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "所属备课本", exact: true })).toContainText("语文备课本");

    await page.getByRole("button", { name: "取消", exact: true }).click();

    await page.mouse.wheel(0, -220);
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText(temporaryTitle);
    await page.waitForTimeout(620);
    await page.mouse.wheel(0, -900);
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText(temporaryTitle);

    await page.getByRole("button", { name: "语文备课本", exact: true }).click();
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText("语文备课本");
    const activeNameBox = await page.locator(".book-carousel-index button.is-active").boundingBox();
    const activeBookBox = await page.locator('.book-volume[data-slot="0"]').boundingBox();
    expect(activeNameBox).not.toBeNull();
    expect(activeBookBox).not.toBeNull();
    expect(Math.abs(
      (activeNameBox!.y + activeNameBox!.height / 2)
      - (activeBookBox!.y + activeBookBox!.height / 2),
    )).toBeLessThan(32);

    await page.getByRole("button", { name: "打开语文备课本", exact: true }).click();
    await expect(page.getByRole("button", { name: "合上语文备课本", exact: true })).toBeVisible();
  } finally {
    if (temporaryNotebookId) {
      const response = await page.request.delete(`/api/notebooks/${temporaryNotebookId}`);
      expect(response.ok()).toBeTruthy();
    }
  }
});

test("turns real lesson-file pages and restores an independently routed detail", async ({ collectionPage: page }) => {
  let temporaryFileId: string | null = null;
  try {
    const createResponse = await page.request.post("/api/lesson-files", {
      data: {
        notebookId,
        title: "翻页交互测试",
        type: "新教案",
        document: { ...initialDocument, topic: "翻页交互测试" },
        pageCount: 1,
      },
    });
    expect(createResponse.ok()).toBeTruthy();
    temporaryFileId = (await createResponse.json()).id;

    await page.reload();
    await page.getByRole("button", { name: "打开语文备课本", exact: true }).click();
    const openBook = page.locator(".book-volume.is-open");
    const titleLeaf = openBook.locator('.book-volume-leaf[data-page-index="0"]');
    const firstLeaf = openBook.locator('.book-volume-leaf[data-page-index="1"]');
    await expect(titleLeaf).toHaveAttribute("data-page-kind", "title");
    await expect(titleLeaf).toContainText("语文备课本");
    await expect(titleLeaf).toHaveClass(/is-turned/);
    await expect(firstLeaf).toContainText("翻页交互测试");
    const openLayers = await openBook.evaluate((book) => ({
      title: Number(window.getComputedStyle(book.querySelector('[data-page-kind="title"]')!).zIndex),
      pages: Number(window.getComputedStyle(book.querySelector(".book-volume-pages")!).zIndex),
      cover: Number(window.getComputedStyle(book.querySelector(".book-volume-cover")!).zIndex),
    }));
    expect(openLayers.title).toBeGreaterThan(openLayers.cover);
    expect(openLayers.pages).toBeGreaterThan(openLayers.cover);
    const leafInsets = await firstLeaf.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return [style.top, style.right, style.bottom, style.left];
    });
    expect(leafInsets[0]).toBe(leafInsets[2]);
    expect(leafInsets[1]).toBe(leafInsets[3]);
    await expect(openBook.locator(".book-volume-leaf-front").first()).toHaveCSS("box-shadow", "none");
    await expect(openBook.locator(".book-volume-leaf-back").first()).toHaveCSS("box-shadow", "none");
    await expect(openBook.locator(".book-volume-cover-back")).toHaveCSS("filter", "none");
    const spreadColors = await openBook.evaluate((book) => {
      const pages = book.querySelector(".book-volume-pages");
      const coverBack = book.querySelector(".book-volume-cover-back");
      return [
        window.getComputedStyle(pages!).backgroundColor,
        window.getComputedStyle(coverBack!).backgroundColor,
      ];
    });
    expect(spreadColors[0]).toBe(spreadColors[1]);

    await page.getByRole("button", { name: "下一份备课文件", exact: true }).click();
    expect(Number(await firstLeaf.evaluate((element) => window.getComputedStyle(element).zIndex)))
      .toBeGreaterThan(Number(await openBook.locator(".book-volume-cover").evaluate(
        (element) => window.getComputedStyle(element).zIndex,
      )));
    expect(await firstLeaf.getAttribute("style")).toContain("transform-origin: -0.5% 50%");
    await expect(openBook.locator(".book-volume-controls")).toContainText("2 / 2");
    await expect(page.locator(".book-volume.is-open .book-volume-leaf.is-current")).toContainText("春日的第一声鸟鸣");

    const turnedLeafZ = await openBook.locator('.book-volume-leaf.is-turned[data-page-kind="file"]').evaluate((element) =>
      Number(window.getComputedStyle(element).zIndex),
    );
    const coverZ = await openBook.locator(".book-volume-cover").evaluate((element) =>
      Number(window.getComputedStyle(element).zIndex),
    );
    const pagesZ = await openBook.locator(".book-volume-pages").evaluate((element) =>
      Number(window.getComputedStyle(element).zIndex),
    );
    expect(turnedLeafZ).toBeGreaterThan(coverZ);
    expect(pagesZ).toBeGreaterThan(coverZ);

    await page.getByRole("button", { name: "返回全部备课本", exact: true }).click();
    await expect(page.locator(".book-volume.is-open")).toHaveCount(0);
    await expect(page.locator(".book-volume-leaf.is-turned")).toHaveCount(0);

    await page.getByRole("button", { name: "打开语文备课本", exact: true }).click();
    await page.getByRole("button", { name: "下一份备课文件", exact: true }).click();
    await expect(page.locator(".book-volume.is-open .book-volume-leaf.is-current")).toContainText("春日的第一声鸟鸣");

    const detailPageButton = page.getByRole("button", {
      name: "打开备课文件春日的第一声鸟鸣",
      exact: true,
    });
    await expect(detailPageButton).toHaveAttribute("tabindex", "0");
    await detailPageButton.click();
    await expect(page).toHaveURL(`/lesson-files/${lessonFileId}`);
    await expect(page.locator(".lesson-page-transition-clone")).toHaveCount(0);
    await expect(openBook.locator('.book-volume-leaf[data-page-kind="file"].is-current')).toHaveCSS(
      "transform",
      "none",
    );
    await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
    await expect(page.locator(".lesson-sheet-preview")).toHaveCount(0);

    await page.reload();
    await expect(page).toHaveURL(`/lesson-files/${lessonFileId}`);
    await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
    await expect(page.locator(".book-volume.is-open .book-volume-leaf.is-current")).toContainText("春日的第一声鸟鸣");

    await page.getByRole("button", { name: "返回备课本", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.locator(".lesson-file-workspace")).toHaveCount(0);
    const restoredBook = page.locator(".book-volume.is-open");
    await expect(restoredBook).toHaveCSS("--book-rotation", "0deg");
    const restoredStyle = await restoredBook.getAttribute("style");
    expect(restoredStyle).toContain("--book-scale: 1.32");
    await expect(restoredBook.locator(".book-volume-leaf.is-current")).toContainText("春日的第一声鸟鸣");
    await expect(restoredBook.locator(".book-volume-leaf.is-current")).toHaveCSS("transform", "none");
    const restoredCopyStyles = await restoredBook
      .locator(".book-volume-leaf.is-current .book-volume-file > *")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("style") ?? ""));
    expect(restoredCopyStyles.every((style) => !style.includes("opacity") && !style.includes("visibility")))
      .toBeTruthy();
  } finally {
    if (temporaryFileId) {
      const response = await page.request.delete(`/api/lesson-files/${temporaryFileId}`);
      expect(response.ok()).toBeTruthy();
    }
  }
});

test("rewinds every turned leaf before an outside-click close settles", async ({ collectionPage: page }) => {
  const temporaryFileIds: string[] = [];
  try {
    for (const [index, title] of ["回卷测试一", "回卷测试二", "回卷测试三"].entries()) {
      const createResponse = await page.request.post("/api/lesson-files", {
        data: {
          notebookId,
          title,
          type: "新教案",
          document: { ...initialDocument, topic: title },
          pageCount: index + 1,
        },
      });
      expect(createResponse.ok()).toBeTruthy();
      temporaryFileIds.push((await createResponse.json()).id);
    }

    await page.reload();
    await page.getByRole("button", { name: "打开语文备课本", exact: true }).click();
    const openBook = page.locator(".book-volume.is-open");
    await expect(openBook.locator(".book-volume-controls")).toContainText("1 / 4");
    await expect(page.getByRole("button", { name: "下一份备课文件", exact: true })).toBeEnabled();

    const rapidTurnStartedAt = Date.now();
    for (let pageIndex = 2; pageIndex <= 4; pageIndex += 1) {
      await page.getByRole("button", { name: "下一份备课文件", exact: true }).click({ force: true });
      await expect(openBook.locator(".book-volume-controls")).toContainText(`${pageIndex} / 4`);
    }
    expect(Date.now() - rapidTurnStartedAt).toBeLessThan(900);
    await expect(openBook.locator(".book-volume-leaf.is-turned")).toHaveCount(4);

    await page.getByRole("button", { name: "返回全部备课本", exact: true }).click();
    await page.waitForTimeout(160);
    const closingTransforms = await openBook.evaluate((book) => ({
      cover: (book.querySelector(".book-volume-cover") as HTMLElement).style.transform,
      leaves: [...book.querySelectorAll(".book-volume-leaf")]
        .slice(0, 3)
        .map((leaf) => (leaf as HTMLElement).style.transform),
    }));
    expect(closingTransforms.cover).toContain("rotateY(");
    expect(closingTransforms.cover).not.toContain("rotateY(-180deg)");
    expect(closingTransforms.leaves.every((transform) => transform.includes("rotateY("))).toBeTruthy();
    await expect(page.locator(".book-volume.is-open")).toHaveCount(0);
    await expect(page.locator(".book-volume-leaf.is-turned")).toHaveCount(0);
    const remainingInlineTransforms = await page
      .locator(`.book-volume[data-notebook-id="${notebookId}"] .book-volume-leaf`)
      .evaluateAll((leaves) => leaves.map((leaf) => (leaf as HTMLElement).style.transform).filter(Boolean));
    expect(remainingInlineTransforms).toEqual([]);

    await page.getByRole("button", { name: "打开语文备课本", exact: true }).click();
    await expect(page.locator(".book-volume.is-open .book-volume-controls")).toContainText("1 / 4");
  } finally {
    for (const temporaryFileId of temporaryFileIds) {
      const response = await page.request.delete(`/api/lesson-files/${temporaryFileId}`);
      expect(response.ok()).toBeTruthy();
    }
  }
});
