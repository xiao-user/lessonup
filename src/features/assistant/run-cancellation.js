const key = (threadId, branchId) => `lessonup:pending-run-cancel:v1:${threadId}:${branchId}`;
const terminal = status => ["cancelled", "completed", "failed", "awaiting_approval"].includes(status);
export function readPendingCancellation(threadId, branchId, storage = globalThis.sessionStorage) {
  try {
    const value = JSON.parse(storage.getItem(key(threadId, branchId)) || "null");
    return value?.threadId === threadId && value.branchId === branchId
      && (typeof value.clientCommandId === "string" || typeof value.runId === "string") ? value : null;
  } catch { return null; }
}
export function persistPendingCancellation(command, storage = globalThis.sessionStorage) {
  try { storage.setItem(key(command.threadId, command.branchId), JSON.stringify({
    threadId: command.threadId, branchId: command.branchId,
    clientCommandId: command.clientCommandId, runId: command.runId,
  })); } catch { /* In-memory command remains authoritative for this mount. */ }
}
export function clearPendingCancellation(threadId, branchId, storage = globalThis.sessionStorage) {
  try { storage.removeItem(key(threadId, branchId)); } catch { /* Storage can be unavailable. */ }
}

/** A lost reply is unknown. Only a matching durable terminal record settles it. */
export async function reconcileCancellation(command, { getRunCommand, cancelRun, loadMessages }) {
  let loaded;
  const run = command.clientCommandId
    ? (await getRunCommand(command.threadId, command.branchId, command.clientCommandId))?.run
    : (loaded = await loadMessages(command.threadId, command.branchId))?.presentation?.run;
  if (!run || run.threadId !== command.threadId || run.branchId !== command.branchId
    || (command.clientCommandId ? run.clientCommandId !== command.clientCommandId : run.id !== command.runId)) {
    return { phase: "cancel_pending" };
  }
  if (!terminal(run.status)) {
    await cancelRun(run.id).catch(() => undefined);
    loaded = undefined;
  }
  loaded ??= await loadMessages(command.threadId, command.branchId);
  const canonical = loaded?.presentation?.run;
  return canonical?.id === run.id && terminal(canonical.status)
    ? { phase: "terminal", run: canonical, loaded }
    : { phase: "cancel_pending", run };
}
