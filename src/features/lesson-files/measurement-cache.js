/** Per-workspace probe results, bounded by both count and retained source size. */
export function createMeasurementCache(maxEntries = 384, maxCharacters = 300_000) {
  const entries = new Map();
  let characters = 0;
  return {
    get(key) { return entries.get(key); },
    set(key, value) {
      if (entries.has(key)) { characters -= key.length; entries.delete(key); }
      if (key.length > maxCharacters) return;
      entries.set(key, value); characters += key.length;
      while (entries.size > maxEntries || characters > maxCharacters) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest); characters -= oldest.length;
      }
    },
    clear() { entries.clear(); characters = 0; },
    get size() { return entries.size; },
  };
}
