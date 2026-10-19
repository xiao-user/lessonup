import { describe, expect, it } from "vitest";
import { dashiThemeCatalog, parseDashiTheme } from "./dashi-theme-catalog.js";

describe("Dashi theme choice", () => {
  it.each(dashiThemeCatalog)("parses the complete id and named confirmation for $id", ({ id, name }) => {
    expect(parseDashiTheme(id)).toBe(id);
    expect(parseDashiTheme(`确认主题：${name}（${id}）`)).toBe(id);
    expect(parseDashiTheme(name)).toBe(id);
    expect(parseDashiTheme(String(Number(id.slice(5))))).toBe(id);
  });

  it.each([
    ["02", "theme02"],
    ["2", "theme02"],
    ["theme2 炫光紫绿风", "theme02"],
    ["THEME_10", "theme10"],
    ["theme-11", "theme11"],
    ["使用 theme 12", "theme12"],
  ])("parses the picker reply %s", (message, expected) => {
    expect(parseDashiTheme(message)).toBe(expected);
  });

  it.each([
    "第2课时继续生成", "theme0", "theme13", "theme100", "theme010",
    "theme10extra", "mytheme10", "theme10 与 theme11", "金色指数风（theme100）",
  ])("does not take an invalid or ambiguous theme identifier as a choice: %s", (message) => {
    expect(parseDashiTheme(message)).toBeNull();
  });
});
