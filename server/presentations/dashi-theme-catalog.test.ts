import { describe, expect, it } from "vitest";
import { parseDashiTheme } from "./dashi-theme-catalog.js";

describe("Dashi theme choice", () => {
  it.each([
    ["02", "theme02"],
    ["2", "theme02"],
    ["theme02", "theme02"],
    ["theme2 炫光紫绿风", "theme02"],
    ["炫光紫绿风", "theme02"],
    ["12", "theme12"],
  ])("parses the picker reply %s", (message, expected) => {
    expect(parseDashiTheme(message)).toBe(expected);
  });

  it("does not treat an ordinary number-bearing message as a theme choice", () => {
    expect(parseDashiTheme("第2课时继续生成")).toBeNull();
  });
});
