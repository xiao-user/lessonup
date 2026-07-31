export async function stopAgentRun({ runId, cancelRun, controller, reloadMessages }) {
  if (runId) await cancelRun(runId).catch(() => null);
  controller?.abort();
  await reloadMessages();
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
      message: "正在重新连接这次回复，请稍候。",
      retryLabel: "重新检查",
    },
    active_run_exists: {
      message: "当前会话已有一项任务正在处理，请先等待、停止或完成审批。",
      retryLabel: "重新检查",
    },
    knowledge_attachment_unavailable: {
      message: "附带资料已被删除、尚未解析完成，或已随另一条消息发送。请重新选择资料。",
      retryLabel: "重新选择资料",
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
