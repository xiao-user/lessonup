import { readFile } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config, runtimeCapabilities } from "./config.js";
import { KnowledgeIndexWorker } from "./knowledge/worker.js";
import { LessonUpMaintenance } from "./maintenance.js";
import { createRepository } from "./repositories/index.js";
import { PresentationService } from "./presentations/service.js";
import { PiLessonAgentCoordinator } from "./agent-runtime/pi/coordinator.js";
import { TavilyWebSearchProvider } from "./providers/web-search.js";
import { CloudflareBindingObjectStorage, CloudflareBindingSqlDatabase } from "./platform/cloudflare-binding-bridge.js";
import { getRuntimeAuthentication } from "./auth.js";
import { BrowserDashiSkill } from "./presentations/browser-dashi-skill.js";
import { createNodeSkillRegistry } from "./agent/skill-registry-node.js";

const database = new CloudflareBindingSqlDatabase();
const repository = createRepository(database);
const dashi = new BrowserDashiSkill(async (theme) => {
  const file = path.join(process.cwd(), "public", "dashi", "planning", `${theme}.json`);
  return JSON.parse(await readFile(file, "utf8"));
}, async (theme) => {
  const file = path.join(process.cwd(), "public", "dashi", "runtime", `${theme}.json`);
  return JSON.parse(await readFile(file, "utf8"));
});
const presentations = new PresentationService(repository, dashi, new CloudflareBindingObjectStorage());
try {
  const recovered = await presentations.recoverInterruptedGenerations();
  if (recovered > 0) console.warn(`Recovered ${recovered} interrupted classroom presentation generation(s).`);
} catch (error) {
  // Do not turn a transient database problem into an unavailable API. The
  // durable row remains visible and the next restart can retry recovery.
  console.error("Classroom presentation recovery failed", error instanceof Error ? error.message : "unknown_error");
}
const webProvider = new TavilyWebSearchProvider();
const agent = runtimeCapabilities.agent
  ? new PiLessonAgentCoordinator(repository, {
      presentations,
      dashi,
      registry: createNodeSkillRegistry(),
      webProvider,
    })
  : null;
const app = createApp(repository, {
  presentations,
  agent,
  webProvider,
  authentication: getRuntimeAuthentication(database),
});
const stopMaintenance = new LessonUpMaintenance(database).start();
// The production Container is a single durable runtime process. Running the
// queue worker here keeps private R2 access and D1 lease recovery on the same
// deployment path instead of requiring a second Supabase-era process.
const stopKnowledgeWorker = new KnowledgeIndexWorker().start();

const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, ({ address, port }) => {
  console.log(`LessonUp API listening at http://${address}:${port}`);
  console.log(`Runtime: ${JSON.stringify(runtimeCapabilities)}`);
});

const shutdown = () => {
  stopMaintenance();
  stopKnowledgeWorker();
  server.close();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
