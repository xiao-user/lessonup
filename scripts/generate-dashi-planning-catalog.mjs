#!/usr/bin/env node
/**
 * Precompute Dashi layout inspect/query rows so Cloudflare Workers can plan
 * classroom decks without execFile, Node scripts, or Chromium.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectLayout } from "../server/agent/skills/dashi-ppt/project/scripts/workflow/inspect-fillplan.mjs";
import { THEME_PAGES } from "../server/agent/skills/dashi-ppt/project/scripts/workflow/theme-registry.mjs";
import { canonicalizeThemePageRuntime } from "../server/agent/skills/dashi-ppt/project/src/components/themes/canonical-metadata.mjs";

const outDir = path.resolve(import.meta.dirname, "../public/dashi/planning");
const runtimeOutDir = path.resolve(import.meta.dirname, "../public/dashi/runtime");
await mkdir(outDir, { recursive: true });
await mkdir(runtimeOutDir, { recursive: true });

const byTheme = new Map();
const runtimeByTheme = new Map();
for (const page of THEME_PAGES) {
  const inspected = inspectLayout(page.key, { compact: true });
  if (!inspected) continue;
  const runtime = canonicalizeThemePageRuntime(page);
  const theme = inspected.theme || page.themeKey;
  const rows = byTheme.get(theme) ?? [];
  rows.push(inspected);
  byTheme.set(theme, rows);

  const runtimeRows = runtimeByTheme.get(theme) ?? {};
  runtimeRows[page.key] = {
    key: page.key,
    themePack: page.themeKey,
    dataLayout: runtime.page.layout,
    label: runtime.page.label,
    bgClass: runtime.page.bgClass || "",
    // Use the exact contract consumed by makeImportedThemePage. The compact
    // planning catalog intentionally drops select options and other editor
    // metadata, so it must never feed data-prop-controls.
    controls: runtime.controls,
    defaultProps: runtime.defaults,
  };
  runtimeByTheme.set(theme, runtimeRows);
}

const index = [];
for (const [theme, layouts] of [...byTheme.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  const file = `${theme}.json`;
  await writeFile(path.join(outDir, file), `${JSON.stringify({ theme, layouts })}\n`);
  index.push({ theme, file, count: layouts.length });
  console.log(`Wrote ${file} (${layouts.length} layouts)`);
}

for (const [theme, layouts] of [...runtimeByTheme.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  await writeFile(
    path.join(runtimeOutDir, `${theme}.json`),
    `${JSON.stringify({ version: 1, theme, layouts })}\n`,
  );
}

await writeFile(path.join(outDir, "index.json"), `${JSON.stringify({ version: 1, themes: index }, null, 2)}\n`);
console.log(`Dashi planning catalog: ${index.reduce((total, item) => total + item.count, 0)} layouts`);
