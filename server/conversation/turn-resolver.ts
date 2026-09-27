import type { CapabilityPlan } from "../domain.js";

/**
 * Durable interaction state is resolved before language routing. Approval
 * decisions intentionally remain explicit approval-id API operations; a
 * natural-language acknowledgement must never commit a pending mutation.
 */
export type InteractionState =
  | "idle"
  | "awaiting_approval"
  | "awaiting_clarification"
  | "awaiting_choice"
  | "agent_running"
  | "agent_paused";

export type TurnKind =
  | "control"
  | "ack"
  | "conversation"
  | "agent_read"
  | "agent_write"
  | "ambiguous";

export type ContextProfile =
  | "control"
  | "fast_conversation"
  | "agent_read"
  | "agent_write";

export type ToolSurface = "none" | "read" | "write";

export type ResolvedTurn = {
  kind: TurnKind;
  contextProfile: ContextProfile;
  toolSurface: ToolSurface;
};

const controlTurn: ResolvedTurn = {
  kind: "control",
  contextProfile: "control",
  toolSurface: "none",
};

/**
 * Resolve the execution lane from server-owned state and the deterministic
 * capability plan. This is deliberately model-free: deciding whether a turn
 * needs business tools must not first pay the cost of an Agent tool loop.
 */
export function resolveTurn(args: {
  interactionState?: InteractionState;
  plan: CapabilityPlan;
}): ResolvedTurn {
  const state = args.interactionState ?? "idle";
  if (state !== "idle") return controlTurn;

  const { plan } = args;
  if (plan.executionLane === "fast") {
    return plan.lightweightConversation
      ? { kind: "ack", contextProfile: "fast_conversation", toolSurface: "none" }
      : { kind: "conversation", contextProfile: "fast_conversation", toolSurface: "none" };
  }

  // Presentation generation and structured design-basis operations are both
  // approval-gated mutations even when their CapabilityPlan is consultative.
  if (
    plan.writeMode !== "consultative"
    || plan.presentationRequested
    || plan.designBasisWriteRequested
  ) {
    return { kind: "agent_write", contextProfile: "agent_write", toolSurface: "write" };
  }

  return { kind: "agent_read", contextProfile: "agent_read", toolSurface: "read" };
}
