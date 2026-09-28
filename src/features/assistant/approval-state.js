// Durable decision and continuation are independent facts. Never replace the
// server's decision with a UI phase or infer an execution failure from a fetch.
export function approvalPhase(approval) {
  if (!approval) return "settled";
  if (approval.continuationStatus === "completed" || approval.state === "expired") return "settled";
  if (approval.transport === "unknown") return "syncing";
  if (approval.transport === "submitting") return "executing";
  if (approval.continuationStatus !== "running" && Date.parse(approval.expiresAt) <= Date.now()) return "settled";
  if (approval.state === "pending") return "pending";
  if (approval.continuationStatus === "running") return "executing";
  if (approval.continuationStatus === "ready") {
    // Only authoritative continuation errors affect recoverability. A local
    // network/refresh exception must never expire a valid decision.
    if (["approval_expired", "stale_document", "stale_design_basis", "stale_resource"].includes(approval.continuationError)) return "settled";
    if (approval.patch?.kind === "presentation_storyboard" && !approval.patch.goal) return "settled";
    return "recoverable";
  }
  return "settled";
}

export function approvalInteraction(approval, resourceLabel) {
  const phase = approvalPhase(approval);
  const goal = approval?.patch?.kind === "presentation_storyboard" ? approval.patch.goal : null;
  if (phase === "settled") return null;
  if (phase === "syncing") return {
    action: "sync", primaryLabel: "重新同步",
    description: "暂未确认服务端结果。请同步状态，不要重复提交。",
  };
  if (phase === "executing") return {
    busy: true,
    description: approval.delivery?.status === "ready"
      ? "演示已保存，正在完成助手回复。"
      : approval.state === "pending" ? "正在提交你的决定。" : "决定已保存，正在继续执行。",
  };
  if (phase === "recoverable") {
    const needsDelivery = goal && approval.state === "approved" && approval.delivery?.status !== "ready";
    return {
      action: "resume",
      primaryLabel: needsDelivery ? "恢复生成" : "恢复回复",
      description: needsDelivery
        ? "方案已确认，交付尚未完成。继续执行时会复用已保存的结果。"
        : approval.state === "rejected"
          ? "已记录拒绝决定，仅需恢复助手回复。"
          : goal ? "演示已保存，仅需恢复助手回复，不会重新生成。"
            : `修改已保存到${resourceLabel}，仅需恢复助手回复，不会重复写入。`,
    };
  }
  return {
    action: "decide",
    primaryLabel: goal ? "确认并生成" : "接受修改",
    secondaryLabel: goal ? "退回调整" : "拒绝",
    description: goal ? `演示目标：${goal.goal} · ${goal.themePack} · ${goal.slides.length} 页` : "确认前不会写入任何修改。",
  };
}

/** Apply only server facts; replay cannot reopen a completed approval. */
export function approvalEvent(approvals, event) {
  if (event.type === "approval.required") {
    if (approvals.some((item) => item.id === event.approvalId)) return approvals;
    return [...approvals, {
      id: event.approvalId, runId: event.runId,
      assistantMessageId: event.assistantMessageId, toolCallId: event.toolCallId,
      patch: event.patch, state: "pending", continuationStatus: "pending",
    }];
  }
  return approvals.map((item) => {
    if (item.runId !== event.runId || item.continuationStatus === "completed") return item;
    if (event.type === "run.cancelled" && item.state === "pending") {
      return { ...item, state: "expired", transport: undefined };
    }
    if (event.type === "approval.settled" && item.id === event.approvalId) {
      return { ...item, state: event.decision, continuationStatus: "completed", transport: undefined };
    }
    if (event.type === "approval.decided" && item.id === event.approvalId) {
      return { ...item, state: event.decision, continuationStatus: "running", transport: undefined };
    }
    if (event.type === "approval.delivered" && item.id === event.approvalId) {
      return { ...item, delivery: { status: "ready", presentationId: event.presentationId } };
    }
    if (["run.completed", "run.cancelled"].includes(event.type) && ["approved", "rejected"].includes(item.state)) {
      return { ...item, continuationStatus: "completed", transport: undefined };
    }
    return item;
  });
}

export function reconcileApprovals(current, incoming) {
  const byId = new Map(current.map((item) => [item.id, item]));
  return incoming.map((record) => {
    const previous = byId.get(record.id);
    if (previous?.continuationStatus === "completed" && record.continuationStatus !== "completed") return previous;
    if (record.state === "pending" && previous?.decisionError) return { ...record, decisionError: previous.decisionError };
    return record;
  });
}
