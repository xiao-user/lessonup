import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "src/**/*.vitest.{js,ts}", "evals/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      LESSONUP_DEV_AUTH: "1",
      MODEL_API_KEY: "",
      MODEL_BASE_URL: "",
      MODEL_ID: "",
      SUPABASE_URL: "",
      SUPABASE_ANON_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      AGENT_STATE_ENCRYPTION_KEY: "",
      MCP_TOKEN_SECRET: "",
      TAVILY_API_KEY: "",
      BGE_M3_BASE_URL: "",
      BGE_M3_API_KEY: "",
    },
  },
});
