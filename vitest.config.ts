import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "src/**/*.vitest.{js,ts}", "evals/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      LESSONUP_DEV_AUTH: "1",
      MODEL_API_KEY: "",
      MODEL_BASE_URL: "",
      MODEL_ID: "",
      MODEL_API: "",
      MODEL_CONTEXT_WINDOW: "",
      MODEL_MAX_TOKENS: "",
      AGENT_STATE_ENCRYPTION_KEY: "",
      MCP_TOKEN_SECRET: "",
      TAVILY_API_KEY: "",
      EMBEDDING_BASE_URL: "",
      EMBEDDING_API_KEY: "",
      EMBEDDING_MODEL: "",
      EMBEDDING_DIMENSIONS: "",
    },
  },
});
