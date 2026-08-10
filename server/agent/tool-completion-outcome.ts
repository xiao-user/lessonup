/**
 * Browser-facing tool outcomes are distinct from model-facing tool output.
 *
 * Agents SDK loops may return recoverable proposal guidance to the model
 * (ok=false + revision text). That must not all collapse into a teacher-visible
 * "failed" activity — especially no_effect_patch, which means the current
 * resource already matches the request.
 */

export type ToolCompletionOutcome =
  | "completed"
  | "no_change"
  | "needs_revision"
  | "failed";

export type ToolActivityState =
  | "running"
  | "completed"
  | "unchanged"
  | "needs_revision"
  | "failed";

export const toolCompletionOutcomeOf = (args: {
  ok: boolean;
  revisionCode?: string;
}): ToolCompletionOutcome => {
  if (args.ok) return "completed";
  if (args.revisionCode === "no_effect_patch") return "no_change";
  if (args.revisionCode) return "needs_revision";
  return "failed";
};

export const toolActivityStateForOutcome = (
  outcome: ToolCompletionOutcome,
): Exclude<ToolActivityState, "running"> => {
  if (outcome === "completed") return "completed";
  if (outcome === "no_change") return "unchanged";
  if (outcome === "needs_revision") return "needs_revision";
  return "failed";
};

export const toolCompletionLabelForOutcome = (
  baseLabel: string,
  outcome: ToolCompletionOutcome,
) => {
  // Only no_change replaces the verb label: teachers should see the cause, not
  // a failed "准备修改建议". Recoverable revisions keep the base label and use
  // activity.state = needs_revision so retries can still merge in the UI.
  if (outcome === "no_change") {
    return "现稿已符合要求，将复用当前内容";
  }
  return baseLabel;
};
