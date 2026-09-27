/**
 * Small common denominator for repository implementations. Keep SQL and its
 * parameter binding behind this port so neither services nor domain code see
 * D1 bindings, Drizzle driver types, or database-specific result objects.
 */
export type SqlValue = string | number | null | Uint8Array;

export type SqlStatement = {
  sql: string;
  params?: SqlValue[];
};

export type SqlResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
  rowsAffected: number;
};

export interface SqlDatabase {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(statement: SqlStatement): Promise<SqlResult<Row>>;
  batch<Row extends Record<string, unknown> = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlResult<Row>[]>;
}
