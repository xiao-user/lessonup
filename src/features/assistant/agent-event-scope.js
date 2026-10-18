// Scope identifies the turn an event belongs to. It is not evidence that the
// run is active: historical approval delivery also carries an explicit scope.
// Only run lifecycle owners register entries in the active-run map.
export function resolveAgentEventScope(scopes, event, explicitScope = null) {
  return scopes.get(event.runId) ?? explicitScope;
}

export function isAgentEventActive(scope, activeThreadId, activeBranchId) {
  return Boolean(
    scope
    && scope.threadId === activeThreadId
    && scope.branchId === activeBranchId
  );
}
