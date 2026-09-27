import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { it, expect } from 'vitest';

it('packages the untouched native editor, PPTX engine, dependencies and license', () => {
  const root = process.cwd();
  const project = path.join(root, 'server/agent/skills/dashi-ppt/project');
  const output = mkdtempSync(path.join(tmpdir(), 'lessonup-dashi-export-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/import-dashi-upstream.mjs', project, '--out', output], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    for (const file of ['template-swiss.html', 'vendor/editable-pptx-browser.js']) {
      expect(readFileSync(path.join(output, 'assets', file)).equals(readFileSync(path.join(project, 'assets', file)))).toBe(true);
    }
    for (const [moduleFile, asset] of [
      ['gsap/dist/gsap.min.js', 'gsap.min.js'],
      ['pptxgenjs/dist/pptxgen.bundle.js', 'pptxgen.bundle.js'],
      ['pdf-lib/dist/pdf-lib.min.js', 'pdf-lib.min.js'],
      ['html-to-image/dist/html-to-image.js', 'html-to-image.js'],
    ]) {
      expect(readFileSync(path.join(output, 'assets/vendor', asset)).equals(readFileSync(path.join(root, 'node_modules', moduleFile)))).toBe(true);
    }
    expect(readFileSync(path.join(output, 'DASHI-EXPORT-ENGINE-LICENSE.txt')).equals(readFileSync(path.join(project, 'packages/html-deck-to-pptx/LICENSE')))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(output, 'inventory.json'), 'utf8')).hasNativePptxExporter).toBe(true);
    for (let index = 1; index <= 12; index += 1) {
      const name = `imported-theme-runtime.theme${String(index).padStart(2, '0')}.js`;
      const original = readFileSync(path.join(project, 'dist/theme-runtime', name), 'utf8');
      const built = readFileSync(path.join(output, 'theme-runtime', name), 'utf8');
      expect(built).toBe(original.replace(
        '.slide.imported-theme-slide, .slide.bespoke-slide',
        '#deck > .slide.imported-theme-slide, #deck > .slide.bespoke-slide',
      ));
      expect(built).not.toBe(original);
    }
    expect(JSON.parse(readFileSync(path.join(output, 'inventory.json'), 'utf8')).runtimePatches).toEqual(['deck-owned-runtime-release-v1']);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 30_000);
