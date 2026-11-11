import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import {
  buildDashiContentArtifact,
  buildNativeDashiEditorDocument,
  nativeStateToBrowserDeck,
  readDashiContentArtifact,
} from './native-editor-document.js';
import { normalizeDeck } from './core/schema.js';

const deck = normalizeDeck({
  id: 'deck-1', title: '《秋天的怀念》', theme: 'theme01',
  slides: [
    {
      id: 'slide-1',
      content: { presentation: { title: '《秋天的怀念》', task: '圈画母亲的动作与语言' } },
      variants: [{
        id: 'v1', kind: 'template', layout: 'theme01_page001', props: { kicker: '语文课堂' },
        contentMap: { titleTop: 'presentation.title', lead: 'presentation.task' },
      }],
    },
    {
      id: 'slide-2',
      content: { presentation: { title: '从动作与语言读懂母爱', task: '研读“央求—喜出望外—絮叨”的变化' } },
      variants: [{
        id: 'v1', kind: 'template', layout: 'theme01_page010', props: { kicker: '文本研读' },
        contentMap: { title: 'presentation.title', cn: 'presentation.task' },
      }],
    },
  ],
});

const runtimeCatalog = { layouts: {
  theme01_page001: {
    themePack: 'theme01', dataLayout: 'cover', controls: [{ key: 'scheme', type: 'select', options: [{ value: 'green', label: '绿色' }] }], bgClass: 'cover-surface',
    defaultProps: { titleTop: '模板默认标题', accentColor: '#5b8def' },
  },
  theme01_page010: {
    themePack: 'theme01', dataLayout: 'method', controls: [], bgClass: '',
    defaultProps: { title: '横纵分析法', accentColor: '#e8503a' },
  },
} };

describe('native Dashi editor document', () => {
  it('routes srcdoc PPTX export to the native browser implementation after initialization', async () => {
    const html = buildNativeDashiEditorDocument({ template: '<head></head>', runtimeCatalog, deck, assetBaseUrl: 'https://example.com/dashi/' });
    const script = html.match(/<script data-lessonup-browser-export>([\s\S]*?)<\/script>/)[1];
    let ready;
    let calls = 0;
    const fetch = vi.fn().mockResolvedValue(new Response('native-response'));
    const window = {
      fetch,
      addEventListener(event, callback) { expect(event).toBe('DOMContentLoaded'); ready = callback; },
      __exportDeckPptxInBrowser() { calls += 1; return Promise.resolve('native-result'); },
      __exportDeckPptx() { throw new Error('HTTP-only entry must not run inside srcdoc'); },
    };
    runInNewContext(script, { window, Response });
    expect(calls).toBe(0);
    ready();
    expect(await window.__exportDeckPptx()).toBe('native-result');
    expect(calls).toBe(1);
    const optionalStore = await window.fetch('/api/export-pptx-store?fileName=test', { method: 'POST', body: new Blob(['pptx']) });
    expect(optionalStore.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    const save = { method: 'POST', body: JSON.stringify({ state: {} }) };
    expect(await (await window.fetch('/api/save-deck-state', save)).text()).toBe('native-response');
    expect(fetch).toHaveBeenCalledWith('/api/save-deck-state', save);
  });
  it('gives the native capture iframe a reloadable initial deck, not the srcdoc pathname', () => {
    const html = buildNativeDashiEditorDocument({
      template: readFileSync('server/agent/skills/dashi-ppt/project/assets/template-swiss.html', 'utf8'),
      runtimeCatalog, deck, assetBaseUrl: 'https://example.com/dashi/',
    });
    const sourceScript = html.match(/<script>window.__lessonupExportDocument=([\s\S]*?);<\/script>/)[0].slice(8, -9);
    const window = {};
    runInNewContext(sourceScript, { window });
    expect(window.__lessonupExportDocument).toContain('frame.srcdoc = window.__lessonupExportDocument;');
    expect(window.__lessonupExportDocument).toContain('《秋天的怀念》');
    expect(window.__lessonupExportDocument).toContain('<base href="https://example.com/dashi/">');
    expect(window.__lessonupExportDocument).not.toContain('frame.src = location.pathname');
  });
  it('injects authored content into the untouched native editor shell', () => {
    const template = '<html lang="zh-CN"><head></head><body><div id="deck"><!-- Generated slides are injected here by scripts/render-deck.jsx. --></div><script id="preview-options" type="application/json">{}</script><script id="deck-view-model" type="application/json">{}</script><script id="embedded-text-state" type="application/json">{}</script><script src="assets/imported-theme-runtime.js"></script></body></html>';
    const html = buildNativeDashiEditorDocument({
      template,
      runtimeCatalog,
      deck,
      assetBaseUrl: 'http://127.0.0.1:5173/dashi/',
    });
    expect(html).toContain('《秋天的怀念》');
    expect(html).toContain('圈画母亲的动作与语言');
    expect(html).toContain('imported-theme-runtime.theme01.js');
    expect(html).not.toContain('window.__renderRuntimeSlides?.(document)');
    expect(html).not.toContain('LessonUp Web bootstrap');
    expect(html).not.toContain('__releaseRuntimeSlide');
    expect(html).not.toContain('__releaseInactiveRuntimeSlides');
    expect(html).not.toContain('__markOverviewThumbDirty');
    expect(html).toContain('lessonup:dashi-native-save');
    expect(html).not.toContain("'swiss-slide-change'");
    expect(html).toContain('class="slide imported-theme-slide cover-surface"');
    expect(html).toContain('模板默认标题');
    expect(html).toContain('&quot;options&quot;');

    const viewModelText = html.match(/<script id="deck-view-model" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    const viewModel = JSON.parse(viewModelText);
    expect(viewModel.slides[0].props).toEqual({
      kicker: '语文课堂',
      titleTop: '《秋天的怀念》',
      lead: '圈画母亲的动作与语言',
    });
    expect(viewModel.slides[0].materializedProps).toEqual(viewModel.slides[0].props);
    expect(viewModel.slides[1].props).toEqual({
      kicker: '文本研读',
      title: '从动作与语言读懂母爱',
      cn: '研读“央求—喜出望外—絮叨”的变化',
    });
    expect(viewModel.slides[1].materializedProps).toEqual(viewModel.slides[1].props);
  });

  it('stores authored content as one HTML artifact without the editor shell', () => {
    const goal = {
      title: deck.title,
      goal: '课堂学习',
      themePack: deck.theme,
      slides: deck.slides.map((slide) => ({ layout: slide.variants[0].layout, props: slide.variants[0].props })),
    };
    const html = buildDashiContentArtifact({ runtimeCatalog, deck, goal });
    expect(html).toContain('data-dashi-content-artifact="1"');
    expect(html).toContain('class="slide imported-theme-slide cover-surface"');
    expect(html).not.toContain('演示控制台工具栏');
    expect(readDashiContentArtifact(html)).toEqual({ goal, deck });
  });

  it('maps native editor state back to the selected Dashi variant state', () => {
    const next = nativeStateToBrowserDeck(deck, {
      slideOrder: ['slide-1', 'slide-2'],
      props: { 'slide-1': { accentColor: '#ef4444' } },
      text: { 'text:theme01_page001-1:title': '修改后的标题' },
    });
    expect(next.state.props['slide-1::v1']).toEqual({ accentColor: '#ef4444' });
    expect(next.state.text).toEqual({ 'text:theme01_page001-1:title': '修改后的标题' });
  });
});
