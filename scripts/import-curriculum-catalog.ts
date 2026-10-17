/**
 * Loads the SmartEdu textbook catalog in data/curriculum into D1.
 *
 * Usage:
 *   npm run curriculum:import                # local Wrangler D1
 *   npm run curriculum:import -- --remote    # production D1
 *   npm run curriculum:import -- --persist-to <dir>   # isolated local state
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import type { CurriculumNodeRecord, CurriculumTextbookRecord } from "../server/domain.js";
import { importCurriculumCatalog } from "../server/repositories/d1-curriculum-import.js";
import { d1TargetFromArguments, describeD1Target, openD1 } from "./lib/wrangler-d1.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data", "curriculum");

async function readJsonlGz(filePath: string) {
  await access(filePath);
  const lines = createInterface({ input: createReadStream(filePath).pipe(createGunzip()), crlfDelay: Infinity });
  const rows: Array<Record<string, unknown>> = [];
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) rows.push(JSON.parse(trimmed) as Record<string, unknown>);
  }
  return rows;
}

async function sha256File(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const optionalString = (value: unknown) => (value == null ? null : String(value));

const manifest = JSON.parse(await readFile(path.join(dataDir, "manifest.json"), "utf8")) as {
  schema_version: number;
  textbooks: number;
  nodes: number;
  files: { textbooks: { path: string; sha256: string }; nodes: { path: string; sha256: string } };
};
if (manifest.schema_version !== 2) throw new Error("curriculum_manifest_schema_unsupported");
const booksPath = path.join(dataDir, manifest.files.textbooks.path);
const nodesPath = path.join(dataDir, manifest.files.nodes.path);
const [booksHash, nodesHash] = await Promise.all([sha256File(booksPath), sha256File(nodesPath)]);
if (booksHash !== manifest.files.textbooks.sha256 || nodesHash !== manifest.files.nodes.sha256) {
  throw new Error("curriculum_manifest_hash_mismatch");
}
const [rawTextbooks, rawNodes] = await Promise.all([readJsonlGz(booksPath), readJsonlGz(nodesPath)]);
if (rawTextbooks.length !== manifest.textbooks || rawNodes.length !== manifest.nodes) {
  throw new Error("curriculum_manifest_count_mismatch");
}

const textbooks: CurriculumTextbookRecord[] = rawTextbooks.map((book) => ({
  id: String(book.id),
  title: String(book.title),
  stage: String(book.stage),
  subject: String(book.subject),
  edition: String(book.edition),
  grade: String(book.grade),
  volume: String(book.volume ?? ""),
  publisherId: String(book.publisher_id ?? ""),
  ebookId: optionalString(book.ebook_id),
  detailUrl: optionalString(book.detail_url),
  treeUrl: optionalString(book.tree_url),
  sourcePdfUrl: optionalString(book.source_pdf_url),
  sourceListUrl: optionalString(book.source_list_url),
  nodeCount: Number(book.node_count ?? 0),
  sourceUpdatedAt: optionalString(book.source_updated_at),
}));
const nodes: CurriculumNodeRecord[] = rawNodes.map((node) => ({
  textbookId: String(node.textbook_id),
  nodeId: String(node.node_id),
  parentId: optionalString(node.parent_id),
  level: Number(node.level),
  sortNo: Number(node.sort_no),
  title: String(node.title),
  pageNumber: node.page_number == null ? null : Number(node.page_number),
}));

const target = d1TargetFromArguments(process.argv.slice(2));
console.log(`Importing ${textbooks.length} textbooks and ${nodes.length} nodes into ${describeD1Target(target)}.`);
const { db, close } = await openD1(target);
try {
  const result = await importCurriculumCatalog(db, {
    generationId: createHash("sha256").update(`${booksHash}:${nodesHash}`).digest("hex"),
    manifest,
    textbooks,
    nodes,
  }, { allowCatalogReplacement: !target.remote, onProgress: (message) => console.log(message) });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await close();
}
