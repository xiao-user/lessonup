import { describe, expect, it } from "vitest";
import { inlineSql } from "./inline-sql.js";

describe("inlineSql", () => {
  it("renders every value type as a SQL literal", () => {
    expect(inlineSql("INSERT INTO t VALUES (?, ?, ?, ?, ?)", ["a", 3, -1.5e-7, null, new Uint8Array([0, 255])]))
      .toBe("INSERT INTO t VALUES ('a', 3, -1.5e-7, NULL, X'00ff')");
  });

  it("doubles quotes and keeps semicolons and CJK punctuation inside the literal", () => {
    expect(inlineSql("SELECT ?", ["it's; 中文；\"x\""])).toBe("SELECT 'it''s; 中文；\"x\"'");
  });

  it("does not treat a question mark inside quoted text as a placeholder", () => {
    expect(inlineSql("SELECT 'why?' AS a, \"col?\" AS b, ?", ["x"])).toBe("SELECT 'why?' AS a, \"col?\" AS b, 'x'");
    expect(inlineSql("SELECT 'it''s ?' , ?", ["x"])).toBe("SELECT 'it''s ?' , 'x'");
  });

  it("rejects mismatched parameter counts and unrepresentable values", () => {
    expect(() => inlineSql("SELECT ?, ?", ["a"])).toThrow("sql_parameter_missing");
    expect(() => inlineSql("SELECT ?", ["a", "b"])).toThrow("sql_parameter_unused");
    expect(() => inlineSql("SELECT ?", [Number.NaN])).toThrow("sql_number_not_finite");
    expect(() => inlineSql("SELECT ?", ["a\0b"])).toThrow("sql_string_contains_nul");
  });
});
