import { describe, expect, it } from "vitest";
import { expiredRunRecovery } from "./expired-run-recovery.js";

describe("expiredRunRecovery", () => {
  it("fails an ordinary expired run so the teacher can retry", () => {
    expect(expiredRunRecovery({ cancelled: false, hasPendingApproval: false })).toEqual({
      status: "failed",
      error: "run_interrupted",
      messageStatus: "failed",
      threadStatus: "idle",
    });
  });

  it("keeps a persisted confirmation card instead of interrupting the run", () => {
    expect(expiredRunRecovery({ cancelled: false, hasPendingApproval: true })).toEqual({
      status: "awaiting_approval",
      messageStatus: "completed",
      threadStatus: "awaiting_approval",
    });
  });

  it("honors an explicit stop even when a card was already saved", () => {
    expect(expiredRunRecovery({ cancelled: true, hasPendingApproval: true })).toEqual({
      status: "cancelled",
      messageStatus: "cancelled",
      threadStatus: "idle",
    });
  });
});
