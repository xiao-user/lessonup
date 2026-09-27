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

/**
 * Reduce server-owned Pi lifecycle signals into the public Turn phases.
 *
 * Waiting for the teacher's decision is its own phase. It used to be folded
 * into "running", which kept the spinner and the elapsed timer climbing for as
 * long as the teacher spent reading the confirmation card — presenting their
 * own reading time as Agent work. A decided approval is different: its
 * continuation run really is working, so it stays "running".
 */
export function presentTurnState({
  messageStatus,
  chatStatus,
  turnStatus,
  hasActiveApproval = false,
  awaitingTeacherDecision = false,
  hasError = false,
}) {
  if (messageStatus === "failed" || (messageStatus === "streaming" && hasError)) {
    return "failed";
  }
  if (messageStatus === "cancelled") return "cancelled";
  if (awaitingTeacherDecision) return "awaiting_approval";
  if (
    (messageStatus === "streaming" && chatStatus === "streaming")
    || hasActiveApproval
    || ["queued", "running", "awaiting_approval"].includes(turnStatus)
  ) {
    return "running";
  }
  return "completed";
}

/**
 * 用时 / tools / thinking stay on the proposing turn. After the teacher
 * decides, that chrome freezes unless a new public tool actually starts.
 * Continuation prose still streams; it must not open a second timer.
 */
export function presentProcessTraceActive(turnState, { decided = false, hasRunningActivity = false } = {}) {
  if (turnState !== "running") return false;
  if (decided && !hasRunningActivity) return false;
  return true;
}

/** Current focus exists only while the Turn is genuinely active. */
export function presentCurrentFocus(activities, turnState) {
  if (turnState !== "running") return undefined;
  return activities?.findLast((activity) => activity.state === "running")?.detail;
}

/**
 * Thinking names the public lifecycle phase while the run is still working
 * and no tool chip is the more specific focus. Mid-turn narration is not the
 * end of the round: hide only when a tool is running or the turn has settled.
 */
export function presentThinkingVisible({ processActive = false, toolsRunning = false } = {}) {
  return Boolean(processActive) && !toolsRunning;
}

/**
 * Render the public Pi sequence in order: each turn's process text, then that
 * turn's tools. That places "已读取教案…" next to the reads it describes, and
 * the next proposal chip after it — the same event order the harness emitted.
 * Older messages without per-turn text keep the previous tools-then-body layout.
 */
export function presentAssistantTimeline(activities = [], turnTexts = {}, content = "") {
  const textTurns = Object.keys(turnTexts)
    .map(Number)
    .filter((turn) => typeof turnTexts[turn] === "string" && turnTexts[turn].length > 0);
  if (!textTurns.length) {
    const blocks = [];
    if (activities.length) blocks.push({ type: "tools", activities });
    if (content) blocks.push({ type: "text", content });
    return blocks;
  }

  const toolTurns = [...new Set(activities.map((item) => item.turn).filter((turn) => turn != null))];
  const turns = [...new Set([...toolTurns, ...textTurns])].sort((left, right) => left - right);
  const used = new Set();
  const blocks = [];
  for (const turn of turns) {
    const text = turnTexts[turn];
    const tools = activities.filter((item) => item.turn === turn);
    if (text) blocks.push({ type: "text", turn, content: text });
    if (tools.length) {
      blocks.push({ type: "tools", turn, activities: tools });
      for (const tool of tools) used.add(tool.id);
    }
  }
  const leftover = activities.filter((item) => !used.has(item.id));
  if (leftover.length) blocks.push({ type: "tools", activities: leftover });
  return blocks;
}

/**
 * Names the Pi lifecycle phase the run is actually in.
 *
 * A reasoning model can spend tens of seconds generating privately before it
 * emits its first tool call or visible character. Naming the phase is not
 * chain-of-thought: it reports the lifecycle event the server already
 * published and exposes no reasoning content.
 */
export function presentTurnPhaseLabel(phase) {
  if (phase === "responding") return "正在思考";
  if (phase === "starting" || phase === "preparing") return "正在准备";
  return undefined;
}
