import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config, runtimeCapabilities } from "./config.js";
import { LessonUpMaintenance } from "./maintenance.js";

const app = createApp();
const stopMaintenance = new LessonUpMaintenance().start();

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.PORT }, ({ address, port }) => {
  console.log(`LessonUp API listening at http://${address}:${port}`);
  console.log(`Runtime: ${JSON.stringify(runtimeCapabilities)}`);
});

const shutdown = () => {
  stopMaintenance();
  server.close();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
