export async function stopAgentRun({ runId, cancelRun, controller, reloadMessages }) {
  if (runId) await cancelRun(runId).catch(() => null);
  controller?.abort();
  await reloadMessages();
}

export function presentAgentError(error) {
  if (error === "stale_document") {
    return {
      message: "教案内容已在其他会话或编辑器中更新，本次建议没有写入。",
      retryLabel: "基于最新内容重新生成",
    };
  }
  if (error === "document_save_failed") {
    return {
      message: "当前教案尚未成功保存，请先确认保存状态后再让助手继续。",
      retryLabel: "重新尝试",
    };
  }
  if (error === "run_interrupted") {
    return {
      message: "这次回复已中断，没有在后台自动继续。",
      retryLabel: "重新生成",
    };
  }
  return {
    message: error,
    retryLabel: "重试上一轮",
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
