import type { AgentActivityRecord, NormalizedAgentEvent } from "./domain.js";
import {
  toolActivityStateForOutcome,
  toolCompletionOutcomeOf,
} from "./agent/tool-completion-outcome.js";
import { isAgentLoopNarration, safeToolCompletionDetail, safeToolDetail } from "./agent/tool-presentation.js";

/**
 * Tool calls a durable confirmation item proves were materialized.
 *
 * Mirror of `approvalBackedToolCallIds` in
 * `src/features/assistant/agent-run-control.js`: the same run must read
 * identically while it streams and after it is rehydrated from the journal.
 */
function approvalBackedToolCalls(
  events: NormalizedAgentEvent[],
  activities: AgentActivityRecord[],
) {
  let approvalSeen = false;
  const attributed = new Set<string>();
  for (const event of events) {
    if (event.type === "approval.required") {
      approvalSeen = true;
      if (event.toolCallId) attributed.add(event.toolCallId);
    }
    if (event.type === "approval.decided") approvalSeen = true;
  }
  if (attributed.size || !approvalSeen) return attributed;
  const fallback = [...activities]
    .reverse()
    .find((activity) => activity.name?.startsWith("propose_"));
  return new Set(fallback ? [fallback.id] : []);
}

export function persistedActivitiesFromEvents(
  events: NormalizedAgentEvent[],
  runStatus?: string,
): AgentActivityRecord[] {
  const activities: AgentActivityRecord[] = [];
  for (const event of events) {
    if (event.type === "tool.started") {
      activities.push({
        id: event.toolCallId,
        name: event.name,
        label: event.label,
        detail: event.detail && !isAgentLoopNarration(event.detail)
          ? event.detail
          : safeToolDetail(event.name),
        groupKey: event.groupKey,
        state: "running",
        turn: event.turn,
      });
      continue;
    }
    if (event.type === "tool.updated") {
      const index = activities.findIndex((activity) => activity.id === event.toolCallId);
      if (index >= 0) {
        activities[index] = {
          ...activities[index]!,
          label: event.label,
          detail: event.detail ?? activities[index]!.detail,
          progress: event.progress ?? activities[index]!.progress,
          turn: event.turn,
        };
      }
      continue;
    }
    if (event.type !== "tool.completed") continue;
    const index = activities.findIndex((activity) => activity.id === event.toolCallId);
    if (index >= 0) {
      const outcome = event.outcome ?? toolCompletionOutcomeOf({
        ok: event.ok,
        revisionCode: event.revisionCode,
      });
      activities[index] = {
        ...activities[index]!,
        label: event.label,
        detail: event.detail && !isAgentLoopNarration(event.detail)
          ? event.detail
          : safeToolCompletionDetail(event.name, event.label, !event.ok, activities[index]!.detail),
        groupKey: event.groupKey ?? activities[index]!.groupKey,
        state: toolActivityStateForOutcome(outcome),
        outcome,
        revisionCode: event.revisionCode,
        turn: event.turn,
      };
    }
  }
  const approvalBacked = approvalBackedToolCalls(events, activities);
  return activities.map((activity) => {
    // The confirmation item proves this call passed preflight, even when the
    // provider later acknowledged it as stale against the applied version.
    if (approvalBacked.has(activity.id)) {
      return { ...activity, state: "completed", outcome: "completed" };
    }
    if (activity.state !== "running") return activity;
    if (runStatus === "cancelled") {
      return { ...activity, state: "cancelled", outcome: "cancelled" };
    }
    if (runStatus === "failed") {
      return { ...activity, state: "failed" };
    }
    if (runStatus === "completed") return { ...activity, state: "completed" };
    return activity;
  });
}

export function persistedTurnPhaseFromEvents(
  events: NormalizedAgentEvent[],
  runStatus?: string,
) {
  if (!["queued", "running"].includes(runStatus ?? "")) return undefined;
  let phase: "starting" | "preparing" | "responding" | "using_tools" = "starting";
  let currentTurn: number | undefined;
  const runningTools = new Set<string>();
  for (const event of events) {
    if (event.type === "agent.started") phase = "preparing";
    if (event.type === "turn.started") {
      phase = "responding";
      currentTurn = event.turn;
    }
    if (event.type === "assistant.message.started") {
      phase = "responding";
      currentTurn = event.turn;
    }
    if (event.type === "tool.started") {
      runningTools.add(event.toolCallId);
      phase = "using_tools";
      currentTurn = event.turn ?? currentTurn;
    }
    if (event.type === "tool.completed") {
      runningTools.delete(event.toolCallId);
      phase = runningTools.size ? "using_tools" : "responding";
      currentTurn = event.turn ?? currentTurn;
    }
    if (event.type === "assistant.message.ended" || event.type === "turn.ended") currentTurn = event.turn;
  }
  return { phase, currentTurn };
}

export function persistedTurnTextsFromEvents(events: NormalizedAgentEvent[]) {
  const texts: Record<number, string> = {};
  for (const event of events) {
    if (event.type !== "message.turn_text" || !event.text) continue;
    texts[event.turn] = event.text;
  }
  return texts;
}
