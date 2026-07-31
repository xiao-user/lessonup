export function resolveAgentEventScope(scopes, event, explicitScope = null) {
  if (
    explicitScope
    && event.runId
    && event.runId !== "unknown"
    && !scopes.has(event.runId)
  ) {
    scopes.set(event.runId, explicitScope);
  }
  return scopes.get(event.runId) ?? explicitScope;
}

export function isAgentEventActive(scope, activeThreadId, activeBranchId) {
  return Boolean(
    scope
    && scope.threadId === activeThreadId
    && scope.branchId === activeBranchId
  );
}
