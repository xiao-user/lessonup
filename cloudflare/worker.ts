import { AgentRequestBodyError, ownAgentRequest } from "./agent-request.js";
import { createWorkerApplication } from "./application.js";
import { processKnowledgeQueue } from "./knowledge-index.js";
import { runLessonUpMaintenance } from "../server/maintenance.js";
import { D1SqlDatabase } from "../server/platform/d1-sql-database.js";

/**
 * Retained solely because the already-applied v1 Durable Object migration
 * names this class. It has no binding or traffic after the Container removal.
 */
export class LessonUpRuntime {
  constructor(_ctx: DurableObjectState, _env: Env) {}
}

/**
 * One Durable Object owns the live native Pi Agent for one user/thread.
 * D1 remains canonical; the Object only holds the short-lived stream, abort
 * controller and native Agent queues that cannot safely live in a stateless
 * Worker instance.
 */
export class LessonUpAgentRuntime {
  private readonly application;

  constructor(ctx: DurableObjectState, env: Env) {
    this.application = createWorkerApplication(env, "durable", {
      defer: (task) => ctx.waitUntil(task),
    }).app;
  }

  fetch(request: Request) {
    return this.application.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const application = createWorkerApplication(env, "disabled");
    try {
      const owned = new URL(request.url).pathname.startsWith("/api/agent/")
        ? await ownAgentRequest(request)
        : { request, json: null };
      const target = await agentRuntimeForRequest(owned.request, env, application, owned.json);
      if (target) return target.fetch(owned.request);
      return application.app.fetch(owned.request);
    } catch (error) {
      if (error instanceof AgentRequestBodyError) {
        return Response.json({ error: error.code }, { status: error.status });
      }
      throw error;
    }
  },
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const database = new D1SqlDatabase(env.LESSONUP_DB);
    ctx.waitUntil(Promise.all([
      runLessonUpMaintenance(database),
      processKnowledgeQueue(env),
    ]));
  },
};

async function agentRuntimeForRequest(
  request: Request,
  env: Env,
  application: ReturnType<typeof createWorkerApplication>,
  json: unknown,
) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/agent/")) return null;
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const userId = token ? await application.authentication?.userIdForAccessToken(token) : null;
  if (!userId) return null;

  const start = url.pathname.match(/^\/api\/agent\/threads\/([^/]+)\/runs$/);
  if (request.method === "POST" && start) {
    const payload = json as { branchId?: unknown } | null;
    if (typeof payload?.branchId !== "string" || !payload.branchId) return null;
    return env.LESSONUP_AGENT_RUNTIME.getByName(runtimeName(userId, decodeURIComponent(start[1])));
  }

  const runRoute = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)(?:\/(?:cancel|input|approvals\/[^/]+))?$/);
  if (!runRoute) return null;
  const run = await application.repository.getRun(userId, decodeURIComponent(runRoute[1]));
  return run
    ? env.LESSONUP_AGENT_RUNTIME.getByName(runtimeName(userId, run.threadId))
    : null;
}

function runtimeName(userId: string, threadId: string) {
  return `${userId}:${threadId}`;
}
