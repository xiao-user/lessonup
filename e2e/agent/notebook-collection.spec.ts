import { expect, test } from "./fixtures.js";
import { initialDocument, lessonFileId, notebookId } from "./test-data.js";

const temporaryTitle = "端到端临时备课本";

test("creates once, scrolls across the full collection and targets the active notebook", async ({ collectionPage: page }) => {
  let temporaryNotebookId: string | null = null;
  try {
    const closedActionOrder = await page.locator(".create-actions").evaluate((actions) =>
      [...actions.children].map((button) => button.getAttribute("aria-label") || button.textContent?.trim()),
    );
    expect(closedActionOrder).toEqual(["退出登录", "新增备课本", "新增备课文件"]);
    await expect(page.getByRole("button", { name: "新增备课文件", exact: true })).toHaveCSS(
      "border-radius",
      "9999px",
    );

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
    await expect(page.locator(".create-actions").getByRole("button", { name: "新增备课文件", exact: true }))
      .toBeVisible();
    await expect(page.locator(".collection-context-action").first()).toBeHidden();
    await expect(page.locator(".notebook-file-count")).toHaveCount(0);
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
    await page.waitForTimeout(450);
    const openingAngles = await openBook.evaluate((book) => ({
      cover: Number.parseFloat(window.getComputedStyle(book.querySelector(".book-volume-cover")!)
        .getPropertyValue("--cover-angle")),
      title: Number.parseFloat(window.getComputedStyle(book.querySelector('[data-page-kind="title"]')!)
        .getPropertyValue("--leaf-angle")),
    }));
    expect(Math.abs(openingAngles.cover)).toBeGreaterThan(Math.abs(openingAngles.title) + 30);
    await expect(titleLeaf).toHaveAttribute("data-page-kind", "title");
    await expect(titleLeaf).toContainText("语文备课本");
    await expect(titleLeaf).toHaveClass(/is-turned/);
    await expect(firstLeaf).toContainText("翻页交互测试");
    await expect(titleLeaf).toHaveCSS("--leaf-angle", "-180deg");
    await expect(openBook.locator(".book-volume-cover")).toHaveCSS("--cover-angle", "-180deg");
    const openLayers = await openBook.evaluate((book) => {
      const title = window.getComputedStyle(book.querySelector('[data-page-kind="title"]')!);
      const cover = window.getComputedStyle(book.querySelector(".book-volume-cover")!);
      return {
        titleZ: new DOMMatrixReadOnly(title.transform).m43,
        coverZ: new DOMMatrixReadOnly(cover.transform).m43,
        titleLayer: title.zIndex,
        pagesLayer: window.getComputedStyle(book.querySelector(".book-volume-pages")!).zIndex,
        coverLayer: cover.zIndex,
      };
    });
    expect(openLayers.titleZ).toBeGreaterThan(openLayers.coverZ);
    expect(openLayers.titleLayer).toBe("auto");
    expect(openLayers.pagesLayer).toBe("auto");
    expect(openLayers.coverLayer).toBe("auto");
    const openSpreadSize = await openBook.evaluate((book) => {
      const cover = book.querySelector(".book-volume-cover")!.getBoundingClientRect();
      const spread = book.querySelector(".book-volume-pages")!.getBoundingClientRect();
      return {
        widthDifference: Math.abs(cover.width - spread.width),
        heightDifference: Math.abs(cover.height - spread.height),
      };
    });
    expect(openSpreadSize.widthDifference).toBeLessThan(0.1);
    expect(openSpreadSize.heightDifference).toBeLessThan(0.1);
    const leafInsets = await firstLeaf.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return [style.top, style.right, style.bottom, style.left];
    });
    expect(leafInsets[0]).toBe(leafInsets[2]);
    expect(leafInsets[1]).toBe(leafInsets[3]);
    await expect(openBook.locator(".book-volume-leaf-front").first()).toHaveCSS("box-shadow", "none");
    await expect(openBook.locator(".book-volume-leaf-back").first()).toHaveCSS("box-shadow", "none");
    await expect(openBook.locator(".book-volume-cover-back")).toHaveCSS("filter", "none");
    await expect(openBook.locator(".book-volume-leaf-front").first()).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await expect(openBook.locator(".book-volume-leaf-back").first()).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
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
    await expect(firstLeaf).toHaveCSS("--leaf-angle", "-180deg");
    const turnedPageDepth = await firstLeaf.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        angle: style.getPropertyValue("--leaf-angle").trim(),
        z: new DOMMatrixReadOnly(style.transform).m43,
      };
    });
    const openCoverDepth = await openBook.locator(".book-volume-cover").evaluate((element) =>
      new DOMMatrixReadOnly(window.getComputedStyle(element).transform).m43,
    );
    expect(turnedPageDepth.z).toBeGreaterThan(openCoverDepth);
    expect(turnedPageDepth.angle).toBe("-180deg");
    await expect(openBook.locator(".book-volume-controls")).toContainText("2 / 2");
    await expect(page.locator(".book-volume.is-open .book-volume-leaf.is-current")).toContainText("春日的第一声鸟鸣");

    const turnedLeafZ = await openBook.locator('.book-volume-leaf.is-turned[data-page-kind="file"]').evaluate((element) =>
      new DOMMatrixReadOnly(window.getComputedStyle(element).transform).m43,
    );
    const coverZ = await openBook.locator(".book-volume-cover").evaluate((element) =>
      new DOMMatrixReadOnly(window.getComputedStyle(element).transform).m43,
    );
    expect(turnedLeafZ).toBeGreaterThan(coverZ);
    await expect(openBook.locator(".book-volume-pages")).toHaveCSS("z-index", "auto");

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
      "z-index",
      "auto",
    );
    await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
    await expect(page.getByRole("button", { name: /返回备课本/ })).toContainText("春日的第一声鸟鸣");
    await expect(page.locator(".lesson-file-identity h1")).toHaveCount(0);
    await expect(page.locator(".lesson-save-status")).toContainText("已自动保存");
    await expect(page.getByRole("button", { name: "撤销", exact: true })).toHaveCSS("height", "40px");
    const anchorWidths = await page.locator(".lesson-anchor-mark").evaluateAll((marks) =>
      marks.slice(0, 3).map((mark) => window.getComputedStyle(mark).width),
    );
    expect(anchorWidths).toEqual(["22px", "10px", "10px"]);
    const anchors = page.locator(".lesson-anchor");
    expect(await anchors.count()).toBeGreaterThan(3);
    await anchors.nth(3).hover();
    await expect(page.locator(".lesson-anchor-nav")).toHaveAttribute("data-preview", "true");
    await page.waitForTimeout(350);
    const previewAnchorWidths = await page.locator(".lesson-anchor-mark").evaluateAll((marks) =>
      marks.slice(0, 4).map((mark) => window.getComputedStyle(mark).width),
    );
    expect(previewAnchorWidths).toEqual(["12px", "15px", "19px", "26px"]);
    await expect(page.locator(".lesson-sheet-preview")).toHaveCount(0);
    const responsivePaper = await page.locator(".lesson-document-scroll").evaluate((scroll) => {
      const frame = scroll.querySelector(".lesson-sheet-frame")!;
      const sheet = frame.querySelector(".lesson-sheet")!;
      const scrollStyle = window.getComputedStyle(scroll);
      return {
        available: scroll.clientWidth
          - Number.parseFloat(scrollStyle.paddingLeft)
          - Number.parseFloat(scrollStyle.paddingRight),
        frameWidth: frame.getBoundingClientRect().width,
        logicalWidth: (sheet as HTMLElement).offsetWidth,
      };
    });
    expect(responsivePaper.frameWidth).toBeLessThanOrEqual(responsivePaper.available + 1);
    expect(responsivePaper.logicalWidth).toBeGreaterThanOrEqual(responsivePaper.frameWidth);

    await page.reload();
    await expect(page).toHaveURL(`/lesson-files/${lessonFileId}`);
    await expect(page.getByRole("region", { name: "春日的第一声鸟鸣备课文件" })).toBeVisible();
    await expect(page.locator(".book-volume.is-open .book-volume-leaf.is-current")).toContainText("春日的第一声鸟鸣");

    await page.getByRole("button", { name: /返回备课本/ }).click();
    await expect(page).toHaveURL("/");
    await expect(page.locator(".lesson-file-workspace")).toHaveCount(0);
    const restoredBook = page.locator(".book-volume.is-open");
    await expect(restoredBook).toHaveCSS("--book-rotation", "0deg");
    const restoredStyle = await restoredBook.getAttribute("style");
    expect(restoredStyle).toContain("--book-scale: 1.32");
    await expect(restoredBook.locator(".book-volume-leaf.is-current")).toContainText("春日的第一声鸟鸣");
    await expect(restoredBook.locator(".book-volume-leaf.is-current")).toHaveCSS("z-index", "auto");
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
    await page.waitForTimeout(750);
    const visibleSpread = await openBook.evaluate((book) => {
      const currentLeaf = book.querySelector(".book-volume-leaf.is-current")!;
      const turnedLeaves = [...book.querySelectorAll(".book-volume-leaf.is-turned")];
      const latestTurnedLeaf = turnedLeaves.at(-1)!;
      const leftFace = latestTurnedLeaf.querySelector(".book-volume-leaf-back")!;
      const rightFace = currentLeaf.querySelector(".book-volume-leaf-front")!;
      const visibleFaceAt = (face: Element) => {
        const rect = face.getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          ?.closest(".book-volume-leaf-front, .book-volume-leaf-back")
          ?.textContent
          ?.replace(/\s+/g, " ")
          .trim();
      };
      return {
        expectedLeft: leftFace.textContent?.replace(/\s+/g, " ").trim(),
        expectedRight: rightFace.textContent?.replace(/\s+/g, " ").trim(),
        visibleLeft: visibleFaceAt(leftFace),
        visibleRight: visibleFaceAt(rightFace),
      };
    });
    expect(visibleSpread.visibleLeft).toBe(visibleSpread.expectedLeft);
    expect(visibleSpread.visibleRight).toBe(visibleSpread.expectedRight);

    await page.getByRole("button", { name: "上一份备课文件", exact: true }).click();
    await expect(openBook.locator(".book-volume-controls")).toContainText("3 / 4");
    await page.waitForTimeout(750);
    const reversedSpread = await openBook.evaluate((book) => {
      const currentLeaf = book.querySelector(".book-volume-leaf.is-current")!;
      const latestTurnedLeaf = [...book.querySelectorAll(".book-volume-leaf.is-turned")].at(-1)!;
      const leftFace = latestTurnedLeaf.querySelector(".book-volume-leaf-back")!;
      const rightFace = currentLeaf.querySelector(".book-volume-leaf-front")!;
      const visibleFaceAt = (face: Element) => {
        const rect = face.getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          ?.closest(".book-volume-leaf-front, .book-volume-leaf-back")
          ?.textContent
          ?.replace(/\s+/g, " ")
          .trim();
      };
      return {
        expectedLeft: leftFace.textContent?.replace(/\s+/g, " ").trim(),
        expectedRight: rightFace.textContent?.replace(/\s+/g, " ").trim(),
        visibleLeft: visibleFaceAt(leftFace),
        visibleRight: visibleFaceAt(rightFace),
      };
    });
    expect(reversedSpread.visibleLeft).toBe(reversedSpread.expectedLeft);
    expect(reversedSpread.visibleRight).toBe(reversedSpread.expectedRight);

    await page.getByRole("button", { name: "返回全部备课本", exact: true }).click();
    await page.waitForTimeout(160);
    const closingTransforms = await openBook.evaluate((book) => ({
      cover: (book.querySelector(".book-volume-cover") as HTMLElement).style.getPropertyValue("--cover-angle"),
      leaves: [...book.querySelectorAll(".book-volume-leaf")]
        .slice(0, 3)
        .map((leaf) => (leaf as HTMLElement).style.getPropertyValue("--leaf-angle")),
    }));
    expect(closingTransforms.cover).toContain("deg");
    expect(closingTransforms.cover).not.toBe("-180deg");
    expect(closingTransforms.leaves.every((angle) => angle.includes("deg"))).toBeTruthy();
    await expect(page.locator(".book-volume.is-open")).toHaveCount(0);
    await expect(page.locator(".book-volume-leaf.is-turned")).toHaveCount(0);
    const remainingInlineTransforms = await page
      .locator(`.book-volume[data-notebook-id="${notebookId}"] .book-volume-leaf`)
      .evaluateAll((leaves) => leaves
        .map((leaf) => (leaf as HTMLElement).style.getPropertyValue("--leaf-angle"))
        .filter(Boolean));
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
