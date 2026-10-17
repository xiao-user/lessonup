import { expect, test } from './fixtures.js';
import { initialNotebookGraph } from './test-data.js';

test.use({ contextOptions: { reducedMotion: 'no-preference' } });

test('preserves inertial shelf, delayed title turn, reversible leaves and spatial detail', async ({ collectionPage: page }, testInfo) => {
  const graph = Array.from({ length: 8 }, (_, n) => ({
    ...initialNotebookGraph[0], id: n ? `motion-book-${n}` : 'chinese',
    title: n ? `动画验收备课本 ${n}` : '语文备课本',
    files: Array.from({ length: 20 }, (_, f) => ({
      ...initialNotebookGraph[0].files[0], id: n || f ? `motion-file-${n}-${f}` : 'c1',
      title: n || f ? `动画验收文件 ${n}-${f}` : '春日的第一声鸟鸣',
    })),
  }));
  expect((await page.request.post('/api/bootstrap/import', { data: { notebooks: graph } })).ok()).toBeTruthy();
  await page.reload();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const measures: Record<string, unknown> = {};
  const start = async () => {
    await page.evaluate(() => {
      const probe = { frames: [] as number[], angles: [] as { cover: number; title: number }[], last: performance.now(), frame: 0 };
      (window as any).__motionProbe = probe;
      const tick = (now: number) => {
        probe.frames.push(now - probe.last); probe.last = now;
        const book = document.querySelector('.book-volume[data-notebook-id="chinese"]');
        const cover = book?.querySelector('.book-volume-cover');
        const title = book?.querySelector('[data-page-kind="title"]');
        if (cover && title) probe.angles.push({
          cover: parseFloat(getComputedStyle(cover).getPropertyValue('--cover-angle')),
          title: parseFloat(getComputedStyle(title).getPropertyValue('--leaf-angle')),
        });
        probe.frame = requestAnimationFrame(tick);
      };
      probe.frame = requestAnimationFrame(tick);
    });
    return await cdp.send('Performance.getMetrics');
  };
  const stop = async (name: string, before: any) => {
    const after = await cdp.send('Performance.getMetrics');
    const frames = await page.evaluate(() => {
      const probe = (window as any).__motionProbe;
      cancelAnimationFrame(probe.frame);
      return { maxFrame: Math.max(...probe.frames), framesOver50: probe.frames.filter((v: number) => v > 50).length,
        delayedTitle: probe.angles.some((v: { cover: number; title: number }) => Math.abs(v.cover) > Math.abs(v.title) + 30) };
    });
    const delta = (name: string) => (after.metrics.find((v: any) => v.name === name)?.value ?? 0) - (before.metrics.find((v: any) => v.name === name)?.value ?? 0);
    measures[name] = { ...frames, layoutMs: delta('LayoutDuration') * 1000, styleMs: delta('RecalcStyleDuration') * 1000, taskMs: delta('TaskDuration') * 1000 };
    return frames;
  };
  await expect(page.getByRole('button', { name: '打开语文备课本', exact: true })).toBeVisible();
  const shelf = page.locator('.book-carousel');
  let before = await start();
  await page.mouse.move(650, 350);
  await page.mouse.wheel(0, 200);
  await expect(shelf).toHaveAttribute('data-motion-state', 'moving');
  await expect(shelf).toHaveAttribute('data-motion-state', 'idle');
  await stop('scroll', before);
  await page.getByRole('button', { name: '语文备课本', exact: true }).click();
  await expect(shelf).toHaveAttribute('data-motion-state', 'idle');
  before = await start();
  await page.getByRole('button', { name: '打开语文备课本', exact: true }).click();
  await page.waitForTimeout(360);
  await page.screenshot({ path: testInfo.outputPath('opening.png') });
  const book = page.locator('.book-volume.is-open');
  await expect(book).not.toHaveClass(/is-animating/);
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeEnabled();
  const opening = await stop('open', before);
  expect(opening.delayedTitle).toBeTruthy();
  await expect(book.locator('.book-volume-leaf.is-current')).toHaveAttribute('data-page-index', '1');
  before = await start();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(book.locator('[data-page-kind="title"] .book-volume-leaf-back')).toContainText('语文备课本');
  await page.waitForTimeout(200);
  await page.screenshot({ path: testInfo.outputPath('turning.png') });
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeEnabled();
  await stop('turn', before);
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  const paper = book.locator('.book-volume-leaf.is-current').getByRole('button', { name: /^打开备课文件/ });
  await expect(paper).toHaveAttribute('tabindex', '0');
  await paper.click();
  await expect(page.locator('.lesson-file-workspace')).toBeVisible();
  await expect(page.locator('.lesson-file-workspace')).toHaveAttribute('data-motion', 'entering');
  await expect(page.locator('.lesson-sheet-frame').first()).toHaveCSS('position', 'fixed');
  await page.waitForTimeout(220);
  await page.screenshot({ path: testInfo.outputPath('detail-enter.png') });
  await expect(page.locator('.lesson-sheet-content').first()).toHaveCSS('opacity', '1');
  await expect(page.locator('.lesson-side-rail').last()).toHaveCSS('opacity', '1');
  await expect(page.locator('.lesson-file-workspace')).toHaveAttribute('data-motion', 'idle');
  await page.getByRole('button', { name: /返回备课本/ }).click();
  await page.waitForTimeout(260);
  await page.screenshot({ path: testInfo.outputPath('detail-exit.png') });
  await expect(page.locator('.lesson-file-workspace')).toHaveCount(0);
  await expect(paper).toBeFocused();
  before = await start();
  await page.getByRole('button', { name: '返回全部备课本', exact: true }).click();
  await expect(page.locator('.book-volume.is-open')).toHaveCount(0);
  await stop('close', before);
  expect(errors).toEqual([]);
  console.log('Motion profile', JSON.stringify(measures));
  await testInfo.attach('motion-profile', { body: JSON.stringify(measures, null, 2), contentType: 'application/json' });
  await cdp.detach();
});


test('paper transition settles on resize and keeps mobile drawers usable', async ({ collectionPage: page }, testInfo) => {
  await page.getByRole('button', { name: '打开语文备课本', exact: true }).click();
  const paper = page.getByRole('button', { name: '打开备课文件春日的第一声鸟鸣', exact: true });
  await expect(paper).toHaveAttribute('tabindex', '0');
  await paper.click();
  const workspace = page.locator('.lesson-file-workspace');
  await expect(workspace).toHaveAttribute('data-motion', 'entering');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(workspace).toHaveAttribute('data-motion', 'idle');
  await expect(page.locator('.lesson-sheet-frame').first()).toHaveCSS('position', 'relative');
  await page.getByRole('button', { name: '显示备课助手', exact: true }).click();
  await expect(page.getByLabel('向备课助手提问')).toBeVisible();
  await page.getByRole('button', { name: '显示备课助手', exact: true }).click();
  await expect(page.getByLabel('向备课助手提问')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('mobile-detail.png') });
  await page.goBack();
  await expect(workspace).toHaveCount(0);
  await expect(paper).toBeFocused();
  await paper.press('Enter');
  await expect(workspace).toHaveAttribute('data-motion', 'entering');
  // Navigation during entry must settle its pose before the reverse transition.
  await page.goBack();
  await expect(workspace).toHaveCount(0);
  await expect(paper).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await paper.press('Enter');
  await expect(workspace).toHaveAttribute('data-motion', 'idle');
  await expect(page.locator('.lesson-sheet-frame').first()).toHaveCSS('position', 'relative');
  await page.goBack();
  await expect(workspace).toHaveCount(0);
});
