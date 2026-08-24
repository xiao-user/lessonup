import type { AgentActivityRecord, NormalizedAgentEvent } from "./domain.js";
import {
  toolActivityStateForOutcome,
  toolCompletionOutcomeOf,
} from "./agent/tool-completion-outcome.js";
import { safeToolCompletionDetail, safeToolDetail } from "./agent/tool-presentation.js";

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
        detail: event.detail ?? safeToolDetail(event.name),
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
        detail: event.detail ?? safeToolCompletionDetail(event.name, event.label, !event.ok),
        groupKey: event.groupKey ?? activities[index]!.groupKey,
        state: toolActivityStateForOutcome(outcome),
        outcome,
        revisionCode: event.revisionCode,
        turn: event.turn,
      };
    }
  }
  return activities.map((activity) => {
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
