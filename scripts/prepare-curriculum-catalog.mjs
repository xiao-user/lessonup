/**
 * Rebuild data/curriculum from a SmartEdu scraper exports directory.
 *
 * Usage:
 *   node scripts/prepare-curriculum-catalog.mjs \
 *     --source /path/to/smartedu_output/exports
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "data", "curriculum");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourceDir = argValue("--source");
if (!sourceDir) {
  console.error("Usage: node scripts/prepare-curriculum-catalog.mjs --source <smartedu_exports_dir>");
  process.exit(1);
}

async function readJsonl(filePath) {
  const text = await readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeJsonlGz(filePath, rows) {
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
  await pipeline(Readable.from([body]), createGzip(), createWriteStream(filePath));
}

function sha256FileSyncLike(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const booksIn = await readJsonl(path.join(sourceDir, "smartedu_books.jsonl"));
const nodesIn = await readJsonl(path.join(sourceDir, "smartedu_directory_nodes.jsonl"));
const official = booksIn
  .filter((book) => book.directory_status === "official_tree")
  .sort((a, b) => a.content_id.localeCompare(b.content_id));
const officialIds = new Set(official.map((book) => book.content_id));
const nodes = nodesIn
  .filter((node) => officialIds.has(node.content_id))
  .sort((a, b) => (
    a.content_id.localeCompare(b.content_id)
    || (a.level - b.level)
    || (a.sort_no - b.sort_no)
    || a.node_id.localeCompare(b.node_id)
  ));

const counts = new Map();
const nodeIdsByBook = new Map();
for (const node of nodes) {
  counts.set(node.content_id, (counts.get(node.content_id) ?? 0) + 1);
  const ids = nodeIdsByBook.get(node.content_id) ?? new Set();
  if (ids.has(node.node_id)) throw new Error(`duplicate_node:${node.content_id}:${node.node_id}`);
  ids.add(node.node_id);
  nodeIdsByBook.set(node.content_id, ids);
}

if (officialIds.size !== official.length) throw new Error("duplicate_textbook_id");
for (const book of official) {
  const actual = counts.get(book.content_id) ?? 0;
  const expected = Number(book.directory_node_count);
  if (actual !== expected) {
    throw new Error(`node_count_mismatch:${book.content_id}:expected_${expected}:actual_${actual}`);
  }
}
for (const node of nodes) {
  if (!node.title?.trim()) throw new Error(`empty_node_title:${node.content_id}:${node.node_id}`);
  const parentId = (node.parent_id || "").trim();
  if (parentId && !nodeIdsByBook.get(node.content_id)?.has(parentId)) {
    throw new Error(`orphan_node:${node.content_id}:${node.node_id}:${parentId}`);
  }
  if (!Number.isInteger(Number(node.level)) || Number(node.level) < 1 || Number(node.level) > 8) {
    throw new Error(`invalid_node_level:${node.content_id}:${node.node_id}`);
  }
}

const textbooks = official.map((book) => ({
  id: book.content_id,
  title: (book.title || "").trim(),
  stage: (book.stage || "").trim(),
  subject: (book.subject || "").trim(),
  edition: (book.edition || "").trim(),
  grade: (book.grade || "").trim(),
  volume: (book.volume || "").trim(),
  publisher_id: (book.publisher || "").trim(),
  ebook_id: (book.ebook_id || "").trim() || null,
  detail_url: (book.detail_url || "").trim() || null,
  tree_url: (book.tree_url || "").trim() || null,
  source_pdf_url: (book.source_pdf_url || "").trim() || null,
  source_list_url: (book.source_list_url || "").trim() || null,
  node_count: counts.get(book.content_id) ?? 0,
  source_updated_at: (book.update_time || "").trim() || null,
}));

const nodeRows = nodes.map((node) => ({
  textbook_id: node.content_id,
  node_id: node.node_id,
  parent_id: (node.parent_id || "").trim() || null,
  level: Number(node.level),
  sort_no: Number(node.sort_no),
  title: (node.title || "").trim(),
  page_number: node.page_number === "" || node.page_number == null
    ? null
    : Number(node.page_number),
}));

await mkdir(outDir, { recursive: true });
const booksPath = path.join(outDir, "textbooks.jsonl.gz");
const nodesPath = path.join(outDir, "nodes.jsonl.gz");
await writeJsonlGz(booksPath, textbooks);
await writeJsonlGz(nodesPath, nodeRows);

const { readFile: readBinary } = await import("node:fs/promises");
const booksBuf = await readBinary(booksPath);
const nodesBuf = await readBinary(nodesPath);
const manifest = {
  schema_version: 2,
  source: "smartedu_national_tch_material",
  source_directory: path.basename(path.resolve(sourceDir)),
  generated_at: new Date().toISOString(),
  selection: "official_tree_only",
  textbooks: textbooks.length,
  nodes: nodeRows.length,
  files: {
    textbooks: {
      path: "textbooks.jsonl.gz",
      sha256: sha256FileSyncLike(booksBuf),
      bytes: booksBuf.length,
    },
    nodes: {
      path: "nodes.jsonl.gz",
      sha256: sha256FileSyncLike(nodesBuf),
      bytes: nodesBuf.length,
    },
  },
  stages: [...new Set(textbooks.map((book) => book.stage))].sort(),
  subjects: [...new Set(textbooks.map((book) => book.subject))].sort(),
  validation: {
    unique_textbook_ids: true,
    unique_node_ids_per_textbook: true,
    node_counts_match_source: true,
    parent_nodes_resolve: true,
  },
};
await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
