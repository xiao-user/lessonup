import { PiLessonAgentCoordinator } from "../server/agent-runtime/pi/coordinator.js";
import { SkillRegistry } from "../server/agent/skill-registry.js";
import { createApp } from "../server/app.js";
import { getRuntimeAuthentication } from "../server/auth.js";
import { KnowledgeUploadService } from "../server/knowledge/uploads.js";
import { D1KnowledgeSourceStore } from "../server/knowledge/source-store.js";
import { D1SqlDatabase } from "../server/platform/d1-sql-database.js";
import { R2ObjectStorage } from "../server/platform/r2-object-storage.js";
import {
  BrowserDashiSkill,
  loadDashiPlanningCatalogFromAssets,
  loadDashiRuntimeCatalogFromAssets,
} from "../server/presentations/browser-dashi-skill.js";
import { PresentationService } from "../server/presentations/service.js";
import { createRepository } from "../server/repositories/index.js";
import { workerPlatformSkills } from "./worker-skill-catalog.js";
import { WorkerTavilyWebSearchProvider } from "./tavily-web-search.js";

type AgentRuntime = "durable" | "disabled";

/**
 * Cloudflare composition root. Platform bindings stop here: all application
 * code below this function sees only repository, authentication and object
 * storage ports, never a D1/R2 binding.
 */
export function createWorkerApplication(
  env: Env,
  agentRuntime: AgentRuntime,
  options: { defer?: (task: Promise<unknown>) => void } = {},
) {
  const database = new D1SqlDatabase(env.LESSONUP_DB);
  const repository = createRepository(database);
  const storage = new R2ObjectStorage(env.LESSONUP_PRIVATE_OBJECTS);
  const authentication = getRuntimeAuthentication(database);
  const knowledgeUploads = new KnowledgeUploadService(
    repository,
    storage,
    new D1KnowledgeSourceStore(database),
  );
  const webProvider = new WorkerTavilyWebSearchProvider(env.TAVILY_API_KEY);
  const dashi = new BrowserDashiSkill(
    (theme) => loadDashiPlanningCatalogFromAssets(env.ASSETS, theme),
    (theme) => loadDashiRuntimeCatalogFromAssets(env.ASSETS, theme),
  );
  // Presentation artifacts use the same direct R2 port as knowledge uploads.
  // Falling back to the old Container bridge renders successfully and then
  // fails only at the final save step inside a native Worker.
  const presentations = new PresentationService(repository, dashi, storage);
  const agent = agentRuntime === "durable" && hasModelConfiguration(env)
    ? new PiLessonAgentCoordinator(repository, {
        sessionSecret: env.AGENT_STATE_ENCRYPTION_KEY,
        dashi,
        presentations,
        registry: new SkillRegistry(async () => workerPlatformSkills),
        webProvider,
        defer: options.defer,
      })
    : null;
  return {
    repository,
    authentication,
    app: createApp(repository, {
      agent,
      authentication,
      knowledgeUploads,
      presentations,
      webProvider,
    }),
  };
}

function hasModelConfiguration(env: Env) {
  return Boolean(
    env.MODEL_API_KEY
    && env.MODEL_BASE_URL
    && env.MODEL_ID
    && env.MODEL_API
    && env.MODEL_CONTEXT_WINDOW
    && env.MODEL_MAX_TOKENS,
  );
}
