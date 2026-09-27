export type ExpiredRunRecovery = {
  status: "cancelled" | "failed" | "awaiting_approval";
  error?: string;
  messageStatus: "cancelled" | "failed" | "completed";
  threadStatus: "idle" | "awaiting_approval";
};

/**
 * Lease recovery must not turn a persisted teacher card into a failed idle
 * thread. A later chat would then start while the protocol still thinks a
 * confirmation is waiting.
 */
export function expiredRunRecovery(args: {
  cancelled: boolean;
  hasPendingApproval: boolean;
}): ExpiredRunRecovery {
  if (args.cancelled) {
    return { status: "cancelled", messageStatus: "cancelled", threadStatus: "idle" };
  }
  if (args.hasPendingApproval) {
    return {
      status: "awaiting_approval",
      messageStatus: "completed",
      threadStatus: "awaiting_approval",
    };
  }
  return {
    status: "failed",
    error: "run_interrupted",
    messageStatus: "failed",
    threadStatus: "idle",
  };
}
