import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunRecord } from "../../domain.js";
import { PiRunLifecycle } from "./run-lifecycle.js";
import { RUN_HEARTBEAT_MS } from "./contracts.js";

function fixture() {
  const run: AgentRunRecord = {
    id: "run", ownerId: "owner", threadId: "thread", branchId: "branch",
    model: "test", status: "running", startedAt: new Date().toISOString(),
  };
  const repository = {
    getRun: vi.fn(async () => run),
    requestRunCancellation: vi.fn(async () => true),
    heartbeatRun: vi.fn(async () => run),
  };
  const lifecycle = new PiRunLifecycle(repository);
  const args = { userId: "owner", runId: "run", leaseToken: "lease", controller: new AbortController() };
  return { lifecycle, repository, args };
}

afterEach(() => vi.useRealTimers());

describe("Pi live execution ownership", () => {
  it("cleans up a failed first heartbeat and permits a fresh attempt", async () => {
    const { lifecycle, repository, args } = fixture();
    repository.heartbeatRun.mockRejectedValueOnce(new Error("database_unavailable"));
    const execution = lifecycle.open(args, () => undefined);
    await expect(execution.startHeartbeat()).rejects.toThrow("database_unavailable");
    await execution.close();
    const retry = lifecycle.open({ ...args, leaseToken: "new-lease" }, () => undefined);
    try { await retry.startHeartbeat(); } finally { await retry.close(); }
    expect(repository.heartbeatRun).toHaveBeenCalledTimes(2);
  });

  it("keeps cancellation waiting for settlement and makes cleanup owner-specific", async () => {
    const { lifecycle, args } = fixture();
    const execution = lifecycle.open(args, () => undefined);
    let finished = false;
    const cancelled = lifecycle.cancel("owner", "run").then(result => { finished = true; return result; });
    await Promise.resolve();
    await Promise.resolve();
    expect(args.controller.signal.aborted).toBe(true);
    expect(finished).toBe(false);
    await execution.close();
    await expect(cancelled).resolves.toBe(true);
    const next = lifecycle.open({ ...args, controller: new AbortController() }, () => undefined);
    await execution.close();
    expect(() => lifecycle.open(args, () => undefined)).toThrow("active_run_exists");
    await next.close();
  });

  it("hands queued input to native Pi once and respects cleared delivery modes", async () => {
    const { lifecycle, args } = fixture();
    const execution = lifecycle.open(args, () => undefined);
    try {
      await lifecycle.queueInput({ userId: "owner", runId: "run", delivery: "steer", content: "change direction" });
      await lifecycle.queueInput({ userId: "owner", runId: "run", delivery: "follow_up", content: "next task" });
      await lifecycle.clearQueuedInputs({ userId: "owner", runId: "run", delivery: "steer" });
      const agent = new Agent({ streamFn: () => { throw new Error("unexpected_model_call"); } });
      const steer = vi.spyOn(agent, "steer");
      const followUp = vi.spyOn(agent, "followUp");
      lifecycle.attachActiveAgent("owner:run", agent);
      lifecycle.attachActiveAgent("owner:run", agent);
      expect(steer).not.toHaveBeenCalled();
      expect(followUp).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        role: "user", content: [{ type: "text", text: "next task" }],
      }));
    } finally { await execution.close(); }
  });

  it("starts one heartbeat, aborts on lease loss, and stops its timer on close", async () => {
    vi.useFakeTimers();
    const { lifecycle, repository, args } = fixture();
    const execution = lifecycle.open(args, () => undefined);
    try {
      await Promise.all([execution.startHeartbeat(), execution.startHeartbeat()]);
      expect(repository.heartbeatRun).toHaveBeenCalledTimes(1);
      repository.heartbeatRun.mockRejectedValueOnce(new Error("run_lease_lost"));
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_MS);
      expect(args.controller.signal.reason).toBe("run_lease_lost");
    } finally { await execution.close(); }
    expect(vi.getTimerCount()).toBe(0);
    await expect(execution.startHeartbeat()).rejects.toThrow("active_run_closed");
  });
});
