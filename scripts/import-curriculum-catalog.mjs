import "dotenv/config";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data", "curriculum");
const batchSize = 500;

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error("supabase_credentials_missing");
}

const client = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function readJsonlGz(filePath) {
  await access(filePath);
  const stream = createReadStream(filePath).pipe(createGunzip());
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const rows = [];
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

async function upsertBatches(table, rows, onConflict) {
  for (let index = 0; index < rows.length; index += batchSize) {
    const chunk = rows.slice(index, index + batchSize);
    const { error } = await client.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`${table}_upsert_failed: ${error.message}`);
    process.stdout.write(`\r${table}: ${Math.min(index + chunk.length, rows.length)}/${rows.length}`);
  }
  process.stdout.write("\n");
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const manifest = JSON.parse(await readFile(path.join(dataDir, "manifest.json"), "utf8"));
if (manifest.schema_version !== 2) throw new Error("curriculum_manifest_schema_unsupported");
const booksPath = path.join(dataDir, manifest.files.textbooks.path);
const nodesPath = path.join(dataDir, manifest.files.nodes.path);
const [booksHash, nodesHash] = await Promise.all([
  sha256File(booksPath),
  sha256File(nodesPath),
]);
if (booksHash !== manifest.files.textbooks.sha256 || nodesHash !== manifest.files.nodes.sha256) {
  throw new Error("curriculum_manifest_hash_mismatch");
}
const generationId = createHash("sha256")
  .update(`${booksHash}:${nodesHash}`)
  .digest("hex");
const { data: currentState, error: stateError } = await client
  .from("curriculum_catalog_state")
  .select("generation_id")
  .eq("singleton", true)
  .maybeSingle();
if (stateError) throw new Error(`curriculum_state_read_failed: ${stateError.message}`);
if (currentState?.generation_id === generationId) {
  console.log(JSON.stringify({ generation_id: generationId, status: "already_current" }, null, 2));
  process.exit(0);
}

const textbooks = await readJsonlGz(booksPath);
const nodes = await readJsonlGz(nodesPath);
if (textbooks.length !== manifest.textbooks || nodes.length !== manifest.nodes) {
  throw new Error("curriculum_manifest_count_mismatch");
}
const importId = randomUUID();

const textbookRows = textbooks.map((book) => ({
  import_id: importId,
  id: book.id,
  title: book.title,
  stage: book.stage,
  subject: book.subject,
  edition: book.edition,
  grade: book.grade,
  volume: book.volume ?? "",
  publisher_id: book.publisher_id ?? "",
  ebook_id: book.ebook_id ?? null,
  detail_url: book.detail_url ?? null,
  tree_url: book.tree_url ?? null,
  source_pdf_url: book.source_pdf_url ?? null,
  source_list_url: book.source_list_url ?? null,
  node_count: book.node_count ?? 0,
  source_updated_at: book.source_updated_at ?? null,
  updated_at: new Date().toISOString(),
}));

const nodeRows = nodes.map((node) => ({
  import_id: importId,
  textbook_id: node.textbook_id,
  node_id: node.node_id,
  parent_id: node.parent_id ?? null,
  level: node.level,
  sort_no: node.sort_no,
  title: node.title,
  page_number: node.page_number ?? null,
}));

try {
  await upsertBatches("curriculum_textbooks_staging", textbookRows, "import_id,id");
  await upsertBatches("curriculum_nodes_staging", nodeRows, "import_id,textbook_id,node_id");
  const { error } = await client.rpc("publish_curriculum_catalog", {
    p_import_id: importId,
    p_generation_id: generationId,
    p_expected_textbooks: manifest.textbooks,
    p_expected_nodes: manifest.nodes,
    p_manifest: manifest,
  });
  if (error) throw new Error(`curriculum_publish_failed: ${error.message}`);
  console.log(JSON.stringify({
    generation_id: generationId,
    imported_textbooks: textbookRows.length,
    imported_nodes: nodeRows.length,
  }, null, 2));
} catch (error) {
  await Promise.allSettled([
    client.from("curriculum_nodes_staging").delete().eq("import_id", importId),
    client.from("curriculum_textbooks_staging").delete().eq("import_id", importId),
  ]);
  throw error;
}
