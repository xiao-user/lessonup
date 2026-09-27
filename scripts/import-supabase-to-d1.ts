import { execFileSync } from "node:child_process";

type SourceRow = Record<string, unknown>;
type D1Column = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type ImportPlan = {
  target: string;
  source?: string;
  select?: (source: ReadonlyMap<string, SourceRow[]>) => SourceRow[];
};

const apply = process.argv.includes("--apply");
const ownerId = argumentValue("--owner-id") ?? sourceOwnerId();
const sourceRows = new Map<string, SourceRow[]>();
const targetColumnsByTable = new Map<string, D1Column[]>();
const targetRowCounts = new Map<string, number>();

const plans: ImportPlan[] = [
  { target: "curriculum_catalog_releases", source: "curriculum_catalog_releases" },
  { target: "curriculum_catalog_current", source: "curriculum_catalog_current" },
  { target: "curriculum_textbooks", source: "curriculum_textbooks" },
  { target: "curriculum_nodes", source: "curriculum_nodes" },
  { target: "curriculum_standard_releases", source: "curriculum_standard_releases" },
  { target: "curriculum_standard_documents", source: "curriculum_standard_documents" },
  {
    target: "curriculum_standard_chunks",
    select: (source) => {
      const documentsBySource = new Map(
        (source.get("curriculum_standard_documents") ?? [])
          .filter((document) => typeof document.knowledge_source_id === "string")
          .map((document) => [document.knowledge_source_id as string, document]),
      );
      return (source.get("knowledge_chunks") ?? [])
        .filter((chunk) => documentsBySource.has(String(chunk.source_id)))
        .map((chunk) => ({
          ...chunk,
          document_id: documentsBySource.get(String(chunk.source_id))?.id,
        }));
    },
  },
  { target: "curriculum_semantic_releases", source: "curriculum_semantic_releases" },
  { target: "curriculum_semantic_entities", source: "curriculum_semantic_entities" },
  { target: "curriculum_semantic_entity_revisions", source: "curriculum_semantic_entity_revisions" },
  { target: "curriculum_semantic_relations", source: "curriculum_semantic_relations" },
  { target: "curriculum_node_semantics", source: "curriculum_node_semantics" },
  { target: "curriculum_semantic_sources", source: "curriculum_semantic_sources" },
  { target: "curriculum_semantic_entity_sources", source: "curriculum_semantic_entity_sources" },
  { target: "curriculum_semantic_relation_sources", source: "curriculum_semantic_relation_sources" },
  { target: "curriculum_node_semantic_sources", source: "curriculum_node_semantic_sources" },
  { target: "notebooks", source: "notebooks" },
  { target: "lesson_files", source: "lesson_files" },
  { target: "lesson_file_versions", source: "lesson_file_versions" },
  { target: "knowledge_sources", source: "knowledge_sources" },
  { target: "knowledge_chunks", source: "knowledge_chunks" },
  { target: "semester_frameworks", source: "semester_frameworks" },
  { target: "semester_units", source: "semester_units" },
  { target: "lesson_blueprints", source: "lesson_blueprints" },
  { target: "semester_framework_versions", source: "semester_framework_versions" },
  { target: "lesson_design_bases", source: "lesson_design_bases" },
  {
    target: "lesson_design_basis_entries",
    select: (source) => {
      const basisIds = new Set((source.get("lesson_design_bases") ?? []).map((basis) => basis.id));
      const entries = source.get("lesson_design_basis_entries") ?? [];
      const validEntries = entries.filter((entry) => basisIds.has(entry.basis_id));
      const skipped = entries.length - validEntries.length;
      if (skipped) {
        console.warn(`Skipping ${skipped} legacy design-basis entries without a parent basis.`);
      }
      return validEntries;
    },
  },
  { target: "lesson_design_basis_versions", source: "lesson_design_basis_versions" },
  { target: "framework_outcome_selections", source: "framework_outcome_selections" },
  { target: "framework_continuity_candidates", source: "framework_continuity_candidates" },
  { target: "framework_continuity_decisions", source: "framework_continuity_decisions" },
  { target: "lesson_class_feedback", source: "lesson_class_feedback" },
  { target: "classroom_presentation_documents", source: "classroom_presentation_documents" },
  { target: "classroom_presentation_generations", source: "classroom_presentation_generations" },
  { target: "agent_threads", source: "agent_threads" },
  { target: "agent_branches", source: "agent_branches" },
  { target: "agent_messages", source: "agent_messages" },
  { target: "agent_runs", source: "agent_runs" },
  { target: "agent_events", source: "agent_events" },
  { target: "agent_run_evidence", source: "agent_run_evidence" },
  { target: "agent_thread_memories", source: "agent_thread_memories" },
];

