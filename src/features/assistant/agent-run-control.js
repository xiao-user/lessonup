export async function stopAgentRun({ runId, cancelRun, controller, reloadMessages }) {
  if (runId) await cancelRun(runId).catch(() => null);
  controller?.abort();
  await reloadMessages();
}

export function activitiesFromEvents(events, runStatus = null) {
  const activities = [];
  let failed = runStatus === "failed";
  let completed = runStatus === "completed";
  for (const event of events) {
    if (event.type === "tool.started") {
      activities.push({
        id: event.toolCallId,
        name: event.name,
        label: event.label,
        groupKey: event.groupKey,
        state: "running",
      });
    }
    if (event.type === "tool.completed") {
      const index = activities.findIndex((activity) => activity.id === event.toolCallId);
      if (index >= 0) {
        activities[index] = {
          ...activities[index],
          state: event.ok ? "completed" : "failed",
          label: event.label,
          groupKey: event.groupKey ?? activities[index].groupKey,
        };
      }
    }
    if (event.type === "run.failed") failed = true;
    if (event.type === "run.completed") completed = true;
  }
  return activities.map((activity) => {
    if (activity.state !== "running") return activity;
    if (failed) return { ...activity, state: "failed" };
    if (completed) return { ...activity, state: "completed" };
    return activity;
  });
}

export function presentAgentError(error) {
  const known = {
    stale_document: {
      message: "教案内容已在其他会话或编辑器中更新，本次建议没有写入。",
      retryLabel: "基于最新内容重新生成",
    },
    document_save_failed: {
      message: "当前教案尚未成功保存，请先确认保存状态后再让助手继续。",
      retryLabel: "重新尝试",
    },
    document_context_stale: {
      message: "当前页面不是云端最新教案。为避免助手基于错误内容回答，请关闭并重新打开这份教案。",
      retryLabel: "重新打开后再试",
    },
    run_interrupted: {
      message: "服务中断后，本轮回复已安全终止；未确认的修改不会写入。",
      retryLabel: "编辑后重新发送",
    },
    active_run_exists: {
      message: "当前会话已有一项任务正在处理，请先等待、停止或完成审批。",
      retryLabel: "重新检查",
    },
    knowledge_attachment_unavailable: {
      message: "附带资料已被删除、尚未解析完成，或已随另一条消息发送。请重新选择资料。",
      retryLabel: "重新选择资料",
    },
    attachment_not_bound_to_run: {
      message: "这份资料不属于当前消息，助手没有读取它。请重新附加后再试。",
      retryLabel: "重新选择资料",
    },
    evidence_required: {
      message: "这项回答依赖可核验资料，但助手没有实际读取到足够证据，因此本轮已停止。",
      retryLabel: "补充资料后重试",
    },
    insufficient_business_context: {
      message: "当前缺少课时长度或学情信息，无法可靠支持这项精确判断。",
      retryLabel: "补充条件后重试",
    },
    unverified_patch_citation: {
      message: "修改建议引用了本轮未实际读取的来源，因此已被安全拦截。",
      retryLabel: "重新读取来源",
    },
    invalid_patch_proposal: {
      message: "助手提出的修改无法唯一对应当前原文，因此没有创建确认项，也没有写入教案。",
      retryLabel: "重新读取后生成",
    },
    approval_expired: {
      message: "这项修改建议已经过期，请基于当前教案重新生成。",
      retryLabel: "基于最新内容重新生成",
    },
    approval_resume_failed: {
      message: "修改决定已经保存，但后续回复未能恢复。教案状态不会被重复写入。",
      retryLabel: "继续新一轮",
    },
    agent_rate_limited: {
      message: "模型服务当前请求较多，请稍后重试。",
      retryLabel: "稍后重试",
    },
    agent_timeout: {
      message: "本轮处理超时，未确认的修改不会写入。",
      retryLabel: "编辑后重新发送",
    },
    agent_run_failed: {
      message: "备课助手本轮未能完成，未确认的修改不会写入。",
      retryLabel: "编辑后重新发送",
    },
  };
  return known[error] ?? {
    message: "备课助手本轮未能完成，未确认的修改不会写入。",
    retryLabel: "编辑后重新发送",
  };
}

export function branchDisplayLabel(branch, index) {
  return branch?.label === "分支" ? `分支 ${index + 1}` : branch?.label ?? "消息分支";
}

export function deriveBranchRuntimeState({
  runtimeAvailable,
  approvals = [],
  persistedRun,
  localRunId = null,
  hasLocalStream = false,
}) {
  const activeApproval = [...approvals].reverse().find((item) => (
    item.state === "pending"
    || item.state === "responding"
    || item.state === "continuation"
  ));
  if (activeApproval) {
    return {
      status: activeApproval.state === "responding" ? "streaming" : "awaiting_approval",
      runId: activeApproval.runId ?? persistedRun?.id ?? null,
      error: null,
    };
  }
  const persistedRunning = persistedRun?.status === "running" || persistedRun?.status === "queued";
  if (localRunId || persistedRunning || hasLocalStream) {
    return {
      status: "streaming",
      runId: localRunId ?? persistedRun?.id ?? null,
      error: null,
    };
  }
  if (persistedRun?.status === "failed") {
    return {
      status: "error",
      runId: null,
      error: persistedRun.error ?? "agent_run_failed",
    };
  }
  return {
    status: runtimeAvailable ? "ready" : "unconfigured",
    runId: null,
    error: null,
  };
}

export function resetAgentConversationState({ runtime, setApproval, setError, setRunId, setStatus }) {
  setApproval(null);
  setError(null);
  setRunId(null);
  setStatus(runtime?.agent ? "ready" : "unconfigured");
}

export async function synchronizeCompletedAgentTurn({ threadId, branchId, loadMessages, listThreads }) {
  await loadMessages(threadId, branchId);
  return listThreads();
}

export async function resolveBranchSourceMessage(message, listMessages) {
  if (!message.id.startsWith("optimistic-")) return { message, records: null };
  const records = await listMessages();
  const persisted = [...records].reverse().find((record) => (
    record.role === message.role && record.content === message.content && !record.id.startsWith("optimistic-")
  ));
  if (!persisted) throw new Error("branch_source_message_not_persisted");
  return { message: persisted, records };
}

export function lastRetryableUserMessage(messages) {
  return [...messages].reverse().find((message) => message.role === "user" && message.status !== "streaming") ?? null;
}

export function canRetryApprovalDecision(error) {
  return !new Set([
    "approval_expired",
    "stale_document",
  ]).has(error);
}
