/**
 * Reconciles an approval's continuation with its originating assistant
 * message. The browser may have two records (proposal + continuation run);
 * the teacher-visible turn is still one reply: process, diff, then the
 * confirmation text — never a second 用时.
 */

function foldContinuation(owner, continuation, approval) {
  return {
    ...owner,
    continuationContent: continuation.content || undefined,
    continuationStatus: continuation.status,
    status: continuation.status ?? owner.status,
    error: approval.continuationError ?? continuation.error ?? owner.error,
    sources: [...(owner.sources ?? []), ...(continuation.sources ?? [])],
    continuationMessageId: continuation.id,
  };
}

function nextUninterruptedAssistant(messages, ownerIndex, owners, claimed) {
  for (let index = ownerIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate.role === "user") return null;
    if (candidate.role !== "assistant") continue;
    if (owners.has(candidate.id) || claimed.has(candidate.id)) return null;
    return candidate;
  }
  return null;
}

function continuationForOwner(messages, ownerIndex, approval, owners, claimed) {
  if (approval.continuationMessageId) {
    const found = messages.find((message) => message.id === approval.continuationMessageId);
    if (found) return found;
  }
  if (!["approved", "rejected"].includes(approval.state) && approval.transport !== "submitting") {
    return null;
  }
  return nextUninterruptedAssistant(messages, ownerIndex, owners, claimed);
}

export function presentConversationMessages(messages, approvals = []) {
  const approvalByOwnerId = new Map();
  const owners = new Set();
  for (const approval of approvals) {
    if (!approval.assistantMessageId) continue;
    approvalByOwnerId.set(approval.assistantMessageId, approval);
    owners.add(approval.assistantMessageId);
  }

  const claimed = new Set();
  const folded = new Map();
  messages.forEach((message, index) => {
    const approval = approvalByOwnerId.get(message.id);
    if (!approval) return;
    const continuation = continuationForOwner(messages, index, approval, owners, claimed);
    if (!continuation || continuation.id === message.id) return;
    claimed.add(continuation.id);
    folded.set(message.id, foldContinuation(message, continuation, approval));
  });

  return messages.flatMap((message) => {
    if (claimed.has(message.id) && !owners.has(message.id)) return [];
    return [folded.get(message.id) ?? message];
  });
}