const specialColumns: Record<string, Record<string, (row: SourceRow) => unknown>> = {
  curriculum_catalog_current: { updated_at: (row) => row.activated_at },
  curriculum_textbooks: { catalog_release_id: catalogReleaseId },
  curriculum_nodes: { catalog_release_id: catalogReleaseId },
  curriculum_standard_documents: {
    index_version: (row) => linkedKnowledgeSource(row)?.index_version ?? "legacy-import",
    updated_at: (row) => linkedKnowledgeSource(row)?.updated_at ?? row.created_at,
  },
  curriculum_standard_chunks: {
    document_id: (row) => row.document_id,
    grade_start: () => null,
    grade_end: () => null,
    // Source vectors are tied to the retired Supabase indexing pipeline.
    // Preserve the canonical passages and re-embed them in the Cloudflare
    // worker instead of importing stale, high-volume vector payloads.
    embedding_json: () => null,
  },
  knowledge_chunks: { embedding_json: () => null },
  agent_events: { event_type: (row) => row.type },
  agent_branches: { pending_interaction_json: (row) => row.pending_interaction },
  agent_session_items: { sequence_no: (row) => row.sequence },
  agent_threads: {
    resource_type: (row) => row.resource_type ?? (row.semester_framework_id ? "semester_framework" : "lesson_file"),
  },
  classroom_presentation_documents: {
    dashi_goal_json: (row) => row.outline,
    delivery: (row) => row.delivery === "native-dashi" ? "native-dashi" : "legacy-static",
  },
};

await main();

async function main() {
  console.log(`${apply ? "Applying" : "Dry-running"} Supabase → D1 import for owner ${ownerId}.`);
  await verifyRemoteOwner();
  await loadD1Columns();
  await loadSourceRows();
  if (apply) {
    await loadTargetRowCounts();
  }

  let total = 0;
  for (const plan of plans) {
    const rows = plan.select ? plan.select(sourceRows) : sourceRows.get(plan.source ?? plan.target) ?? [];
    const columns = d1Columns(plan.target);
    const sourceCount = rows.length;
    total += sourceCount;
    if (apply && targetRowCounts.get(plan.target) === sourceCount) {
      console.log(`${plan.target}: ${sourceCount} rows (already complete)`);
      continue;
    }
    const pendingRows = await rowsNotYetImported(plan.target, columns, rows);
    console.log(`${plan.target}: ${pendingRows.length} pending of ${sourceCount} rows`);
    const statements = pendingRows.map((row) => insertStatement(plan.target, columns, row));
    if (apply && statements.length > 0) {
      await executeBatches(plan.target, statements);
    }
  }
  console.log(`${apply ? "Imported" : "Validated"} ${total} records across ${plans.length} D1 tables.`);
}

async function rowsNotYetImported(table: string, columns: D1Column[], rows: SourceRow[]) {
  if (!apply || targetRowCounts.get(table) === 0 || !columns.some((column) => column.name === "id")) {
    return rows;
  }
  if (!rows.every((row) => typeof row.id === "string")) {
    return rows;
  }
  const result = await wranglerJson(`SELECT id FROM ${identifier(table)};`);
  const existing = new Set(
    ((result[0]?.results ?? []) as Array<{ id: string }>).map((row) => row.id),
  );
  return rows.filter((row) => !existing.has(row.id as string));
}

function sourceOwnerId() {
  return execFileSync("docker", [
    "exec", "supabase_db_lessonup", "psql", "-U", "postgres", "-d", "postgres", "-At",
    "-c", "SELECT id::text FROM auth.users ORDER BY created_at LIMIT 1;",
  ], { encoding: "utf8" }).trim();
}

async function verifyRemoteOwner() {
  const result = await wranglerJson("SELECT id FROM users WHERE id = " + sqlLiteral(ownerId) + ";");
  if (result[0]?.results?.length !== 1) {
    throw new Error(`D1 user ${ownerId} does not exist. Provision the login before importing data.`);
  }
}

async function loadSourceRows() {
  const tables = new Set(plans.flatMap((plan) => plan.source ? [plan.source] : []));
  tables.add("knowledge_chunks");
  for (const table of tables) {
    const output = execFileSync("docker", [
      "exec", "supabase_db_lessonup", "psql", "-U", "postgres", "-d", "postgres", "-At",
      "-c", `SELECT row_to_json(source_row)::text FROM public.${identifier(table)} AS source_row;`,
    ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    sourceRows.set(table, output.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SourceRow));
  }
}

async function loadD1Columns() {
  const tables = [...new Set(plans.map((plan) => plan.target))];
  const result = await wranglerJson(tables.map((table) => `PRAGMA table_info(${sqlLiteral(table)});`).join("\n"));
  for (const [index, table] of tables.entries()) {
    const columns = result[index]?.results as D1Column[] | undefined;
    if (!columns?.length) {
      throw new Error(`D1 table ${table} does not exist.`);
    }
    targetColumnsByTable.set(table, columns);
  }
}

function d1Columns(table: string) {
  const columns = targetColumnsByTable.get(table);
  if (!columns) {
    throw new Error(`D1 columns for ${table} were not loaded.`);
  }
  return columns;
}

async function loadTargetRowCounts() {
  const tables = [...new Set(plans.map((plan) => plan.target))];
  for (const group of chunk(tables, 3)) {
    const command = group.map((table) => (
      `SELECT ${sqlLiteral(table)} AS table_name, count(*) AS row_count FROM ${identifier(table)}`
    )).join(" UNION ALL ");
    const rows = (await wranglerJson(command))[0]?.results as Array<{ table_name: string; row_count: number }> | undefined;
    for (const row of rows ?? []) {
      targetRowCounts.set(row.table_name, Number(row.row_count));
    }
  }
}

function chunk<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => (
    items.slice(index * size, (index + 1) * size)
  ));
}

