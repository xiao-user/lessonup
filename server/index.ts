import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config, runtimeCapabilities } from "./config.js";
import { KnowledgeIndexWorker } from "./knowledge/worker.js";

const app = createApp();
const knowledgeWorker = new KnowledgeIndexWorker();
const stopKnowledgeWorker = knowledgeWorker.start();

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.PORT }, ({ address, port }) => {
  console.log(`LessonUp API listening at http://${address}:${port}`);
  console.log(`Runtime: ${JSON.stringify(runtimeCapabilities)}`);
});

const shutdown = () => {
  stopKnowledgeWorker();
  server.close();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
