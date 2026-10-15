import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { D1SqlDatabase, type D1DatabaseBinding } from "../../server/platform/d1-sql-database.js";
import { inlineSql } from "../../server/platform/inline-sql.js";
import type { SqlDatabase, SqlResult, SqlStatement } from "../../server/platform/sql-database.js";

const repositoryRoot = new URL("../..", import.meta.url);
const wranglerConfig = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
/** A single `--command` argument must stay well below Linux's 128 KiB limit. */
const remoteCommandBytes = 90_000;

export type D1CliTarget = {
  remote: boolean;
  /** Overrides the local Wrangler state directory (the `--persist-to` layout); ignored for `--remote`. */
  persistTo?: string;
};

/**
 * Local Wrangler state is the default. Production D1 must be requested with an
 * explicit `--remote`, matching the repository rule that remote data
 * operations are separate, deliberate steps.
 */
export function d1TargetFromArguments(argv: readonly string[]): D1CliTarget {
  const remote = argv.includes("--remote");
  if (remote && argv.includes("--local")) throw new Error("d1_target_conflict");
  const persistIndex = argv.indexOf("--persist-to");
  const persistTo = persistIndex >= 0 ? argv[persistIndex + 1]?.trim() : undefined;
  if (persistIndex >= 0 && !persistTo) throw new Error("d1_persist_path_required");
  if (remote && persistTo) throw new Error("d1_target_conflict");
  return { remote, persistTo: persistTo ? path.resolve(persistTo) : undefined };
}

export function describeD1Target(target: D1CliTarget) {
  return target.remote
    ? "remote D1 (production)"
    : `local D1 (${target.persistTo ?? "default Wrangler state"})`;
}

/**
 * Opens the D1 database a maintenance script should write to.
 *
 * Local: the same `D1Database` binding a Worker gets, served in-process by
 * Wrangler's platform proxy over the state `wrangler dev` and
 * `npm run db:migrate:local` use. Bound parameters and atomic batches behave as
 * in production, without one CLI process per batch.
 *
 * Remote: `wrangler d1 execute --remote`, which is the only authenticated route
 * from a script. Its batches are not transactions.
 */
export async function openD1(target: D1CliTarget): Promise<{ db: SqlDatabase; close: () => Promise<void> }> {
  if (target.remote) return { db: new WranglerRemoteD1Database(), close: async () => {} };
  // The proxy warns that Durable Object bindings are unavailable; scripts only use D1.
  process.env.WRANGLER_LOG ??= "error";
  const proxy = await getPlatformProxy<{ LESSONUP_DB: D1DatabaseBinding }>({
    configPath: wranglerConfig,
    persist: target.persistTo ? { path: path.join(target.persistTo, "v3") } : true,
  });
  const db = new D1SqlDatabase(proxy.env.LESSONUP_DB);
  const migrated = await db.query({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'curriculum_catalog_releases'" });
  if (!migrated.rows.length) {
    await proxy.dispose();
    throw new Error("d1_local_not_migrated: run `npm run db:migrate:local` first");
  }
  return { db, close: () => proxy.dispose() };
}

/**
 * `SqlDatabase` over `wrangler d1 execute --remote`. The CLI has no bound
 * parameters, so each statement is inlined as literals first. A `batch` may span
 * several CLI invocations to respect size limits and is NOT a transaction:
 * callers must stay idempotent and flip visibility with a final small batch.
 */
export class WranglerRemoteD1Database implements SqlDatabase {
  constructor(private readonly database = "lessonup") {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(statement: SqlStatement): Promise<SqlResult<Row>> {
    const [result] = this.execute([statement]);
    return (result ?? { rows: [], rowsAffected: 0 }) as SqlResult<Row>;
  }

  async batch<Row extends Record<string, unknown> = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlResult<Row>[]> {
    if (!statements.length) return [];
    return this.execute(statements) as SqlResult<Row>[];
  }

  private execute(statements: readonly SqlStatement[]): SqlResult[] {
    const results: SqlResult[] = [];
    let chunk: string[] = [];
    let bytes = 0;
    for (const statement of statements) {
      const sql = `${inlineSql(statement.sql, statement.params).trim().replace(/;+$/, "")};`;
      if (chunk.length && bytes + sql.length > remoteCommandBytes) {
        results.push(...this.run(chunk.join("\n")));
        chunk = [];
        bytes = 0;
      }
      chunk.push(sql);
      bytes += sql.length;
    }
    if (chunk.length) results.push(...this.run(chunk.join("\n")));
    return results;
  }

  private run(sql: string): SqlResult[] {
    const args = [
      "wrangler", "d1", "execute", this.database, "--config", "wrangler.jsonc", "--remote", "--json", "--command", sql,
    ];
    const attempts = 6;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const stdout = execFileSync("npx", args, {
          cwd: repositoryRoot,
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return parseWranglerResults(stdout);
      } catch (error) {
        if (attempt < attempts && isCloudflareFetchFailure(error)) {
          console.warn(`Cloudflare request failed; retrying (${attempt}/${attempts}).`);
          sleepSync(attempt * 2_000);
          continue;
        }
        throw new Error(`d1_cli_failed: ${failureSummary(error)}`);
      }
    }
  }
}

function parseWranglerResults(stdout: string): SqlResult[] {
  const start = stdout.startsWith("[") ? 0 : stdout.indexOf("\n[") + 1;
  const parsed = JSON.parse(stdout.slice(start)) as Array<{
    results?: Record<string, unknown>[];
    meta?: { changes?: number };
  }>;
  return parsed.map((entry) => ({ rows: entry.results ?? [], rowsAffected: entry.meta?.changes ?? 0 }));
}

function failureSummary(error: unknown) {
  const source = error as { stdout?: unknown; stderr?: unknown };
  for (const output of [source.stdout, source.stderr]) {
    const text = typeof output === "string" ? output.trim() : "";
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as { error?: { text?: string; message?: string } };
      const message = parsed.error?.text ?? parsed.error?.message;
      if (message) return message;
    } catch {
      // Plain-text failure: fall through to the first non-empty line.
    }
    const line = text.split("\n").map((value) => value.trim()).find(Boolean);
    if (line) return line;
  }
  return error instanceof Error ? error.message : "unknown Wrangler error";
}

function isCloudflareFetchFailure(error: unknown) {
  const source = error as { stdout?: unknown; stderr?: unknown };
  return `${String(error)}\n${String(source.stdout ?? "")}\n${String(source.stderr ?? "")}`.includes("fetch failed");
}

function sleepSync(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
