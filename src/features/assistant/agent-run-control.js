import { approvalPhase } from "./approval-state.js";

export async function stopAgentRun({ runId, cancelRun, controller, reloadMessages }) {
  if (runId) await cancelRun(runId).catch(() => null);
  controller?.abort();
  await reloadMessages();
}

const isProposeActivityName = (name) => typeof name === "string" && name.startsWith("propose_");

const lastProposalToolCallId = (activities) => [...(activities ?? [])]
  .reverse()
  .find((activity) => isProposeActivityName(activity?.name))?.id;

/**
 * Tool calls that a durable confirmation item proves passed preflight and were
 * materialized. Attribution comes from the proposing call the server recorded,
 * so a run that self-corrected after a rejected preflight keeps that earlier
 * attempt visibly unsuccessful. Approvals persisted before that id existed fall
 * back to the run's last proposal call, the only one that could have produced
 * the card.
 */
export function approvalBackedToolCallIds(activities, approvals) {
  const records = (approvals ?? []).filter(Boolean);
  if (!records.length) return new Set();
  const attributed = records
    .map((approval) => approval.toolCallId)
    .filter((toolCallId) => typeof toolCallId === "string" && toolCallId.length > 0);
  if (attributed.length) return new Set(attributed);
  const fallback = lastProposalToolCallId(activities);
  return new Set(fallback ? [fallback] : []);
}

/** Mirror of server/agent/tool-completion-outcome.ts for browser event projection. */
export function toolCompletionOutcomeOf(event) {
  if (event?.outcome) return event.outcome;
  if (event?.ok) return "completed";
  if (event?.revisionCode === "no_effect_patch") return "no_change";
  if (event?.revisionCode) return "needs_revision";
  return "failed";
}

export function activityStateForToolCompletion(event, { approvalBackedToolCalls } = {}) {
  if (event?.toolCallId && approvalBackedToolCalls?.has(event.toolCallId)) {
    return "completed";
  }
  const outcome = toolCompletionOutcomeOf(event);
  if (outcome === "completed") return "completed";
  if (outcome === "no_change") return "unchanged";
  if (outcome === "needs_revision") return "needs_revision";
  return "failed";
}

export function activitiesFromEvents(events, runStatus = null) {
  const activities = [];
  let failed = runStatus === "failed";
  let cancelled = runStatus === "cancelled";
  let settled = runStatus === "completed" || runStatus === "awaiting_approval";
  // A proposal's completion event precedes the approval it creates, so
  // attribution is resolved after the whole journal has been read.
  let approvalSeen = false;
  const attributedToolCalls = new Set();
  for (const event of events) {
    if (event.type === "tool.started") {
      activities.push({
        id: event.toolCallId,
        name: event.name,
        label: event.label,
        detail: event.detail,
        groupKey: event.groupKey,
        state: "running",
        turn: event.turn,
      });
    }
    if (event.type === "tool.updated") {
      const index = activities.findIndex((activity) => activity.id === event.toolCallId);
      if (index >= 0) {
        activities[index] = {
          ...activities[index],
          label: event.label ?? activities[index].label,
          detail: event.detail ?? activities[index].detail,
          progress: event.progress ?? activities[index].progress,
          turn: event.turn ?? activities[index].turn,
        };
      }
    }
    if (event.type === "tool.completed") {
      const index = activities.findIndex((activity) => activity.id === event.toolCallId);
      if (index >= 0) {
        const outcome = toolCompletionOutcomeOf(event);
        activities[index] = {
          ...activities[index],
          state: activityStateForToolCompletion(event),
          label: event.label,
          detail: event.detail ?? activities[index].detail,
          groupKey: event.groupKey ?? activities[index].groupKey,
          outcome,
          revisionCode: event.revisionCode,
          turn: event.turn ?? activities[index].turn,
        };
      }
    }
    if (event.type === "approval.required") {
      approvalSeen = true;
      if (event.toolCallId) attributedToolCalls.add(event.toolCallId);
    }
    if (event.type === "approval.decided") approvalSeen = true;
    if (event.type === "run.failed") failed = true;
    if (event.type === "run.cancelled") cancelled = true;
    if (event.type === "run.completed") settled = true;
  }
  const fallbackToolCallId = approvalSeen && !attributedToolCalls.size
    ? lastProposalToolCallId(activities)
    : undefined;
  const approvalBackedToolCalls = fallbackToolCallId
    ? new Set([fallbackToolCallId])
    : attributedToolCalls;
  return activities.map((activity) => {
    // A confirmation item proves that this proposal call was materialized and
    // passed preflight. Older runs could later emit a false stale failure when
    // the SDK acknowledged that same call after approval.
    if (approvalBackedToolCalls.has(activity.id)) {
      return { ...activity, state: "completed", outcome: "completed" };
    }
    if (activity.state !== "running") return activity;
    if (cancelled) return { ...activity, state: "cancelled", outcome: "cancelled" };
    if (failed) return { ...activity, state: "failed", outcome: "failed" };
    if (settled) return { ...activity, state: "completed", outcome: "completed" };
    return activity;
  });
}

