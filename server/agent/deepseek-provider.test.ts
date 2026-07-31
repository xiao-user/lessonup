import { describe, expect, it } from "vitest";
import { DeepSeekModelProvider, repairToolArgumentsJson } from "./deepseek-provider.js";

describe("DeepSeekModelProvider", () => {
  it("only resolves the two pinned V4 model ids", async () => {
    const provider = new DeepSeekModelProvider("test-key", "https://api.deepseek.com");
    await expect(provider.getModel("deepseek-chat")).rejects.toThrow("unsupported_deepseek_model");
    expect(await provider.getModel("deepseek-v4-pro")).toBeDefined();
    expect(await provider.getModel("deepseek-v4-flash")).toBeDefined();
    await provider.close();
  });

  it("repairs unescaped quotes inside tool argument string values", () => {
    const malformed = "{\"replacement\":\"学生能够用\"完全重合\"说明判断依据。\",\"citations\":null}";
    const repaired = repairToolArgumentsJson(malformed);

    expect(JSON.parse(repaired)).toEqual({
      replacement: "学生能够用\"完全重合\"说明判断依据。",
      citations: null,
    });
  });

  it("preserves valid and unrecoverable tool arguments", () => {
    const valid = "{\"replacement\":\"学生能够用\\\"完全重合\\\"说明判断依据。\"}";
    expect(repairToolArgumentsJson(valid)).toBe(valid);
    expect(repairToolArgumentsJson("{")).toBe("{");
  });
});
