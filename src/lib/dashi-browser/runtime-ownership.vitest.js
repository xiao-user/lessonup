import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';
import { scopeDashiRuntimeRelease } from '../../../scripts/dashi-runtime-compat.mjs';

const project = 'server/agent/skills/dashi-ppt/project';
const upstream = readFileSync(`${project}/src/components/themes/client-runtime.jsx`, 'utf8');
const template = readFileSync(`${project}/assets/template-swiss.html`, 'utf8');

function functions(source, names) {
  return names.map(name => {
    // These upstream declarations are top-level and their closing braces start
    // in column zero. Evaluate their actual bodies, not a rewritten model.
    const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
    if (!match) throw new Error(`Missing upstream function: ${name}`);
    return match[0];
  }).join('\n');
}

function scenario(source) {
  const { document } = parseHTML('<html><body><main id="deck"></main><aside id="rail"></aside></body></html>');
  const mountedRoots = new WeakMap();
  const unmount = vi.fn();
  const context = {
    document, mountedRoots, rootMediaApis: new WeakMap(), performance,
    releaseRuntimeSlideVideos() {}, hasLiveVideoElement() { return false; },
    // No network, persistence or LessonUp bootstrap participates in this test.
    ensureRuntimeSlideRendered() {}, shouldUseLiteOverviewPreview() { return false; },
    getOverviewSourceSize() { return { width: 1920, height: 1080 }; },
    releaseTemplateVideoElements() {}, uniquifySvgCloneIds() {},
    applyOverviewPreviewGeometry() {}, recordOverviewStage() {},
    getOverviewStableSlideId(slide) { return slide.dataset.vmSlideId; },
  };
  runInNewContext(functions(source, [
    ...(source.includes('function resetRuntimeRoot(') ? ['resetRuntimeRoot', 'releaseRuntimeBespokeSlide', 'releaseRuntimeSlide'] : []),
    'releaseRuntimeThemeSlide', 'releaseInactiveRuntimeSlides',
  ]), context);
  const script = template.slice(template.lastIndexOf('<script', template.indexOf('function createOverviewDomPreview(')));
  const js = script.slice(script.indexOf('>') + 1, script.indexOf('</script>'));
  runInNewContext(functions(js, ['createOverviewDomPreview']), context);
  const slides = ['封面', '相邻页', '正文'].map((title, index) => {
    const slide = document.createElement('section');
    slide.className = `slide imported-theme-slide${index === 1 ? ' cv-near' : ''}`;
    slide.dataset.vmSlideId = `slide-${index}`;
    slide.innerHTML = `<div class="imported-theme-root" data-theme-key="theme01"><h1>${title}</h1></div>`;
    document.getElementById('deck').append(slide);
    mountedRoots.set(slide.firstElementChild, { unmount });
    return slide;
  });
  const thumbs = slides.map(slide => context.createOverviewDomPreview(slide));
  document.getElementById('rail').append(...thumbs);
  const before = thumbs.map(thumb => thumb.querySelector('.imported-theme-root').textContent);
  context.releaseInactiveRuntimeSlides(slides[0]);
  const after = thumbs.map(thumb => thumb.querySelector('.imported-theme-root').textContent);
  return { before, after, slides, unmount, context };
}

describe('Dashi runtime DOM ownership', () => {
  it('reproduces the upstream regression without any storage or Web adapter', () => {
    const result = scenario(upstream);
    expect(result.before).toEqual(['封面', '相邻页', '正文']);
    expect(result.after).toEqual(['', '相邻页', '']);
  });

  it('preserves cloned thumbnails while still releasing real inactive slides', () => {
    const result = scenario(scopeDashiRuntimeRelease(upstream));
    expect(result.after).toEqual(result.before);
    expect(result.slides[0].textContent).toBe('封面');
    expect(result.slides[1].textContent).toBe('相邻页');
    expect(result.slides[2].textContent).toBe('');
    expect(result.unmount).toHaveBeenCalledTimes(1);
    result.context.releaseInactiveRuntimeSlides(result.slides[1]);
    expect(result.unmount).toHaveBeenCalledTimes(2);
  });

  it('fails closed when upstream changes the expected patch boundary', () => {
    expect(() => scopeDashiRuntimeRelease('new runtime')).toThrow('selector changed');
    expect(() => scopeDashiRuntimeRelease(upstream + upstream)).toThrow('selector changed');
  });

  // Optional historical source audit; the ordinary regressions above are self-contained.
  it.skipIf(!process.env.DASHI_LEGACY_SKILL_ROOT)('confirms the installed v0.4.5 ownership guard preserves the same clones', () => {
    const legacy = readFileSync(`${process.env.DASHI_LEGACY_SKILL_ROOT}/project/src/components/themes/client-runtime.jsx`, 'utf8');
    const result = scenario(legacy);
    expect(result.after).toEqual(result.before);
    expect(result.slides[2].textContent).toBe('');
  });
});
