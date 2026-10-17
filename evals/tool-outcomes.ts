type Requirements = {
  requiredTools?: string[];
  requiredAnyTools?: string[];
  forbiddenTools?: string[];
  allowsNoChange?: boolean;
};

type ToolEvent = { type: string; name?: string; ok?: boolean };

export function hasGroundedNoChange(events: ToolEvent[]) {
  return events.some((event) => event.type === "tool.completed" && event.name === "complete_without_change" && event.ok === true);
}

export function gradeApprovalRequirement(requirements: { requiresApproval: boolean; allowsNoChange?: boolean }, events: ToolEvent[]) {
  const hasApproval = events.some((event) => event.type === "approval.required");
  const noChange = requirements.allowsNoChange && hasGroundedNoChange(events);
  if (noChange && hasApproval) return ["conflicting_completion"];
  return hasApproval === (noChange ? false : requirements.requiresApproval) ? [] : [`approval_mismatch:${hasApproval}`];
}

/** Starting a tool (or receiving an error) is not proof of observed evidence. */
export function gradeToolRequirements(requirements: Requirements, events: ToolEvent[]) {
  const attempted = new Set(events.filter((event) => event.type === "tool.started").map((event) => event.name));
  const completed = new Set(events.filter((event) => event.type === "tool.completed" && event.ok === true).map((event) => event.name));
  const failures: string[] = [];
  for (const tool of requirements.requiredTools ?? []) {
    if (!completed.has(tool)) failures.push(`missing_required_tool:${tool}`);
  }
  if (requirements.requiredAnyTools?.length && !requirements.requiredAnyTools.some((tool) => completed.has(tool))
    && !(requirements.allowsNoChange && hasGroundedNoChange(events))) {
    failures.push(`missing_required_tool_group:${requirements.requiredAnyTools.join("|")}`);
  }
  for (const tool of requirements.forbiddenTools ?? []) {
    if (attempted.has(tool) || completed.has(tool)) failures.push(`forbidden_tool:${tool}`);
  }
  return failures;
}
