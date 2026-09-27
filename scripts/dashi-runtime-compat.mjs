// Upstream v0.4.11 releases DOM clones as well as live React roots. Restrict
// lifecycle ownership to real deck children; keep the vendored Skill untouched.
export const DASHI_RUNTIME_PATCH = 'deck-owned-runtime-release-v1';
const upstreamSelector = '.slide.imported-theme-slide, .slide.bespoke-slide';
const deckSelector = '#deck > .slide.imported-theme-slide, #deck > .slide.bespoke-slide';

export function scopeDashiRuntimeRelease(source) {
  if (source.split(upstreamSelector).length !== 2) {
    throw new Error('Dashi runtime release selector changed; review upstream before applying compatibility patch.');
  }
  return source.replace(upstreamSelector, deckSelector);
}
