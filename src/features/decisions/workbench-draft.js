const PREFIX = "lessonup:workbench-draft:v1";
const keyFor = (kind, fileId, ownerId) => ownerId && fileId ? `${PREFIX}:${ownerId}:${fileId}:${kind}` : null;

export function readWorkbenchDraft(kind, fileId, ownerId) {
  const key = keyFor(kind, fileId, ownerId);
  if (!key) return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (saved?.schemaVersion !== 1 || saved.ownerId !== ownerId || saved.fileId !== fileId) return null;
    return saved.value ?? null;
  } catch { return null; }
}

export function writeWorkbenchDraft(kind, fileId, ownerId, value) {
  const key = keyFor(kind, fileId, ownerId);
  if (!key) return false;
  try {
    if (!value.mode && !value.pending) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify({ schemaVersion: 1, ownerId, fileId, value }));
    return true;
  } catch { return false; }
}
