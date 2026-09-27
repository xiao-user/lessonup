import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

const productionEnv = {
  NODE_ENV: "production",
  LESSONUP_PERSISTENCE: "d1",
  LESSONUP_DEV_AUTH: "0",
} satisfies NodeJS.ProcessEnv;

describe("server runtime configuration", () => {
  it("requires an MCP signing secret in production even when the Agent is disabled", () => {
    expect(() => parseConfig(productionEnv)).toThrow("production_requires_mcp_token_secret");
  });

  it("accepts an Agent-disabled production runtime with an explicit MCP signing secret", () => {
    const parsed = parseConfig({
      ...productionEnv,
      MCP_TOKEN_SECRET: "mcp-token-secret-with-at-least-32-characters",
    });
    expect(parsed).toMatchObject({
      NODE_ENV: "production",
      MCP_TOKEN_SECRET: "mcp-token-secret-with-at-least-32-characters",
    });
    expect(parsed.MODEL_API_KEY).toBeUndefined();
  });

  it("accepts explicit model IDs for an OpenAI-compatible gateway", () => {
    const parsed = parseConfig({
      MODEL_API_KEY: "model-key",
      MODEL_BASE_URL: "https://gateway.example/v1",
      MODEL_ID: "model-a",
      MODEL_API: "openai-responses",
      MODEL_CONTEXT_WINDOW: "100000",
      MODEL_MAX_TOKENS: "8000",
    });
    expect(parsed).toMatchObject({
      MODEL_BASE_URL: "https://gateway.example/v1",
      MODEL_ID: "model-a",
      MODEL_API: "openai-responses",
    });
  });

  it("rejects partial model configuration", () => {
    expect(() => parseConfig({ MODEL_API_KEY: "model-key" }))
      .toThrow("model_configuration_incomplete");
  });
});
