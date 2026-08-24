import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/agent",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: "line",
  globalSetup: "./e2e/agent/global-setup.ts",
  globalTeardown: "./e2e/agent/global-teardown.ts",
  outputDir: "output/playwright/agent",
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
      command: "NODE_ENV=test LESSONUP_DEV_AUTH=1 MODEL_API_KEY=e2e-placeholder MODEL_BASE_URL=http://127.0.0.1:9/v1 MODEL_ID=e2e-placeholder PORT=8790 APP_ORIGIN=http://127.0.0.1:5176 npx tsx server/e2e-agent-index.ts",
      url: "http://127.0.0.1:8790/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= LESSONUP_API_ORIGIN=http://127.0.0.1:8790 npx vite --host 127.0.0.1 --port 5176 --strictPort",
      url: "http://127.0.0.1:5176",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
