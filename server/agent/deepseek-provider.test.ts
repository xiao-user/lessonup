import { describe, expect, it } from "vitest";
import { DeepSeekModelProvider } from "./deepseek-provider.js";

describe("DeepSeekModelProvider", () => {
  it("only resolves the two pinned V4 model ids", async () => {
    const provider = new DeepSeekModelProvider("test-key", "https://api.deepseek.com");
    await expect(provider.getModel("deepseek-chat")).rejects.toThrow("unsupported_deepseek_model");
    expect(await provider.getModel("deepseek-v4-pro")).toBeDefined();
    expect(await provider.getModel("deepseek-v4-flash")).toBeDefined();
    await provider.close();
  });
});
