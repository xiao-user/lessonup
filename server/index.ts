import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config, runtimeCapabilities } from "./config.js";
import { LessonUpMaintenance } from "./maintenance.js";
import { createRepository } from "./repositories/index.js";
import { PresentationService } from "./presentations/service.js";

const repository = createRepository();
const presentations = new PresentationService(repository);
try {
  const recovered = await presentations.recoverInterruptedGenerations();
  if (recovered > 0) console.warn(`Recovered ${recovered} interrupted classroom presentation generation(s).`);
} catch (error) {
  // Do not turn a transient database problem into an unavailable API. The
  // durable row remains visible and the next restart can retry recovery.
  console.error("Classroom presentation recovery failed", error instanceof Error ? error.message : "unknown_error");
}
const app = createApp(repository, { presentations });
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
