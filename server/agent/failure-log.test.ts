import { describe, expect, it, vi } from "vitest";
import { logAgentFailure } from "./failure-log.js";

function captured(run: () => void) {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    run();
    return log.mock.calls.map((call) => ({ message: call[0] as string, detail: JSON.parse(String(call[1])) as Record<string, any> }));
  } finally {
    log.mockRestore();
  }
}

describe("logAgentFailure", () => {
  it("records ids, the public code and the underlying error with its cause chain", () => {
    const cause = new Error("connect ETIMEDOUT");
    const error = new Error("pi_run_failed:upstream", { cause });
    const [entry] = captured(() => logAgentFailure({ source: "run", runId: "run-1", threadId: "thread-1" }, "agent_timeout", error));
    expect(entry!.message).toBe("Agent failure");
    expect(entry!.detail).toMatchObject({
      source: "run", runId: "run-1", threadId: "thread-1", code: "agent_timeout",
      error: { name: "Error", message: "pi_run_failed:upstream", cause: { message: "connect ETIMEDOUT" } },
    });
    expect(entry!.detail.error.stack).toContain("pi_run_failed:upstream");
    expect(entry!.detail.error.cause.stack).toBeUndefined();
  });

  it("bounds message length, stack depth and cause depth", () => {
    const deep = new Error("a", { cause: new Error("b", { cause: new Error("c", { cause: new Error("d") }) }) });
    const long = Object.assign(new Error("x".repeat(2_000)), { stack: Array.from({ length: 30 }, (_, i) => `at frame${i}`).join("\n") });
    const [first, second] = captured(() => {
      logAgentFailure({ source: "run" }, "agent_run_failed", deep);
      logAgentFailure({ source: "run" }, "agent_run_failed", long);
    });
    expect(first!.detail.error.cause.cause.cause).toBeUndefined();
    expect(second!.detail.error.message).toHaveLength(500);
    expect(second!.detail.error.stack.split("\n")).toHaveLength(8);
  });

  it("describes a thrown value that is not an Error", () => {
    const [entry] = captured(() => logAgentFailure({ source: "approval", approvalId: "a-1" }, "approval_resume_failed", "plain string"));
    expect(entry!.detail).toMatchObject({ approvalId: "a-1", error: { message: "plain string" } });
  });

  it("can skip failures that already carry a specific public code", () => {
    const entries = captured(() => {
      logAgentFailure({ source: "start" }, "active_run_exists", new Error("active_run_exists"), { onlyUnexpected: true });
      logAgentFailure({ source: "start" }, "agent_run_failed", new Error("d1_unavailable"), { onlyUnexpected: true });
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail.error.message).toBe("d1_unavailable");
  });
});
