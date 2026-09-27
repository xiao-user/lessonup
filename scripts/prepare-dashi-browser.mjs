#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillProject = path.join(root, "server", "agent", "skills", "dashi-ppt", "project");
const skipImport = process.argv.includes("--catalog-only");

if (!skipImport) {
  const imported = spawnSync(process.execPath, [path.join(root, "scripts", "import-dashi-upstream.mjs"), skillProject], {
    cwd: root,
    stdio: "inherit",
  });
  if (imported.status !== 0) process.exit(imported.status ?? 1);
}

const catalog = spawnSync(process.execPath, [path.join(root, "scripts", "generate-dashi-planning-catalog.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (catalog.status !== 0) process.exit(catalog.status ?? 1);

const publicDashi = path.join(root, "public", "dashi");
fs.mkdirSync(publicDashi, { recursive: true });
fs.writeFileSync(path.join(publicDashi, "README.txt"), [
  "This directory is populated by:",
  "",
  "  npm run dashi:prepare",
  "",
  "It contains official Dashi theme01..theme12 browser runtime bundles,",
  "layout-manifest.json, static visual assets, and a Worker-safe planning catalog.",
  "Includes the original browser PPTX exporter and its runtime dependencies.",
  "See DASHI-EXPORT-ENGINE-LICENSE.txt for its separate license terms.",
  "",
].join("\n"));

const distDashi = path.join(root, "dist", "dashi");
fs.mkdirSync(path.dirname(distDashi), { recursive: true });
fs.rmSync(distDashi, { recursive: true, force: true });
fs.cpSync(publicDashi, distDashi, { recursive: true });

console.log("Dashi browser assets are ready.");
