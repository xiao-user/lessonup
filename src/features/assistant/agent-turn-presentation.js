/**
 * Adapted from Craft Agents' TurnCard turn-phase presentation.
 * Craft Agents is licensed under Apache-2.0; see THIRD_PARTY_NOTICES.md.
 *
 * LessonUp intentionally exposes only safe progress phases and normalized tool
 * activity. Provider reasoning and chain-of-thought content never enter this model.
 */

export const agentTurnPhases = {
  pending: "pending",
  toolActive: "tool_active",
  awaiting: "awaiting",
  streaming: "streaming",
  complete: "complete",
  failed: "failed",
};

export function deriveAgentTurnPhase({ status, activities, responseText }) {
  if (status === "error") return agentTurnPhases.failed;
  if (status !== "streaming") return agentTurnPhases.complete;
  if (responseText?.trim()) return agentTurnPhases.streaming;
  if (activities.some((activity) => activity.state === "running")) {
    return agentTurnPhases.toolActive;
  }
  if (activities.length > 0) return agentTurnPhases.awaiting;
  return agentTurnPhases.pending;
}

export function shouldShowAgentThinking(phase) {
  return phase === agentTurnPhases.pending || phase === agentTurnPhases.awaiting;
}

export function agentActivitySummary(activities, phase) {
  const failed = activities.filter((activity) => activity.state === "failed").length;
  const needsRevision = activities.filter((activity) => activity.state === "needs_revision").length;
  const unchanged = activities.filter((activity) => activity.state === "unchanged").length;
  const completed = activities.filter((activity) => activity.state === "completed").length;
  const running = activities.find((activity) => activity.state === "running");
  if (running) {
    if (running.attempts > 1 && running.name?.startsWith("propose_")) {
      return `正在调整：${running.label}`;
    }
    return `正在执行：${running.label}`;
  }
  if (failed) return `${failed} 项任务失败`;
  if (needsRevision) return `${needsRevision} 项建议需调整`;
  if (unchanged && !completed) return "现稿已符合要求，无需修改";
  if (phase === agentTurnPhases.awaiting) return "任务完成，正在组织回复";
  return `已完成 ${completed + unchanged} 项任务`;
}

const mergedActivityState = (activities) => {
  if (activities.some((activity) => activity.state === "failed")) return "failed";
  if (activities.some((activity) => activity.state === "needs_revision")) return "needs_revision";
  if (activities.some((activity) => activity.state === "running")) return "running";
  if (activities.some((activity) => activity.state === "unchanged")) return "unchanged";
  return "completed";
};

export function presentAgentActivities(activities) {
  const result = [];
  const documentReads = [];
  let documentReadInsertIndex;
  const seen = new Map();

  for (const activity of activities) {
    if (activity.groupKey === "document-read") {
      documentReadInsertIndex ??= result.length;
      documentReads.push(activity);
      continue;
    }
    const key = `${activity.groupKey ?? activity.name}:${activity.label}`;
    const previousIndex = seen.get(key);
    if (previousIndex === undefined) {
      seen.set(key, result.length);
      result.push({ ...activity, attempts: 1 });
    } else {
      result[previousIndex] = {
        ...result[previousIndex],
        ...activity,
        attempts: (result[previousIndex].attempts ?? 1) + 1,
      };
    }
  }

  if (documentReads.length) {
    const uniqueLabels = [...new Set(documentReads.map((activity) => activity.label))];
    const visibleReads = [];
    if (uniqueLabels.length >= 4) {
      visibleReads.push({
        id: "document-read:all",
        name: "read_document",
        label: `读取整份教案（${uniqueLabels.length} 个栏目）`,
        groupKey: "document-read",
        state: mergedActivityState(documentReads),
      });
    } else {
      for (const label of uniqueLabels) {
        const matching = documentReads.filter((activity) => activity.label === label);
        visibleReads.push({
          ...matching[0],
          state: mergedActivityState(matching),
        });
      }
    }
    result.splice(documentReadInsertIndex ?? 0, 0, ...visibleReads);
  }

  return result;
}

export function presentConversationMessages(messages, approvals = []) {
  const continuationById = new Map();
  const approvalByOwnerId = new Map();
  for (const approval of approvals) {
    if (!approval.assistantMessageId || !approval.continuationMessageId) continue;
    approvalByOwnerId.set(approval.assistantMessageId, approval);
    continuationById.set(approval.continuationMessageId, approval);
  }
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const result = [];
  for (const message of messages) {
    if (continuationById.has(message.id)) continue;
    const approval = approvalByOwnerId.get(message.id);
    const continuation = approval?.continuationMessageId
      ? messageById.get(approval.continuationMessageId)
      : null;
    if (!continuation) {
      result.push(message);
      continue;
    }
    result.push({
      ...message,
      content: [message.content, continuation.content].filter(Boolean).join("\n\n"),
      status: continuation.status ?? message.status,
      error: continuation.error ?? message.error,
      sources: [...(message.sources ?? []), ...(continuation.sources ?? [])],
      continuationMessageId: continuation.id,
    });
  }
  return result;
}
