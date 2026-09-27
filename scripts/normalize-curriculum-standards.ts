import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeCurriculumStandard } from "../server/curriculum/standard-chunker.js";

const valueAfter = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const sourceDir = path.resolve(valueAfter("--source") ?? "data/curriculum/standards/parsed");
const outputDir = path.resolve(valueAfter("--output") ?? "data/curriculum/standards/normalized");
const files = (await readdir(sourceDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith("_by_PaddleOCR-VL-1.6.json"))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, "zh-CN"));

if (!files.length) throw new Error(`curriculum_standard_parsed_json_missing:${sourceDir}`);

const report = [];
for (const [index, filename] of files.entries()) {
  const rawText = await readFile(path.join(sourceDir, filename), "utf8");
  const normalized = normalizeCurriculumStandard({ filename, rawText });
  const outputFilename = `${normalized.document.title}.chunks.json`;
  await writeFile(path.join(outputDir, outputFilename), `${JSON.stringify(normalized, null, 2)}\n`);
  report.push({
    ...normalized.document,
    chunkCount: normalized.chunks.length,
    quality: normalized.quality,
    outputFilename,
  });
  console.log(`[${index + 1}/${files.length}] ${normalized.document.title} · ${normalized.chunks.length} chunks`);
}

await writeFile(path.join(outputDir, "normalization-report.json"), `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  documents: report,
}, null, 2)}\n`);
console.log(`规范化完成：${files.length} 份文档，报告位于 ${path.join(outputDir, "normalization-report.json")}`);
