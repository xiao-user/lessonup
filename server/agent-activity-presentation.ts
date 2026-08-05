import type { AgentActivityRecord, NormalizedAgentEvent } from "./domain.js";

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
        groupKey: event.groupKey,
        state: "running",
      });
      continue;
    }
    if (event.type !== "tool.completed") continue;
    const index = activities.findIndex((activity) => activity.id === event.toolCallId);
    if (index >= 0) {
      activities[index] = {
        ...activities[index]!,
        label: event.label,
        groupKey: event.groupKey ?? activities[index]!.groupKey,
        state: event.ok ? "completed" : "failed",
      };
    }
  }
  return activities.map((activity) => {
    if (activity.state !== "running") return activity;
    if (runStatus === "failed" || runStatus === "cancelled") {
      return { ...activity, state: "failed" };
    }
    if (runStatus === "completed") return { ...activity, state: "completed" };
    return activity;
  });
}
