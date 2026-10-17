import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

export default defineConfig({
  testDir: "./e2e/agent",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: "line",
  outputDir: path.join(tmpdir(), "lessonup-playwright", "agent"),
  use: {
    baseURL: "http://127.0.0.1:5176",
    browserName: "chromium",
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: [
    {
      command: "NODE_ENV=test LESSONUP_DEV_AUTH=1 MODEL_API_KEY=e2e-placeholder MODEL_BASE_URL=http://127.0.0.1:9/v1 MODEL_ID=e2e-placeholder MODEL_API=openai-completions MODEL_CONTEXT_WINDOW=100000 MODEL_MAX_TOKENS=8000 EMBEDDING_BASE_URL=http://127.0.0.1:9/v1 EMBEDDING_API_KEY=e2e-placeholder EMBEDDING_MODEL=e2e-placeholder EMBEDDING_DIMENSIONS=3 PORT=8790 APP_ORIGIN=http://127.0.0.1:5176 npx tsx server/e2e-agent-index.ts",
      url: "http://127.0.0.1:8790/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: process.env.LESSONUP_E2E_PREVIEW === "1"
        ? "LESSONUP_API_ORIGIN=http://127.0.0.1:8790 npx vite preview --host 127.0.0.1 --port 5176 --strictPort"
        : "LESSONUP_API_ORIGIN=http://127.0.0.1:8790 npx vite --host 127.0.0.1 --port 5176 --strictPort",
      url: "http://127.0.0.1:5176",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