async function wranglerJson(command: string) {
  const args = ["wrangler", "d1", "execute", "lessonup", "--remote", "--command", command, "--json"];
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const output = execFileSync("npx", args, {
        cwd: new URL("..", import.meta.url), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
      });
      return JSON.parse(output) as Array<{ results?: unknown[] }>;
    } catch (error) {
      if (attempt === maxAttempts || !isCloudflareFetchFailure(error)) {
        throw new Error(`D1 import batch ${table}/${index} failed: ${wranglerFailureSummary(error)}`);
      }
      console.warn(`Cloudflare request failed; retrying (${attempt}/${maxAttempts}).`);
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw new Error("Cloudflare request did not return a result.");
}

function wranglerFailureSummary(error: unknown) {
  const output = typeof error === "object" && error !== null && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr)
    : String(error);
  const firstLine = output.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine || "unknown Wrangler error";
}

function isCloudflareFetchFailure(error: unknown) {
  const output = typeof error === "object" && error !== null && "stdout" in error
    ? String((error as { stdout?: unknown }).stdout)
    : "";
  return `${String(error)}\n${output}`.includes("fetch failed");
}

function insertStatement(table: string, columns: D1Column[], row: SourceRow) {
  const values = columns.flatMap((column) => {
    const value = columnValue(table, column.name, row);
    if (value === undefined) {
      if (column.notnull && column.dflt_value === null) {
        throw new Error(`${table}.${column.name} is required but has no compatible source value.`);
      }
      return [];
    }
    if (value === null && column.notnull) {
      throw new Error(`${table}.${column.name} is required but source data is null.`);
    }
    return [[column.name, value] as const];
  });
  if (!values.length) {
    throw new Error(`${table} row has no importable values.`);
  }
  return `INSERT INTO ${identifier(table)} (${values.map(([column]) => identifier(column)).join(", ")}) VALUES (${values.map(([, value]) => sqlLiteral(normalizeValue(value))).join(", ")}) ON CONFLICT DO NOTHING;`;
}

function columnValue(table: string, column: string, row: SourceRow): unknown | undefined {
  const custom = specialColumns[table]?.[column];
  if (custom) {
    return custom(row);
  }
  if (column.endsWith("_json")) {
    const jsonSourceColumn = column.slice(0, -5);
    if (jsonSourceColumn in row) {
      return asJson(row[jsonSourceColumn]);
    }
  }
  if (column in row) {
    const value = row[column];
    if (column === "owner_id" && value === null) {
      return ownerId;
    }
    return value;
  }
  return undefined;
}

function catalogReleaseId(row: SourceRow) {
  if (typeof row.catalog_release_id === "string") {
    return row.catalog_release_id;
  }
  const releases = sourceRows.get("curriculum_catalog_releases") ?? [];
  const release = releases.find(
    (candidate) => candidate.generation_id === row.catalog_generation_id,
  );
  if (typeof release?.id === "string") {
    return release.id;
  }
  // The legacy catalog importer tagged each textbook/node with `legacy` while
  // retaining one complete published release. Map that single snapshot
  // explicitly instead of fabricating a release identifier per record.
  return releases.length === 1 ? releases[0]?.id : undefined;
}

function linkedKnowledgeSource(row: SourceRow) {
  return (sourceRows.get("knowledge_sources") ?? []).find((source) => source.id === row.knowledge_source_id);
}

function asJson(value: unknown) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value ?? {});
}

function normalizeValue(value: unknown): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot import a non-finite number.");
    }
    return value;
  }
  return String(value);
}

async function executeBatches(table: string, statements: string[]) {
  const maxBytes = table.endsWith("_chunks") ? 60_000 : 160_000;
  let batch: string[] = [];
  let bytes = 0;
  let batchIndex = 0;
  for (const statement of statements) {
    if (batch.length && bytes + statement.length > maxBytes) {
      await executeBatch(table, batchIndex++, batch);
      batch = [];
      bytes = 0;
    }
    batch.push(statement);
    bytes += statement.length;
  }
  if (batch.length) {
    await executeBatch(table, batchIndex, batch);
  }
}

async function executeBatch(table: string, index: number, statements: string[]) {
  const args = ["wrangler", "d1", "execute", "lessonup", "--remote", "--command", statements.join("\n")];
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      execFileSync("npx", args, {
        cwd: new URL("..", import.meta.url), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 750));
      return;
    } catch (error) {
      if (attempt === maxAttempts || !isCloudflareFetchFailure(error)) {
        throw error;
      }
      console.warn(`Cloudflare import batch ${table}/${index} failed; retrying (${attempt}/${maxAttempts}).`);
    }
  }
}

function argumentValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function identifier(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return value;
}

function sqlLiteral(value: string | number | null) {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}
