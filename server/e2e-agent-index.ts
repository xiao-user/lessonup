import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { createRepository } from "./repositories/index.js";
import { DeterministicAgentHarness } from "./testing/deterministic-agent-harness.js";

const repository = createRepository();
const app = createApp(repository, { harness: new DeterministicAgentHarness(repository) });

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.PORT }, ({ address, port }) => {
  console.log(`LessonUp deterministic E2E API listening at http://${address}:${port}`);
});

const shutdown = () => server.close();
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
