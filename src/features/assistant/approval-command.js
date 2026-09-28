/**
 * Transport has no authority to undo a decision or create a recovery command.
 * Even an ordinary EOF can be ambiguous; the snapshot resolves that case.
 * Post-command reads are independent and cannot be caught as execution errors.
 */
export async function executeApprovalCommand({ execute, onEvent, synchronize }) {
  let terminal = null;
  let transportError = null;
  try {
    await execute((event) => {
      if (terminal) return;
      if (["approval.settled", "approval.failed", "run.completed", "run.cancelled", "run.failed"].includes(event.type)) terminal = event.type;
      onEvent(event);
    });
  } catch (error) {
    transportError = error;
  }
  const synchronization = await synchronize();
  return { terminal, transportError, synchronization };
}
