import { approvalEvent, reconcileApprovals } from "./approval-state.js";
import { deriveBranchRuntimeState } from "./agent-run-control.js";

export const initialConversationState = Object.freeze({
  messages: [],
  activities: [],
  queuedInputs: [],
  sources: [],
  approvals: [],
  status: "loading",
  error: null,
  runId: null,
  snapshotVersion: null,
  throughSequence: 0,
});

/**
 * Canonical browser projection for the selected conversation. Transport
 * controllers, drafts and uploads deliberately live outside this object.
 * Functional values preserve React setState semantics during the incremental
 * migration from independent state atoms.
 */
export function conversationStateReducer(state, action) {
  if (action.type === "approval-sync-unavailable") {
    const approval = state.approvals.find((item) => item.id === action.approvalId);
    if (!approval || approval.continuationStatus === "completed") return state;
    return { ...state, status: "syncing", runId: approval.runId,
      approvals: state.approvals.map((item) => item === approval ? { ...item, transport: "unknown" } : item),
    };
  }
  if (action.type === "approval-event") {
    const approvals = approvalEvent(state.approvals, action.event);
    if (approvals === state.approvals) return state;
    return { ...state, approvals,
      ...(action.event.type === "approval.required" ? { status: "awaiting_approval" } : {}),
    };
  }
  if (action.type === "set") {
    const value = typeof action.value === "function"
      ? action.value(state[action.key])
      : action.value;
    if (Object.is(value, state[action.key])) return state;
    return { ...state, [action.key]: value };
  }
  if (action.type === "patch") {
    const patch = Object.fromEntries(Object.entries(action.value).map(([key, value]) => [
      key,
      typeof value === "function" ? value(state[key]) : value,
    ]));
    return { ...state, ...patch };
  }
  if (action.type === "hydrate") {
    return {
      ...state,
      ...action.value,
      approvals: action.value.approvals ? reconcileApprovals(state.approvals, action.value.approvals) : state.approvals,
      snapshotVersion: action.aggregateVersion,
      throughSequence: action.throughSequence ?? 0,
    };
  }
  if (action.type === "restore-runtime") {
    return { ...state, ...deriveBranchRuntimeState({ ...action.value, approvals: state.approvals }) };
  }
  if (action.type === "reset") return { ...initialConversationState, ...action.value };
  return state;
}

export function shouldRecoverConversation({
  status,
  runId,
  threadId,
  branchId,
  hasLocalStream,
}) {
  return (status === "streaming" || status === "syncing")
    && Boolean(runId)
    && Boolean(threadId)
    && Boolean(branchId)
    && !hasLocalStream;
}
