import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

const productionEnv = {
  NODE_ENV: "production",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
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
    expect(parsed.DEEPSEEK_API_KEY).toBeUndefined();
  });
});
