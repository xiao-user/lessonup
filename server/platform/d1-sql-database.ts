import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database.js";

type D1ResultLike = {
  results?: unknown[];
  meta?: { changes?: number };
};

type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  all(): Promise<D1ResultLike>;
};

/** The narrow direct D1 binding used by the production Worker composition root. */
export type D1DatabaseBinding = {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<D1ResultLike[]>;
};

/**
 * Direct D1 adapter for Workers. Repository and service code continue to use
 * the portable SqlDatabase port; only this adapter knows the D1 binding API.
 */
export class D1SqlDatabase implements SqlDatabase {
  constructor(private readonly database: D1DatabaseBinding) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(statement: SqlStatement): Promise<SqlResult<Row>> {
    return toSqlResult<Row>(await this.prepare(statement).all());
  }

  async batch<Row extends Record<string, unknown> = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlResult<Row>[]> {
    if (!statements.length) return [];
    const results = await this.database.batch(statements.map((statement) => this.prepare(statement)));
    return results.map(toSqlResult<Row>);
  }

  private prepare(statement: SqlStatement) {
    const prepared = this.database.prepare(statement.sql);
    return statement.params?.length ? prepared.bind(...statement.params) : prepared;
  }
}

function toSqlResult<Row extends Record<string, unknown>>(result: D1ResultLike): SqlResult<Row> {
  return { rows: (result.results ?? []) as Row[], rowsAffected: result.meta?.changes ?? 0 };
}
