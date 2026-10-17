import { expect, test } from "./fixtures.js";
import { initialDocument, lessonFileId, notebookId } from "./test-data.js";

const temporaryTitle = "端到端临时备课本";

test("creates once, scrolls across the full collection and targets the active notebook", async ({ collectionPage: page }) => {
  let temporaryNotebookId: string | null = null;
  try {
    const specialQuery = await page.request.get(
      `/api/curriculum/textbooks?query=${encodeURIComponent("语文,(特殊)")}`,
    );
    expect(specialQuery.ok()).toBeTruthy();
    const closedActionOrder = await page.locator(".create-actions").evaluate((actions) =>
      [...actions.children].map((button) => button.getAttribute("aria-label") || button.textContent?.trim()),
    );
    expect(closedActionOrder).toEqual(["个人信息", "新增备课本", "新增备课文件"]);
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
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-motion-state", "moving");
    expect(Number(await page.locator(".book-carousel").getAttribute("data-carousel-position"))).toBeLessThan(1);
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText("语文备课本");
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-motion-state", "idle");
    await page.mouse.wheel(0, 900);
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText("语文备课本");
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-motion-state", "idle", { timeout: 800 });
    const bottomPosition = await page.locator(".book-carousel").getAttribute("data-carousel-position");
    await page.waitForTimeout(700);
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-carousel-position", bottomPosition!);

    await page.getByRole("button", { name: "新增备课文件", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "所属备课本", exact: true })).toContainText("语文备课本");

    await page.getByRole("button", { name: "取消", exact: true }).click();

    await page.mouse.wheel(0, -220);
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText(temporaryTitle);
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-motion-state", "idle");
    await page.mouse.wheel(0, -900);
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText(temporaryTitle);
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-motion-state", "idle", { timeout: 800 });
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-carousel-position", "0.0000");

    await page.getByRole("button", { name: "语文备课本", exact: true }).click();
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText("语文备课本");
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-motion-state", "idle");
    const activeNameBox = await page.locator(".book-carousel-index button.is-active").boundingBox();
    const activeBookBox = await page.locator('.book-volume[data-slot="0"]').boundingBox();
    expect(activeNameBox).not.toBeNull();
    expect(activeBookBox).not.toBeNull();
    expect(Math.abs(
      (activeNameBox!.y + activeNameBox!.height / 2)
      - (activeBookBox!.y + activeBookBox!.height / 2),
    )).toBeLessThan(32);

    const activeIndexButton = page.locator(".book-carousel-index button.is-active");
    await expect(activeIndexButton).toHaveAttribute("aria-current", "true");
    await expect(activeIndexButton).toHaveAttribute("tabindex", "0");
    await expect(page.locator('.book-carousel-index button[tabindex="0"]')).toHaveCount(1);
    await activeIndexButton.press("Home");
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText(temporaryTitle);
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-motion-state", "idle");
    await expect(page.locator(".book-carousel-index button.is-active")).toBeFocused();
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveCSS("box-shadow", "none");
    await page.locator(".book-carousel-index button.is-active").press("End");
    await expect(page.locator(".book-carousel-index button.is-active")).toHaveText("语文备课本");
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-motion-state", "idle");

    const carouselBox = await page.locator(".book-carousel").boundingBox();
    expect(carouselBox).not.toBeNull();
    const pointerX = carouselBox!.x + carouselBox!.width / 2;
    const pointerY = carouselBox!.y + carouselBox!.height / 2;
    await page.locator(".book-carousel").dispatchEvent("pointerdown", {
      pointerId: 41,
      pointerType: "touch",
      isPrimary: true,
      clientX: pointerX,
      clientY: pointerY,
    });
    await page.locator(".book-carousel").dispatchEvent("pointermove", {
      pointerId: 41,
      pointerType: "touch",
      isPrimary: true,
      clientX: pointerX,
      clientY: pointerY - 120,
    });
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-motion-state", "dragging");
    await page.locator(".book-carousel").dispatchEvent("pointerup", {
      pointerId: 41,
      pointerType: "touch",
      isPrimary: true,
      clientX: pointerX,
      clientY: pointerY - 120,
    });
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-motion-state", "idle");
    await page.getByRole("button", { name: "语文备课本", exact: true }).click();
    await expect(page.locator(".book-carousel")).toHaveAttribute("data-motion-state", "idle");

    await page.getByRole("button", { name: "打开语文备课本", exact: true }).click();
    await expect(page.getByRole("button", { name: "合上语文备课本", exact: true })).toBeVisible();
    await expect(page.locator(".book-volume.is-open .book-volume-cover")).toHaveCSS(
      "--cover-angle",
      "-180deg",
    );
    await expect(page.locator('.book-volume.is-open [data-page-kind="title"]')).toHaveCSS(
      "--leaf-angle",
      "-180deg",
    );
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

test("echoes persisted uploads in personal info and deletes Storage with database records", async ({ collectionPage: page }) => {
  const title = "个人资料回显验收.txt";
  let sourceId = "";
  let storageKey = "";
  try {
    const upload = await page.request.post("/api/knowledge/uploads", {
      multipart: {
        file: {
          name: title,
          mimeType: "text/plain",
          buffer: Buffer.from("这是用于验证个人文件回显与同步删除的非敏感资料。"),
        },
        notebookId,
        lessonFileId,
      },
    });
    expect(upload.ok()).toBeTruthy();
    const source = await upload.json();
    sourceId = source.id;
    storageKey = source.storage_key;

    const attached = await page.request.post(`/api/__e2e/knowledge/${sourceId}/attach`);
    expect(attached.ok()).toBeTruthy();

    const draftList = await page.request.get(
      `/api/knowledge/uploads?lessonFileId=${encodeURIComponent(lessonFileId)}`,
    );
    expect((await draftList.json()).some((file: { id: string }) => file.id === sourceId)).toBe(false);
    const completeList = await page.request.get("/api/knowledge/uploads?view=all");
    expect((await completeList.json()).some((file: { id: string }) => file.id === sourceId)).toBe(true);

    await page.getByRole("button", { name: "个人信息", exact: true }).click();
    await page.getByRole("menuitem", { name: "个人信息", exact: true }).click();
    await expect(page.getByRole("heading", { name: "个人信息", exact: true })).toBeVisible();
    await expect(page.getByText(title, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: `删除文件${title}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: "删除这个文件？", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "删除文件", exact: true }).click();
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);

    expect((await page.request.get(`/api/knowledge/uploads/${sourceId}`)).status()).toBe(404);
    const storedObject = await page.request.get(`/api/__e2e/storage?key=${encodeURIComponent(storageKey)}`);
    expect(await storedObject.json()).toEqual({ exists: false });
    sourceId = "";
  } finally {
    if (sourceId) await page.request.delete(`/api/knowledge/uploads/${sourceId}`);
  }
});

test("deletes a lesson file and its associated uploaded sources from the open book", async ({ collectionPage: page }) => {
  const title = "删除备课文件验收";
  let temporaryFileId = "";
  let sourceId = "";
  let storageKey = "";
  try {
    const created = await page.request.post("/api/lesson-files", {
      data: {
        notebookId,
        title,
        type: "新教案",
        document: { ...initialDocument, topic: title },
        pageCount: 1,
      },
    });
    expect(created.ok()).toBeTruthy();
    temporaryFileId = (await created.json()).id;

    const upload = await page.request.post("/api/knowledge/uploads", {
      multipart: {
        file: {
          name: "随备课文件删除.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("删除备课文件时应同时清理这份资料。"),
        },
        notebookId,
        lessonFileId: temporaryFileId,
      },
    });
    expect(upload.ok()).toBeTruthy();
    const source = await upload.json();
    sourceId = source.id;
    storageKey = source.storage_key;

    await page.reload();
    await page.getByRole("button", { name: "打开语文备课本", exact: true }).click();
    const deleteButton = page.getByRole("button", { name: `删除备课文件${title}`, exact: true });
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();
    await expect(page.getByRole("heading", { name: "删除这份备课文件？", exact: true })).toBeVisible();
    const deleteResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "DELETE"
      && new URL(response.url()).pathname === `/api/lesson-files/${temporaryFileId}`
    ));
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    expect((await deleteResponsePromise).status()).toBe(204);
    await expect(page.getByRole("button", { name: `打开备课文件${title}`, exact: true })).toHaveCount(0);
    expect((await page.request.get(`/api/lesson-files/${temporaryFileId}`)).status()).toBe(404);

    expect((await page.request.get(`/api/knowledge/uploads/${sourceId}`)).status()).toBe(404);
    const storedObject = await page.request.get(`/api/__e2e/storage?key=${encodeURIComponent(storageKey)}`);
    expect(await storedObject.json()).toEqual({ exists: false });
    temporaryFileId = "";
    sourceId = "";
  } finally {
    if (temporaryFileId) await page.request.delete(`/api/lesson-files/${temporaryFileId}`);
    else if (sourceId) await page.request.delete(`/api/knowledge/uploads/${sourceId}`);
  }
});

test("deletes an entire notebook with its files and Storage sources", async ({ collectionPage: page }) => {
  const title = "整本删除验收";
  let temporaryNotebookId = "";
  let temporaryFileId = "";
  let sourceId = "";
  let storageKey = "";
  try {
    const createdNotebook = await page.request.post("/api/notebooks", {
      data: {
        title,
        className: "七年级（1）班",
        year: "2026—2027 学年",
        subject: "语文",
        stage: "初中",
        grade: "七年级",
        edition: "",
        tone: "teal",
      },
    });
    expect(createdNotebook.ok()).toBeTruthy();
    temporaryNotebookId = (await createdNotebook.json()).id;

    const createdFile = await page.request.post("/api/lesson-files", {
      data: {
        notebookId: temporaryNotebookId,
        title: "整本删除中的教案",
        type: "新教案",
        document: { ...initialDocument, objectives: "整本删除应清理所有关联记录。" },
        pageCount: 1,
      },
    });
    expect(createdFile.ok()).toBeTruthy();
    temporaryFileId = (await createdFile.json()).id;

    const upload = await page.request.post("/api/knowledge/uploads", {
      multipart: {
        file: {
          name: "随备课本删除.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("删除整个备课本时应同步清理 Storage 对象。"),
        },
        notebookId: temporaryNotebookId,
        lessonFileId: temporaryFileId,
      },
    });
    expect(upload.ok()).toBeTruthy();
    const source = await upload.json();
    sourceId = source.id;
    storageKey = source.storage_key;

    await page.reload();
    await page.getByRole("button", { name: `打开${title}`, exact: true }).click();
    const deleteButton = page.getByRole("button", { name: `删除备课本${title}`, exact: true });
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();
    await expect(page.getByRole("heading", { name: "删除整个备课本？", exact: true })).toBeVisible();
    const deleteResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "DELETE"
      && new URL(response.url()).pathname === `/api/notebooks/${temporaryNotebookId}`
    ));
    await page.getByRole("button", { name: "确认删除备课本", exact: true }).click();
    expect((await deleteResponsePromise).status()).toBe(204);
    await expect(page.getByRole("button", { name: `打开${title}`, exact: true })).toHaveCount(0);

    expect((await page.request.get(`/api/lesson-files/${temporaryFileId}`)).status()).toBe(404);
    expect((await page.request.get(`/api/knowledge/uploads/${sourceId}`)).status()).toBe(404);
    const storedObject = await page.request.get(`/api/__e2e/storage?key=${encodeURIComponent(storageKey)}`);
    expect(await storedObject.json()).toEqual({ exists: false });
    temporaryNotebookId = "";
    temporaryFileId = "";
    sourceId = "";
  } finally {
    if (temporaryNotebookId) await page.request.delete(`/api/notebooks/${temporaryNotebookId}`);
    else if (sourceId) await page.request.delete(`/api/knowledge/uploads/${sourceId}`);
  }
});

test("turns real lesson-file pages and restores an independently routed detail", async ({ collectionPage: page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  let temporaryFileId: string | null = null;
  try {
    const createIdempotencyKey = crypto.randomUUID();
    const createPayload = {
      notebookId,
      title: "翻页交互测试",
      type: "新教案",
      document: { ...initialDocument, topic: "翻页交互测试" },
      contextProfile: { lessonDurationMinutes: 45 },
      pageCount: 1,
    };
    const createResponse = await page.request.post("/api/lesson-files", {
      headers: { "idempotency-key": createIdempotencyKey },
      data: createPayload,
    });
    expect(createResponse.ok()).toBeTruthy();
    temporaryFileId = (await createResponse.json()).id;
    const replayResponse = await page.request.post("/api/lesson-files", {
      headers: { "idempotency-key": createIdempotencyKey },
      data: createPayload,
    });
    expect(replayResponse.ok()).toBeTruthy();
    expect((await replayResponse.json()).id).toBe(temporaryFileId);

    await page.reload();
    await page.getByRole("button", { name: "打开语文备课本", exact: true }).click();
    const openBook = page.locator(".book-volume.is-open");
    const titleLeaf = openBook.locator('.book-volume-leaf[data-page-index="0"]');
    const firstLeaf = openBook.locator('.book-volume-leaf[data-page-index="1"]');
    // Opening lands directly on the first file; no delayed title-page sequence.
    await expect(openBook).not.toHaveClass(/is-animating/);
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

    await page.getByRole("button", { name: "下一页", exact: true }).click();
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
    await page.getByRole("button", { name: "下一页", exact: true }).click();
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
    const restoredScale = await restoredBook.evaluate((book) => {
      const styles = getComputedStyle(book);
      return {
        actual: Number.parseFloat(styles.getPropertyValue("--book-scale")),
        expected: Number.parseFloat(styles.getPropertyValue("--book-open-scale")),
      };
    });
    expect(restoredScale.actual).toBeCloseTo(restoredScale.expected, 2);
    await expect(restoredBook.locator(".book-volume-leaf.is-current")).toContainText("春日的第一声鸟鸣");
    await expect(restoredBook.locator(".book-volume-leaf.is-current")).toHaveCSS("z-index", "auto");
    const restoredCopyVisible = await restoredBook
      .locator(".book-volume-leaf.is-current .book-volume-file > *")
      .evaluateAll((elements) => elements.every((element) => {
        const styles = getComputedStyle(element);
        return Number.parseFloat(styles.opacity) > 0 && styles.visibility !== "hidden";
      }));
    expect(restoredCopyVisible).toBeTruthy();
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
    await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeEnabled();

    for (let pageIndex = 2; pageIndex <= 4; pageIndex += 1) {
      await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(openBook.locator(".book-volume-controls")).toContainText(`${pageIndex} / 4`);
    }
    await expect(openBook.locator(".book-volume-leaf.is-turned")).toHaveCount(4);
    await page.waitForTimeout(750);
    const visibleSpread = await openBook.evaluate((book) => {
      const currentLeaf = book.querySelector(".book-volume-leaf.is-current")!;
      const turnedLeaves = [...book.querySelectorAll(".book-volume-leaf.is-turned")];
      const latestTurnedLeaf = turnedLeaves.at(-1)!;
      const leftFace = latestTurnedLeaf.querySelector(".book-volume-leaf-back")!;
      const rightFace = currentLeaf.querySelector(".book-volume-leaf-front")!;
      return {
        expectedLeft: leftFace.textContent?.replace(/\s+/g, " ").trim(),
        expectedRight: rightFace.textContent?.replace(/\s+/g, " ").trim(),
        leftVisibility: getComputedStyle(leftFace).visibility,
        rightVisibility: getComputedStyle(rightFace).visibility,
        leftOpacity: Number.parseFloat(getComputedStyle(leftFace).opacity),
        rightOpacity: Number.parseFloat(getComputedStyle(rightFace).opacity),
      };
    });
    expect(visibleSpread.expectedLeft).toContain("回卷测试");
    expect(visibleSpread.expectedRight).toContain("春日的第一声鸟鸣");
    expect(visibleSpread).toMatchObject({
      leftVisibility: "visible",
      rightVisibility: "visible",
      leftOpacity: 1,
      rightOpacity: 1,
    });

    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(openBook.locator(".book-volume-controls")).toContainText("3 / 4");
    await page.waitForTimeout(750);
    const reversedSpread = await openBook.evaluate((book) => {
      const currentLeaf = book.querySelector(".book-volume-leaf.is-current")!;
      const latestTurnedLeaf = [...book.querySelectorAll(".book-volume-leaf.is-turned")].at(-1)!;
      const leftFace = latestTurnedLeaf.querySelector(".book-volume-leaf-back")!;
      const rightFace = currentLeaf.querySelector(".book-volume-leaf-front")!;
      return {
        expectedLeft: leftFace.textContent?.replace(/\s+/g, " ").trim(),
        expectedRight: rightFace.textContent?.replace(/\s+/g, " ").trim(),
        leftVisibility: getComputedStyle(leftFace).visibility,
        rightVisibility: getComputedStyle(rightFace).visibility,
        leftOpacity: Number.parseFloat(getComputedStyle(leftFace).opacity),
        rightOpacity: Number.parseFloat(getComputedStyle(rightFace).opacity),
      };
    });
    expect(reversedSpread.expectedLeft).toContain("回卷测试");
    expect(reversedSpread.expectedRight).toContain("回卷测试");
    expect(reversedSpread).toMatchObject({
      leftVisibility: "visible",
      rightVisibility: "visible",
      leftOpacity: 1,
      rightOpacity: 1,
    });

    await page.getByRole("button", { name: "返回全部备课本", exact: true }).click();
    await page.waitForTimeout(160);
    const closingTransforms = await openBook.evaluate((book) => ({
      cover: (book as HTMLElement).style.getPropertyValue("--cover-angle"),
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
