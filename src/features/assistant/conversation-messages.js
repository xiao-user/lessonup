/**
 * Reconciles an approval's durable continuation with its originating assistant
 * message. This is persistence reconciliation, not a UI presentation layer.
 */
export function presentConversationMessages(messages, approvals = []) {
  const continuationById = new Map();
  const approvalByOwnerId = new Map();
  for (const approval of approvals) {
    if (!approval.assistantMessageId || !approval.continuationMessageId) continue;
    approvalByOwnerId.set(approval.assistantMessageId, approval);
    continuationById.set(approval.continuationMessageId, approval);
  }
  const messageById = new Map(messages.map((message) => [message.id, message]));
  return messages.flatMap((message) => {
    if (continuationById.has(message.id)) return [];
    const approval = approvalByOwnerId.get(message.id);
    const continuation = approval?.continuationMessageId
      ? messageById.get(approval.continuationMessageId)
      : null;
    if (!continuation) return [message];
    return [{
      ...message,
      content: [message.content, continuation.content].filter(Boolean).join("\n\n"),
      status: continuation.status ?? message.status,
      error: approval.continuationError ?? continuation.error ?? message.error,
      sources: [...(message.sources ?? []), ...(continuation.sources ?? [])],
      continuationMessageId: continuation.id,
    }];
  });
}