export function queuedInputsFromEvents(events, runStatus = null) {
  let queued = [];
  for (const event of events) {
    if (event.type === "agent.input.queued") {
      queued = [...queued.filter((item) => item.id !== event.queueId), {
        id: event.queueId,
        content: event.content,
        delivery: event.delivery,
        state: "queued",
      }];
    }
    if (event.type === "agent.input.cleared") {
      queued = queued.filter((item) => (
        event.delivery !== "all" && item.delivery !== event.delivery
      ));
    }
  }
  if (["completed", "awaiting_approval"].includes(runStatus)) {
    return queued.map((item) => ({ ...item, state: "completed" }));
  }
  if (runStatus === "cancelled" || runStatus === "failed") {
    return queued.map((item) => ({ ...item, state: runStatus }));
  }
  return queued;
}

/** Pending human-in-the-loop answers always resolve the interaction as a new Turn. */
export function agentInputDisposition(status, pendingInteraction) {
  return status === "streaming" && !pendingInteraction ? "queue" : "start_turn";
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
    selection_context_stale: {
      message: "选区对应的教案内容已变化，请重新选择当前文字后发送。",
      retryLabel: "重新选择后再试",
    },
    decision_context_stale: {
      message: "所选教学判断已更新，请回到教学决策核对最新取舍后再准备修改。",
      retryLabel: "核对决策后再试",
    },
    design_basis_context_stale: {
      message: "教案设计依据已在其他会话中更新。为避免把过期判断写入教案，本轮已停止。",
      retryLabel: "基于最新依据重新生成",
    },
    resource_context_stale: {
      message: "当前页面不是云端最新学期框架。为避免助手基于过期规划回答，请重新打开框架后再试。",
      retryLabel: "重新打开后再试",
    },
    stale_resource: {
      message: "目标框架字段已被教师或另一会话更新，本次建议没有覆盖新内容。",
      retryLabel: "基于最新框架重新生成",
    },
    stale_design_basis: {
      message: "这项建议引用的学情或教学决定已经变化，本次投影没有写入教案。",
      retryLabel: "基于最新依据重新生成",
    },
    run_interrupted: {
      message: "服务中断后，本轮回复已安全终止；未确认的修改不会写入。",
      retryLabel: "编辑后重新发送",
    },
    run_not_continuable: {
      message: "当前失败任务已没有可继续的 Pi 上下文，请编辑原消息后重新发送。",
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
      message: "助手生成的修改没有通过当前教案或设计依据校验，因此没有创建确认项，也没有写入教案。",
      retryLabel: "重新读取后生成",
    },
    write_proposal_missing: {
      message: "助手没有完成教师要求的修改提案，因此没有创建确认项，也没有写入内容。",
      retryLabel: "从已有读取继续",
    },
    presentation_proposal_missing: {
      message: "助手已完成部分演示规划，但没有提交可确认的最终 Dashi 演示内容。",
      retryLabel: "继续完成演示",
    },
    patch_target_ambiguous: {
      message: "教案中存在多处相同原文，助手这次没有提供足以区分目标位置的信息，因此没有创建确认项。",
      retryLabel: "指定位置后重试",
    },
    approval_expired: {
      message: "这项修改建议已经过期，请基于当前教案重新生成。",
      retryLabel: "基于最新内容重新生成",
    },
    approval_resume_failed: {
      message: "你的确认已写入；后续说明未能完成，可直接继续提问，不会重复写入。",
      retryLabel: "继续新一轮",
    },
    agent_rate_limited: {
      message: "模型服务当前请求较多，请稍后重试。",
      retryLabel: "稍后重试",
    },
    agent_provider_unavailable: {
      message: "暂时无法连接模型服务。本轮尚未开始生成，也没有读取资料或修改教案。",
      retryLabel: "重新发送",
    },
    agent_provider_error: {
      message: "模型在本轮生成中异常结束。已经完成的安全工具记录仍会保留，未确认的修改不会写入。",
      retryLabel: "从已有进度继续",
    },
    agent_provider_protocol_error: {
      message: "模型返回的工具或消息协议不完整，本轮已安全停止，未确认的修改不会写入。",
      retryLabel: "从已有进度继续",
    },
    agent_transcript_incomplete: {
      message: "本轮 Pi 会话没有形成完整的消息与工具结果单元，系统已保留最后一个可恢复检查点。",
      retryLabel: "从检查点继续",
    },
    agent_session_conflict: {
      message: "同一分支的 Pi 会话已被另一项操作推进，本轮没有覆盖较新的会话状态。",
      retryLabel: "刷新后继续",
    },
    agent_context_window_exceeded: {
      message: "当前会话历史在压缩后仍超过模型上下文窗口，本轮没有向模型发送不完整内容。",
      retryLabel: "新建会话继续",
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

/**
 * A presentation continuation stored before Dashi goals became durable can no
 * longer be resumed, so it must not hold the conversation open.
 */
const isObsoleteLegacyContinuation = (approval) => Boolean(
  approval?.continuationStatus === "ready"
  && approval.patch?.kind === "presentation_storyboard"
  && !approval.patch.goal,
);

/**
 * True only while the Turn has stopped and owes the teacher a decision. Once
 * decided, the continuation run owns the Turn again.
 */
export const isAwaitingTeacherDecision = (approval) => approvalPhase(approval) === "pending";

/** The single definition of which approval still owns the conversation. */
export function activeApprovalFrom(approvals) {
  return [...(approvals ?? [])].reverse().find((item) => (
    approvalPhase(item) !== "settled"
  )) ?? null;
}

export function deriveBranchRuntimeState({
  runtimeAvailable,
  approvals = [],
  persistedRun,
  localRunId = null,
  hasLocalStream = false,
}) {
  const obsoleteLegacyContinuation = approvals.some((item) => (
    isObsoleteLegacyContinuation(item) && item.runId === persistedRun?.id
  ));
  const activeApproval = activeApprovalFrom(approvals.filter((item) => (
    !(item.patch && "baseDocumentVersion" in item.patch)
    || ["ready", "running"].includes(item.continuationStatus)
    || (persistedRun?.id === item.runId && persistedRun.status === "awaiting_approval")
  )));
  if (activeApproval) {
    const phase = approvalPhase(activeApproval);
    return {
      status: phase === "syncing" ? "syncing" : phase === "executing" ? "streaming" : "awaiting_approval",
      runId: activeApproval.runId ?? persistedRun?.id ?? null,
      error: null,
    };
  }
  const persistedRunning = persistedRun?.status === "running" || persistedRun?.status === "queued";
  const localAlreadySettled = persistedRun?.id === localRunId
    && ["completed", "cancelled", "failed"].includes(persistedRun?.status);
  if (persistedRunning || (!localAlreadySettled && (localRunId || hasLocalStream))) {
    return {
      status: "streaming",
      runId: localRunId ?? persistedRun?.id ?? null,
      error: null,
    };
  }
  // A terminal failure is rendered by its durable assistant message. It does
  // not lock the conversation: a teacher's next send is an intentional new
  // run, while the failed run remains available for retry or inspection.
  if (persistedRun?.status === "failed" || obsoleteLegacyContinuation) {
    return { status: runtimeAvailable ? "ready" : "unconfigured", runId: null, error: null };
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

/**
 * A historical failed turn remains inspectable, but it must not become the
 * default conversation on every page load: an old provider outage would then
 * prevent the teacher from starting a fresh, healthy conversation.
 */
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
