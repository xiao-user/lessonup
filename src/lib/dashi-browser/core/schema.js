const DECK_SCHEMA = 'dashi.browser.deck/v1';
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function normalizeDeck(input = {}) {
  const deck = cloneJson(input);
  deck.schema = deck.schema || DECK_SCHEMA;
  deck.id = String(deck.id || `deck-${cryptoRandomId()}`);
  deck.title = String(deck.title || 'Untitled deck');
  deck.theme = normalizeTheme(deck.theme || deck.themePack || 'theme01');
  deck.slides = Array.isArray(deck.slides) ? deck.slides.map((slide, index) => normalizeSlide(slide, index, deck.theme)) : [];
  deck.state = normalizeState(deck.state, deck.slides);
  return deck;
}

export function validateDeck(input) {
  const errors = [];
  let deck;
  try {
    deck = normalizeDeck(input);
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
  if (!deck.slides.length) errors.push('deck.slides must contain at least one slide');
  const ids = new Set();
  for (const [index, slide] of deck.slides.entries()) {
    if (ids.has(slide.id)) errors.push(`slides[${index}].id is duplicated: ${slide.id}`);
    ids.add(slide.id);
    if (!slide.variants.length) errors.push(`slides[${index}] has no variants`);
    for (const [variantIndex, variant] of slide.variants.entries()) {
      if (variant.kind === 'template' && !variant.layout) {
        errors.push(`slides[${index}].variants[${variantIndex}] template variant requires layout`);
      }
      if (variant.kind === 'bespoke' && !variant.composition) {
        errors.push(`slides[${index}].variants[${variantIndex}] bespoke variant requires composition`);
      }
    }
  }
  return { ok: errors.length === 0, errors, deck };
}

export function selectedVariant(deck, slide) {
  const stateId = deck.state?.variantSelection?.[slide.id];
  if (stateId) {
    const selected = slide.variants.find((variant) => variant.stateId === stateId || variant.id === stateId);
    if (selected) return selected;
  }
  if (slide.selectedVariant) {
    const selected = slide.variants.find((variant) => variant.id === slide.selectedVariant || variant.stateId === slide.selectedVariant);
    if (selected) return selected;
  }
  return slide.variants[0];
}

export function normalizeTheme(value) {
  const match = String(value || '').trim().match(/^theme(\d{1,2})$/i);
  if (!match) throw new Error(`Invalid Dashi theme: ${value}`);
  const n = Number(match[1]);
  if (n < 1 || n > 12) throw new Error(`Dashi theme must be theme01..theme12: ${value}`);
  return `theme${String(n).padStart(2, '0')}`;
}

function normalizeSlide(input = {}, index, deckTheme) {
  const slide = cloneJson(input);
  slide.id = String(slide.id || `slide-${index + 1}`);
  slide.label = String(slide.label || `Slide ${index + 1}`);
  slide.content = isPlainRecord(slide.content) ? slide.content : {};
  const authoredVariants = Array.isArray(slide.variants) && slide.variants.length
    ? slide.variants
    : [slide];
  slide.variants = authoredVariants.map((variant, variantIndex) => normalizeVariant(variant, variantIndex, slide, deckTheme));
  slide.selectedVariant = slide.selectedVariant || slide.variants[0]?.id || null;
  return slide;
}

function normalizeVariant(input = {}, index, slide, deckTheme) {
  const variant = cloneJson(input);
  const kind = variant.kind || (variant.composition ? 'bespoke' : 'template');
  if (!['template', 'bespoke'].includes(kind)) throw new Error(`Invalid variant kind: ${kind}`);
  variant.kind = kind;
  variant.id = String(variant.id || `v${index + 1}`);
  variant.stateId = String(variant.stateId || `${slide.id}::${variant.id}`);
  variant.variantIndex = index;
  variant.variantCount = Array.isArray(slide.variants) ? slide.variants.length : 1;
  variant.themePack = normalizeTheme(variant.themePack || variant.theme || slide.themePack || slide.theme || deckTheme);
  variant.label = String(variant.label || `${slide.label} · ${variant.id}`);
  if (kind === 'template') {
    variant.layout = String(variant.layout || variant.layoutName || slide.layout || '');
    variant.props = isPlainRecord(variant.props) ? variant.props : (isPlainRecord(slide.props) ? slide.props : {});
    variant.contentMap = isPlainRecord(variant.contentMap) ? variant.contentMap : (isPlainRecord(slide.contentMap) ? slide.contentMap : {});
  } else {
    variant.adjustable = false;
    variant.composition = isPlainRecord(variant.composition) ? variant.composition : {};
    variant.contentMap = isPlainRecord(variant.contentMap) ? variant.contentMap : {};
  }
  return variant;
}

function normalizeState(input, slides) {
  const state = isPlainRecord(input) ? cloneJson(input) : {};
  state.slideOrder = Array.isArray(state.slideOrder) ? state.slideOrder : slides.map((slide) => slide.id);
  state.props = isPlainRecord(state.props) ? state.props : {};
  state.text = isPlainRecord(state.text) ? state.text : {};
  state.media = isPlainRecord(state.media) ? state.media : {};
  state.variantSelection = isPlainRecord(state.variantSelection) ? state.variantSelection : Object.fromEntries(
    slides.map((slide) => [slide.id, slide.variants.find((v) => v.id === slide.selectedVariant)?.stateId || slide.variants[0]?.stateId]),
  );
  return state;
}

export function cloneJson(value) {
  scanUnsafe(value);
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function scanUnsafe(value, path = 'value', active = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (active.has(value)) throw new Error(`${path}: circular values are not supported`);
  active.add(value);
  try {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) throw new Error(`${path}: unsafe key ${key}`);
      scanUnsafe(child, `${path}.${key}`, active);
    }
  } finally {
    active.delete(value);
  }
}

function isPlainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}
