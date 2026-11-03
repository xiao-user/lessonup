import { expect, test } from './fixtures.js';
import { initialNotebookGraph, lessonFileId } from './test-data.js';

test('paper canvas zooms and pans without changing pagination or editor content', async ({ lessonPage: page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const before = await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json();
  const frames = page.locator('.lesson-sheet-frame');
  const pageCount = await frames.count();
  const first = frames.first();
  const originalWidth = (await first.boundingBox())!.width;
  const viewport = page.getByRole('main', { name: 'A4教案编辑区' });
  await expect(page.getByRole('toolbar', { name: '画布工具' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '教案目录' })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('a4-desktop.png') });
  await page.getByRole('combobox', { name: '画布缩放比例' }).selectOption('1.5');
  await expect.poll(async () => (await first.boundingBox())!.width).toBeGreaterThan(originalWidth * 1.4);
  await expect(frames).toHaveCount(pageCount);
  await page.getByRole('button', { name: '拖动画布', exact: true }).click();
  const scroll = await viewport.evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }));
  const bounds = (await viewport.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 350);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 - 90, bounds.y + 180, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(scroll.top + 80);
  await page.getByRole('button', { name: '选择与编辑', exact: true }).click();
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  await expect.poll(async () => viewport.evaluate(el => el.scrollTop)).toBe(0);
  await expect.poll(async () => (await first.boundingBox())!.width).toBeCloseTo(originalWidth, 0);
  await page.getByRole('button', { name: '显示教案目录', exact: true }).click();
  await page.getByRole('button', { name: '教学过程', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '教案目录' })).toBeHidden();
  await page.getByRole('button', { name: '收起备课助手', exact: true }).click();
  await expect(page.getByLabel('向备课助手提问')).toBeHidden();
  await page.getByRole('button', { name: '展开备课助手', exact: true }).click();
  await expect(page.getByLabel('向备课助手提问')).toBeVisible();
  const after = await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json();
  expect(after.document).toEqual(before.document);
  expect(after.documentVersion).toBe(before.documentVersion);
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('a4-mobile.png') });
  await expect(page.getByRole('button', { name: /返回备课本/ })).toBeVisible();
  // Editing at an enlarged scale must still address the canonical field.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('combobox', { name: '画布缩放比例' }).selectOption('1.5');
  await page.locator('.lesson-tiptap-field[aria-label="教学目标"]:visible').first().fill('缩放后仍能准确保存当前教学目标。');
  await expect.poll(async () => (await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json()).document.objectives).toContain('缩放后仍能准确保存');
  const edited = await (await page.request.get(`/api/lesson-files/${lessonFileId}`)).json();
  expect(edited.document.process).toBe(before.document.process);
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('toolbar', { name: '画布工具' })).toBeHidden();
  const printed = await first.evaluate(frame => ({
    width: frame.getBoundingClientRect().width,
    canonical: frame.querySelector('.lesson-sheet').offsetWidth,
    transform: getComputedStyle(frame.querySelector('.lesson-sheet')).transform,
  }));
  expect(Math.abs(printed.width - printed.canonical)).toBeLessThan(2);
  expect(printed.transform).toBe('none');
  expect(errors).toEqual([]);
});

test('semester framework uses the same canvas while retaining planning and mobile navigation', async ({ collectionPage: page }, testInfo) => {
  const notebookId = 'canvas-math';
  expect((await page.request.post('/api/bootstrap/import', {
    data: { notebooks: [{ ...initialNotebookGraph[0], id: notebookId, title: '数学备课本', subject: '数学', files: [] }] },
  })).ok()).toBeTruthy();
  const created = await page.request.post(`/api/notebooks/${notebookId}/semester-frameworks`, {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: { textbookId: 'textbook-math-bnu', title: '数学上学期教学框架', term: '2026—2027 学年上学期',
      totalWeeks: 18, weeklyPeriods: 5, lessonDurationMinutes: 40, capacityRatio: 0.9, planningHorizonWeeks: 2, contextProfile: {} },
  });
  expect(created.status(), await created.text()).toBe(201);
  const aggregate = await created.json();
  await page.goto(`/semester-frameworks/${aggregate.framework.id}`);
  const workspace = page.getByRole('region', { name: '数学上学期教学框架', exact: true });
  await expect(workspace).toBeVisible();
  const unit = workspace.locator('.framework-unit').first();
  await expect(unit).toBeVisible();
  const width = (await unit.boundingBox())!.width;
  await expect(page.getByLabel('向备课助手提问')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('framework-desktop.png') });
  await page.getByRole('combobox', { name: '画布缩放比例' }).selectOption('0.5');
  await expect.poll(async () => (await unit.boundingBox())!.width).toBeLessThan(width * 0.8);
  await page.getByRole('button', { name: '打开单元目录', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '单元目录', exact: true })).toBeVisible();
  await page.getByRole('complementary', { name: '单元目录', exact: true }).locator('nav button').last().click();
  await expect(page.getByRole('complementary', { name: '单元目录', exact: true })).toBeHidden();
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开单元目录', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '单元目录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭面板', exact: true }).last().click();
  await page.getByRole('button', { name: '打开备课助手', exact: true }).click();
  await expect(page.getByLabel('向备课助手提问')).toBeVisible();
  await page.getByRole('button', { name: '关闭面板', exact: true }).last().click();
  await page.screenshot({ path: testInfo.outputPath('framework-mobile.png') });
  const saved = await (await page.request.get(`/api/semester-frameworks/${aggregate.framework.id}`)).json();
  expect(saved.framework.version).toBe(aggregate.framework.version);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '收起备课助手', exact: true }).click();
  await expect(page.getByLabel('向备课助手提问')).toBeHidden();
  await page.getByRole('button', { name: '展开备课助手', exact: true }).click();
  await expect(page.getByLabel('向备课助手提问')).toBeVisible();
  await page.getByRole('combobox', { name: '画布缩放比例' }).selectOption('0.75');
  await unit.getByLabel('单元目标', { exact: true }).fill('能在新情境中选择关系并解释依据。');
  await unit.getByRole('button', { name: '保存单元', exact: true }).click();
  await expect(unit.getByRole('button', { name: '已同步', exact: true })).toBeDisabled();
  const edited = await (await page.request.get(`/api/semester-frameworks/${aggregate.framework.id}`)).json();
  expect(edited.units[0].learningGoals).toBe('能在新情境中选择关系并解释依据。');
  expect(edited.framework.version).toBe(aggregate.framework.version + 1);
});
