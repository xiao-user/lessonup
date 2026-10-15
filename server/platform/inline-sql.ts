import type { SqlValue } from "./sql-database.js";

/**
 * Renders a parameterized statement as literal SQL for transports that cannot
 * bind parameters, such as `wrangler d1 execute`. `?` inside quoted text is
 * left alone. Only single statements without SQL comments are supported.
 */
export function inlineSql(sql: string, params: readonly SqlValue[] = []) {
  let index = 0;
  let output = "";
  let quote: string | null = null;
  for (let position = 0; position < sql.length; position += 1) {
    const char = sql[position]!;
    if (quote) {
      output += char;
      if (char === quote) {
        if (sql[position + 1] === quote) {
          output += quote;
          position += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      output += char;
    } else if (char === "?") {
      if (index >= params.length) throw new Error("sql_parameter_missing");
      output += sqlLiteral(params[index++]!);
    } else {
      output += char;
    }
  }
  if (index !== params.length) throw new Error("sql_parameter_unused");
  return output;
}

export function sqlLiteral(value: SqlValue) {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("sql_number_not_finite");
    return String(value);
  }
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  if (value.includes("\0")) throw new Error("sql_string_contains_nul");
  return `'${value.replaceAll("'", "''")}'`;
}
