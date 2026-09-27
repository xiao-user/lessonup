import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { LessonRepository } from "../../repository.js";
import { type Emit, RUN_LEASE_MS, RUN_HEARTBEAT_MS } from "./contracts.js";

type ActiveRun = {
  controller: AbortController;
  agent?: Agent;
  emit: Emit;
  pendingInputs: Array<{
    queueId: string;
    delivery: "steer" | "follow_up";
    message: AgentMessage;
  }>;
  settled: Promise<void>;
  settle: () => void;
};

/** Owns process-local cancellation, native Pi input queues, and lease heartbeats.
 * Durable run transitions remain repository transactions, not another state machine. */
export class PiRunLifecycle {
  private readonly activeRuns = new Map<string, ActiveRun>();
  constructor(private readonly repository: Pick<LessonRepository, "requestRunCancellation" | "getRun" | "heartbeatRun">) {}
  /** One owned scope for both ordinary turns and approval replies. The caller
   * closes it after durable settlement, including when initialization fails. */
  open(args: { userId: string; runId: string; leaseToken: string; controller: AbortController }, emit: Emit) {
    const key = `${args.userId}:${args.runId}`;
    const active = this.registerActive(key, args.controller, emit);
    let stopHeartbeat = async () => {};
    let started: Promise<void> | undefined;
    let closed: Promise<void> | undefined;
    return {
      startHeartbeat: () => {
        if (closed) return Promise.reject(new Error("active_run_closed"));
        return started ??= this.heartbeat(args).then(stop => { stopHeartbeat = stop; });
      },
      close: () => closed ??= (async () => {
        try {
          await started?.catch(() => undefined);
          await stopHeartbeat();
        } finally {
          active.settle();
          if (this.activeRuns.get(key) === active) this.activeRuns.delete(key);
        }
      })(),
    };
  }

  private registerActive(key: string, controller: AbortController, emit: Emit) {
    if (this.activeRuns.has(key)) throw new Error("active_run_exists");
    let settle = () => {};
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const active: ActiveRun = { controller, emit, pendingInputs: [], settled, settle };
    this.activeRuns.set(key, active);
    return active;
  }

  attachActiveAgent(key: string, agent: Agent) {
    const active = this.activeRuns.get(key);
    if (!active) return;
    active.agent = agent;
    for (const queued of active.pendingInputs.splice(0)) {
      if (queued.delivery === "steer") agent.steer(queued.message);
      else agent.followUp(queued.message);
    }
  }

  async cancel(userId: string, runId: string) {
    const requested = await this.repository.requestRunCancellation(userId, runId).catch(() => false);
    const active = this.activeRuns.get(`${userId}:${runId}`);
    if (active) {
      active.agent?.abort();
      active.controller.abort("user_cancelled");
      await active.settled;
    }
    return requested;
  }

  async queueInput(args: {
    userId: string;
    runId: string;
    content: string;
    delivery: "steer" | "follow_up";
  }) {
    const run = await this.repository.getRun(args.userId, args.runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) throw new Error("run_not_accepting_input");
    const active = this.activeRuns.get(`${args.userId}:${args.runId}`);
    if (!active || active.controller.signal.aborted) throw new Error("active_run_not_found");
    if (active.agent && !active.agent.state.isStreaming) throw new Error("run_not_accepting_input");
    const queueId = crypto.randomUUID();
    const message: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: args.content }],
      timestamp: Date.now(),
    };
    await active.emit({
      type: "agent.input.queued",
      runId: args.runId,
      queueId,
      delivery: args.delivery,
      content: args.content,
    });
    if (active.agent) {
      if (args.delivery === "steer") active.agent.steer(message);
      else active.agent.followUp(message);
    } else active.pendingInputs.push({ queueId, delivery: args.delivery, message });
    return { queueId, delivery: args.delivery, content: args.content };
  }

  async clearQueuedInputs(args: {
    userId: string;
    runId: string;
    delivery: "steer" | "follow_up" | "all";
  }) {
    const active = this.activeRuns.get(`${args.userId}:${args.runId}`);
    if (!active || active.controller.signal.aborted) throw new Error("active_run_not_found");
    if (args.delivery === "steer" || args.delivery === "all") active.agent?.clearSteeringQueue();
    if (args.delivery === "follow_up" || args.delivery === "all") active.agent?.clearFollowUpQueue();
    active.pendingInputs = active.pendingInputs.filter((queued) => args.delivery !== "all" && queued.delivery !== args.delivery);
    await active.emit({ type: "agent.input.cleared", runId: args.runId, delivery: args.delivery });
  }

  private async heartbeat(args: {
    userId: string;
    runId: string;
    leaseToken: string;
    controller: AbortController;
  }) {
    let timer: ReturnType<typeof setInterval> | undefined;
    let pending = Promise.resolve();
    const beat = async () => {
      const run = await this.repository.heartbeatRun({
        ownerId: args.userId,
        runId: args.runId,
        leaseToken: args.leaseToken,
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS).toISOString(),
      });
      if (run.cancelRequestedAt && !args.controller.signal.aborted) {
        args.controller.abort("user_cancelled");
      }
    };
    await beat();
    timer = setInterval(() => {
      pending = pending.then(beat).catch((error) => {
        if (!args.controller.signal.aborted) args.controller.abort(
          error instanceof Error ? error.message : "run_lease_lost",
        );
      });
    }, RUN_HEARTBEAT_MS);
    return async () => {
      if (timer) clearInterval(timer);
      await pending.catch(() => undefined);
    };
  }

}
