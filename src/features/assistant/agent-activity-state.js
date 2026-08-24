/** Terminal Pi message state always wins over a stale running tool projection. */
export function presentActivitiesForMessage(activities, messageStatus) {
  const terminalState = messageStatus === "failed"
    ? "failed"
    : messageStatus === "cancelled"
      ? "cancelled"
      : messageStatus === "completed"
        ? "completed"
        : null;
  return terminalState
    ? activities?.map((activity) => activity.state === "running"
      ? { ...activity, state: terminalState }
      : activity)
    : activities;
}

/** Reduce server-owned Pi lifecycle signals into the two public Turn phases. */
export function presentTurnState({
  messageStatus,
  chatStatus,
  turnStatus,
  hasActiveApproval = false,
  hasError = false,
}) {
  if (messageStatus === "failed" || (messageStatus === "streaming" && hasError)) {
    return "failed";
  }
  if (messageStatus === "cancelled") return "cancelled";
  if (
    (messageStatus === "streaming" && chatStatus === "streaming")
    || hasActiveApproval
    || ["queued", "running", "awaiting_approval"].includes(turnStatus)
  ) {
    return "running";
  }
  return "completed";
}

/** Current focus exists only while the Turn is genuinely active. */
export function presentCurrentFocus(activities, turnState) {
  if (turnState !== "running") return undefined;
  return activities?.findLast((activity) => activity.state === "running")?.detail;
}
