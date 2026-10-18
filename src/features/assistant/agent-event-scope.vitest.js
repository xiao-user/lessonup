import { describe, expect, it } from "vitest";

import {
  isAgentEventActive,
  resolveAgentEventScope,
} from "./agent-event-scope";

describe("agent event scope", () => {
  it("binds an initialization failure with a known run id before run.started", () => {
    const scopes = new Map();
    const requestScope = { threadId: "thread-a", branchId: "branch-a" };
    const resolved = resolveAgentEventScope(
      scopes,
      { type: "run.failed", runId: "run-a", error: "agent_run_failed" },
      requestScope,
    );

    expect(resolved).toEqual(requestScope);
    expect(scopes.has("run-a")).toBe(false);
    expect(isAgentEventActive(resolved, "thread-a", "branch-a")).toBe(true);
  });

  it.each(["approval.decided", "approval.settled", "approval.delivered"])("routes historical %s without registering a completed run", (type) => {
    const historical = { threadId: "thread-a", branchId: "branch-a" };
    const active = { threadId: "thread-a", branchId: "branch-a" };
    const scopes = new Map([["new-run", active]]);
    expect(resolveAgentEventScope(scopes, { type, runId: "old-run" }, historical)).toBe(historical);
    expect([...scopes.entries()]).toEqual([["new-run", active]]);
    expect(resolveAgentEventScope(scopes, { type: "message.delta", runId: "new-run" })).toBe(active);
  });

  it("does not treat an unscoped unknown event as belonging to the visible thread", () => {
    expect(isAgentEventActive(
      resolveAgentEventScope(new Map(), { type: "run.failed", runId: "unknown" }),
      "thread-a",
      "branch-a",
    )).toBe(false);
  });

  it("does not apply another thread or branch's stream events to the visible conversation", () => {
    expect(isAgentEventActive(
      { threadId: "thread-a", branchId: "branch-a" },
      "thread-b",
      "branch-a",
    )).toBe(false);
    expect(isAgentEventActive(
      { threadId: "thread-a", branchId: "branch-a" },
      "thread-a",
      "branch-b",
    )).toBe(false);
  });
});
