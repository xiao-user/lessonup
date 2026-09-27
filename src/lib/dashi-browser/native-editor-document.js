import { selectedVariant } from './core/schema.js';

const SAVE_MESSAGE = 'lessonup:dashi-native-save';
const ARTIFACT_GOAL_ID = 'lessonup-dashi-goal';
const ARTIFACT_DECK_ID = 'lessonup-dashi-deck';

/** Persist only authored deck HTML. The shared Dashi editor/runtime is mounted later. */
export function buildDashiContentArtifact({ runtimeCatalog, deck, goal }) {
  const native = toNativeViewModel(deck, runtimeCatalog);
  const slides = native.slides.map((slide, index) => slideMarkup(slide, index, runtimeCatalog)).join('\n');
  return `<!doctype html>\n<html lang="zh-CN" data-dashi-content-artifact="1" data-theme-pack="${escapeAttribute(deck.theme)}"><head><meta charset="utf-8"><title>${escapeHtml(deck.title)}</title></head><body><main id="deck">${slides}</main>${jsonScript('deck-view-model', native)}${jsonScript('embedded-text-state', native.state.text || {})}${jsonScript(ARTIFACT_GOAL_ID, goal)}${jsonScript(ARTIFACT_DECK_ID, deck)}</body></html>\n`;
}

export function readDashiContentArtifact(html) {
  return {
    goal: readJsonScript(html, ARTIFACT_GOAL_ID),
    deck: readJsonScript(html, ARTIFACT_DECK_ID),
  };
}

/** Assemble the official Dashi editor shell without reimplementing editor UI. */
export function buildNativeDashiEditorDocument({
  template,
  runtimeCatalog,
  deck,
  assetBaseUrl = new URL('/dashi/', window.location.href).href,
}) {
  const native = toNativeViewModel(deck, runtimeCatalog);
  const slides = native.slides.map((slide, index) => slideMarkup(slide, index, runtimeCatalog)).join('\n');
  const options = { themePacks: {}, current: { themePack: deck.theme }, language: 'zh' };
  const html = template
    .replace('<head>', `<head>\n<base href="${escapeAttribute(assetBaseUrl)}">\n${persistenceBridge()}${browserExportBridge()}`)
    .replace('<html lang="zh-CN">', `<html lang="zh-CN" data-theme-pack="${escapeAttribute(deck.theme)}">`)
    .replace('[必填] 替换为 PPT 标题 · Deck Title', escapeHtml(deck.title))
    .replace('<!-- Generated slides are injected here by scripts/render-deck.jsx. -->', slides)
    .replace(/<script id="preview-options" type="application\/json">[\s\S]*?<\/script>/, jsonScript('preview-options', options))
    .replace(/<script id="deck-view-model" type="application\/json">[\s\S]*?<\/script>/, jsonScript('deck-view-model', native))
    .replace(/<script id="embedded-text-state" type="application\/json">[\s\S]*?<\/script>/, jsonScript('embedded-text-state', native.state.text || {}))
    .replace(
      '<script src="assets/imported-theme-runtime.js"></script>',
      `<script src="theme-runtime/imported-theme-runtime.${escapeAttribute(deck.theme)}.js"></script>`,
    )
    // The native exporter reloads the deck into its isolated capture iframe.
    // srcdoc has no reloadable pathname: give that iframe the same initial deck;
    // upstream then applies the current editable snapshot itself.
    .replace('frame.src = location.pathname + location.search;', 'frame.srcdoc = window.__lessonupExportDocument;');
  return html.replace('</head>', () => `<script>window.__lessonupExportDocument=${JSON.stringify(html).replaceAll('<', '\\u003c')};</script></head>`);
}

export function nativeStateToBrowserDeck(deck, state) {
  const next = structuredClone(deck);
  const nativeProps = state?.props && typeof state.props === 'object' ? state.props : {};
  const props = {};
  for (const slide of next.slides) {
    const variant = selectedVariant(next, slide);
    props[variant.stateId] = structuredClone(nativeProps[slide.id] || nativeProps[variant.stateId] || {});
  }
  next.state = {
    ...next.state,
    ...structuredClone(state || {}),
    props,
    slideOrder: Array.isArray(state?.slideOrder) ? [...state.slideOrder] : next.state.slideOrder,
    variantSelection: next.state.variantSelection,
  };
  delete next.state.__deckSignature;
  return next;
}

export { SAVE_MESSAGE };

// srcdoc has an about: URL, so the upstream HTTP-service entry rejects it.
// Select upstream's existing browser-only implementation without changing it.
function browserExportBridge() {
  return `<script data-lessonup-browser-export>window.addEventListener('DOMContentLoaded',function(){window.__exportDeckPptx=function(){return window.__exportDeckPptxInBrowser();};},{once:true});</script>`;
}

