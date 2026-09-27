#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DASHI_RUNTIME_PATCH, scopeDashiRuntimeRelease } from './dashi-runtime-compat.mjs';

const args = process.argv.slice(2);
const explicitSource = args.find((arg) => !arg.startsWith('--'));
const outIndex = args.indexOf('--out');
const outDir = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join(process.cwd(), 'public', 'dashi'));
const source = resolveUpstream(explicitSource);
if (!source) {
  console.error('Could not find Dashi PPT Skill. Pass the upstream repo or skill path:\n  npm run prepare:upstream -- /path/to/dashi-ppt-skill');
  process.exit(2);
}
const { projectRoot, repoRoot, skillRoot } = source;

console.log(`Dashi source: ${projectRoot}`);
console.log(`Output:       ${outDir}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

copyThemeRuntimes();
copyManifest();
copyRuntimeAssets();
copyThemeMedia();
copyLicenseAndNotice();
writeInventory();

console.log('Prepared Dashi assets including the unmodified native browser PPTX exporter.');

function resolveUpstream(explicit) {
  const candidates = [
    explicit || path.join(process.cwd(), 'server', 'agent', 'skills', 'dashi-ppt'),
  ].filter(Boolean).map((p) => path.resolve(p));
  for (const candidate of candidates) {
    const asRepo = path.join(candidate, 'skills', 'dashi-ppt', 'project');
    if (fs.existsSync(asRepo)) return { repoRoot: candidate, skillRoot: path.join(candidate, 'skills', 'dashi-ppt'), projectRoot: asRepo };
    const asSkill = path.join(candidate, 'project');
    if (fs.existsSync(asSkill)) return { repoRoot: findRepoRoot(candidate), skillRoot: candidate, projectRoot: asSkill };
    if (path.basename(candidate) === 'project' && fs.existsSync(candidate)) return { repoRoot: findRepoRoot(path.dirname(candidate)), skillRoot: path.dirname(candidate), projectRoot: candidate };
  }
  return null;
}

function findRepoRoot(start) {
  let current = path.resolve(start);
  for (let i = 0; i < 5; i += 1) {
    if (fs.existsSync(path.join(current, 'LICENSE')) && fs.existsSync(path.join(current, 'README.md'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function copyThemeRuntimes() {
  const from = path.join(projectRoot, 'dist', 'theme-runtime');
  const to = path.join(outDir, 'theme-runtime');
  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  for (let i = 1; i <= 12; i += 1) {
    const theme = `theme${String(i).padStart(2, '0')}`;
    const file = `imported-theme-runtime.${theme}.js`;
    const sourceFile = path.join(from, file);
    if (!fs.existsSync(sourceFile)) continue;
    fs.writeFileSync(path.join(to, file), scopeDashiRuntimeRelease(fs.readFileSync(sourceFile, 'utf8')));
    copied += 1;
  }
  if (copied < 12) {
    console.warn(`Theme runtime IIFEs present: ${copied}/12. Run npm run dashi:prepare after building upstream dist/theme-runtime.`);
  }
}

function copyManifest() {
  copyRequired(path.join(projectRoot, 'layout-manifest.json'), path.join(outDir, 'layout-manifest.json'));
}

function copyRuntimeAssets() {
  const sourceAssets = path.join(projectRoot, 'assets');
  copyTree(sourceAssets, path.join(outDir, 'assets'));
  copyRequired(path.join(sourceAssets, 'vendor/editable-pptx-browser.js'), path.join(outDir, 'assets/vendor/editable-pptx-browser.js'));
  // The native template references these public runtime dependencies directly.
  // Keep dependencies alongside the unmodified editor and export engine.
  const runtimeDependencies = [
    ['gsap/dist/gsap.min.js', 'vendor/gsap.min.js'],
    ['pptxgenjs/dist/pptxgen.bundle.js', 'vendor/pptxgen.bundle.js'],
    ['pdf-lib/dist/pdf-lib.min.js', 'vendor/pdf-lib.min.js'],
    ['html-to-image/dist/html-to-image.js', 'vendor/html-to-image.js'],
  ];
  for (const [modulePath, relativeTarget] of runtimeDependencies) {
    const sourceFile = [
      path.join(projectRoot, 'node_modules', modulePath),
      path.join(process.cwd(), 'node_modules', modulePath),
      path.join(process.cwd(), 'server', 'agent', 'skills', 'dashi-ppt', 'project', 'node_modules', modulePath),
    ].find(file => fs.existsSync(file));
    if (!sourceFile) throw new Error(`Required Dashi browser dependency is missing: ${modulePath}. Run npm ci before preparing assets.`);
    copyRequired(sourceFile, path.join(outDir, 'assets', relativeTarget));
  }
}

function copyThemeMedia() {
  const themesRoot = path.join(projectRoot, 'src', 'components', 'themes');
  if (!fs.existsSync(themesRoot)) return;
  const mediaPattern = /\.(png|jpe?g|webp|gif|svg|mp4|mov)$/i;
  const skipDirs = new Set(['uploads', 'screens', 'screenshots', 'shots', 'scratch']);
  for (let i = 1; i <= 12; i += 1) {
    const theme = `theme${String(i).padStart(2, '0')}`;
    const sourceDir = path.join(themesRoot, theme, 'source');
    if (!fs.existsSync(sourceDir)) continue;
    walk(sourceDir, (file) => {
      const relative = path.relative(sourceDir, file);
      if (relative.split(path.sep).some((part) => skipDirs.has(part.toLowerCase()))) return;
      if (!mediaPattern.test(file)) return;
      copyRequired(file, path.join(outDir, relative));
    });
  }
}

function copyLicenseAndNotice() {
  copyRequired(path.join(projectRoot, 'packages/html-deck-to-pptx/LICENSE'), path.join(outDir, 'DASHI-EXPORT-ENGINE-LICENSE.txt'));
  const license = repoRoot && path.join(repoRoot, 'LICENSE');
  if (license && fs.existsSync(license)) copyRequired(license, path.join(outDir, 'UPSTREAM-AGPL-3.0-LICENSE.txt'));
  const upstreamSkill = path.join(skillRoot, 'SKILL.md');
  const version = extractSkillVersion(upstreamSkill);
  fs.writeFileSync(path.join(outDir, 'UPSTREAM-NOTICE.txt'), [
    'Dashi PPT visual theme runtime and theme media are copied from chuspeeism/dashi-ppt-skill.',
    `Detected upstream skill version: ${version || 'unknown'}`,
    'Upstream repository: https://github.com/chuspeeism/dashi-ppt-skill',
    'Upstream main license: AGPL-3.0.',
    '',
    'Includes the unmodified assets/vendor/editable-pptx-browser.js export engine.',
    'The complete export-engine source remains in the vendored Dashi Skill.',
    'The export engine has separate proprietary licensing; see DASHI-EXPORT-ENGINE-LICENSE.txt.',
    `Theme runtime compatibility patch: ${DASHI_RUNTIME_PATCH} (restrict release to #deck children).`,
  ].join('\n'));
}

function writeInventory() {
  const runtimeFiles = fs.readdirSync(path.join(outDir, 'theme-runtime')).sort();
  const inventory = {
    preparedAt: new Date().toISOString(),
    projectRoot,
    runtimeFiles,
    hasLayoutManifest: fs.existsSync(path.join(outDir, 'layout-manifest.json')),
    hasNativePptxExporter: fs.existsSync(path.join(outDir, 'assets/vendor/editable-pptx-browser.js')),
    runtimePatches: [DASHI_RUNTIME_PATCH],
  };
  fs.writeFileSync(path.join(outDir, 'inventory.json'), JSON.stringify(inventory, null, 2));
}

function extractSkillVersion(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.match(/当前版本\s*[:：]\s*`?([\d.]+)/)?.[1] || null;
  } catch { return null; }
}

function copyRequired(from, to) {
  if (!fs.existsSync(from)) throw new Error(`Required upstream file is missing: ${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyTree(from, to, filter) {
  if (!fs.existsSync(from)) return;
  walk(from, (file) => {
    const relative = path.relative(from, file);
    if (filter && !filter(relative)) return;
    copyRequired(file, path.join(to, relative));
  });
}

function walk(dir, visitor) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file, visitor);
    else visitor(file);
  }
}