function toNativeViewModel(deck, runtimeCatalog) {
  const stateProps = {};
  const slides = deck.slides.map((logicalSlide, index) => {
    const variant = selectedVariant(deck, logicalSlide);
    stateProps[logicalSlide.id] = structuredClone(deck.state?.props?.[variant.stateId] || {});
    const row = runtimeCatalog?.layouts?.[variant.layout] || {};
    const materializedProps = projectContent(variant.props || {}, logicalSlide.content || {}, variant.contentMap || {});
    return {
      id: logicalSlide.id,
      stateId: logicalSlide.id,
      key: `${variant.layout}-${index + 1}`,
      layout: variant.layout,
      dataLayout: row.dataLayout || variant.layout,
      themePack: variant.themePack || deck.theme,
      label: logicalSlide.label || row.label || `Slide ${index + 1}`,
      logicalIndex: index,
      // Match Dashi's serialized non-variant slide contract exactly. The
      // native navigation runtime releases inactive React roots and rebuilds
      // them from slides[].props after a page change. Supplying the pre-
      // projection variant props here creates two sources of truth: the first
      // mount reads data-prop-defaults, while every remount reads stale props.
      // Both fields therefore carry the same authored, content-projected
      // source just as buildDeckViewModel()/serializeDeckViewModel() do.
      props: structuredClone(materializedProps),
      materializedProps: structuredClone(materializedProps),
    };
  });
  return {
    version: 1,
    title: deck.title,
    themePack: deck.theme,
    slides,
    state: {
      slideOrder: deck.state?.slideOrder || slides.map((slide) => slide.id),
      text: structuredClone(deck.state?.text || {}),
      media: structuredClone(deck.state?.media || {}),
      props: stateProps,
      variantSelection: {},
    },
  };
}

function projectContent(base, content, contentMap) {
  const result = structuredClone(base || {});
  for (const [target, source] of Object.entries(contentMap || {})) {
    if (typeof source !== 'string') continue;
    const value = readPath(content, source.replace(/^content\./, ''));
    if (value !== undefined) writePath(result, target, value);
  }
  return result;
}

function pathTokens(path) {
  return [...String(path).matchAll(/([A-Za-z_$][\w$-]*)|\[(\d+)\]/g)]
    .map((match) => match[1] ?? Number(match[2]));
}

function readPath(value, path) {
  let current = value;
  for (const token of pathTokens(path)) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[token];
  }
  return current;
}

function writePath(target, path, value) {
  const tokens = pathTokens(path);
  if (!tokens.length) return;
  let current = target;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];
    if (!current[token] || typeof current[token] !== 'object') current[token] = typeof nextToken === 'number' ? [] : {};
    current = current[token];
  }
  current[tokens.at(-1)] = structuredClone(value);
}

function slideMarkup(slide, index, runtimeCatalog) {
  const row = runtimeCatalog?.layouts?.[slide.layout] || {};
  const controls = JSON.stringify(row.controls || []);
  const defaults = JSON.stringify(row.defaultProps || {});
  const bgClass = row.bgClass ? ` ${escapeAttribute(row.bgClass)}` : '';
  return `<section class="slide imported-theme-slide${bgClass}" data-layout="${escapeAttribute(slide.dataLayout)}" data-vm-slide-id="${escapeAttribute(slide.id)}" data-vm-slide-key="${escapeAttribute(slide.key)}" data-vm-layout="${escapeAttribute(slide.layout)}" data-vm-index="${index}" data-theme-pack="${escapeAttribute(slide.themePack)}" data-logical-slide="${index}" data-label="${escapeAttribute(slide.label)}"><div class="imported-theme-root" data-theme-key="${escapeAttribute(row.themePack || slide.themePack)}" data-page-key="${escapeAttribute(slide.layout)}" data-prop-controls="${escapeAttribute(controls)}" data-prop-defaults="${escapeAttribute(defaults)}"></div></section>`;
}

function persistenceBridge() {
  return `<script>(function(){var nativeFetch=window.fetch.bind(window);var pending=new Map();var sequence=0;window.addEventListener('message',function(event){if(event.origin!==window.location.origin||event.data?.type!=='${SAVE_MESSAGE}:result')return;var settle=pending.get(event.data.requestId);if(!settle)return;pending.delete(event.data.requestId);settle(new Response(JSON.stringify(event.data.ok?{ok:true}:{error:event.data.error||'save_failed'}),{status:event.data.ok?200:(event.data.status||500),headers:{'content-type':'application/json'}}));});window.fetch=function(input,init){var url=typeof input==='string'?input:(input&&input.url)||'';if(url==='/api/save-deck-state'){try{var body=JSON.parse((init&&init.body)||'{}');var requestId=String(++sequence);return new Promise(function(resolve){pending.set(requestId,resolve);window.parent.postMessage({type:'${SAVE_MESSAGE}',requestId:requestId,state:body.state},window.location.origin);setTimeout(function(){if(!pending.has(requestId))return;pending.delete(requestId);resolve(new Response(JSON.stringify({error:'save_timeout'}),{status:504,headers:{'content-type':'application/json'}}));},30000);});}catch(error){return Promise.resolve(new Response(JSON.stringify({error:'invalid_state'}),{status:400,headers:{'content-type':'application/json'}}));}}return nativeFetch(input,init);};})();</script>`;
}

function jsonScript(id, value) {
  return `<script id="${id}" type="application/json">${JSON.stringify(value).replaceAll('<', '\\u003c')}</script>`;
}

function readJsonScript(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(html).match(new RegExp(`<script id="${escaped}" type="application/json">([\\s\\S]*?)<\\/script>`));
  if (!match) throw new Error('presentation_html_artifact_invalid');
  return JSON.parse(match[1]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
