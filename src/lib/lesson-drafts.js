// D1 remains canonical. These records only retain unacknowledged teacher edits.
export const lessonDraftFields = ["unit", "period", "totalPeriods", "topic", "objectives", "knowledgePoints", "continuity", "focus", "preparation", "process", "assessment", "homework", "board", "reflection"];
const prefix = "lessonup.lesson-draft.v1:";
const validPlan = (plan) => plan && lessonDraftFields.every((field) => typeof plan[field] === "string");
export const sameLessonDocument = (left, right) => validPlan(left) && validPlan(right) && lessonDraftFields.every((field) => left[field] === right[field]);

export function lessonDraftScope(file, notebook) {
  const ownerId = file?.ownerId || notebook?.ownerId;
  if (!ownerId || !file?.id || (file.ownerId && notebook?.ownerId && file.ownerId !== notebook.ownerId)) return null;
  return { ownerId, fileId: file.id };
}
const scopePrefix = (scope) => {
  if (!scope?.ownerId || !scope?.fileId) throw new Error("draft_owner_unavailable");
  return `${prefix}${encodeURIComponent(scope.ownerId)}:${encodeURIComponent(scope.fileId)}:`;
};
export const lessonDraftKey = (record) => `${scopePrefix(record)}${record.baseVersion}:${encodeURIComponent(record.id)}`;

export function createLessonDraft(scope, baseDocument, baseVersion, document, options = {}) {
  scopePrefix(scope);
  if (!validPlan(baseDocument) || !validPlan(document) || !Number.isInteger(baseVersion) || baseVersion < 0) throw new Error("invalid_lesson_draft");
  return {
    schemaVersion: 1, ...scope, id: options.id ?? crypto.randomUUID(), baseVersion,
    baseDocument: { ...baseDocument }, document: { ...document },
    updatedAt: options.updatedAt ?? Date.now(), attempt: options.attempt ?? null,
    conflicts: options.conflicts ?? [],
  };
}

function validRecord(record, scope) {
  return record?.schemaVersion === 1 && record.ownerId === scope.ownerId && record.fileId === scope.fileId
    && typeof record.id === "string" && Number.isInteger(record.baseVersion) && record.baseVersion >= 0
    && validPlan(record.baseDocument) && validPlan(record.document) && Number.isFinite(record.updatedAt)
    && Array.isArray(record.conflicts) && record.conflicts.every((entry) => lessonDraftFields.includes(entry.field)
      && [entry.base, entry.local, entry.remote].every((value) => typeof value === "string"))
    && (!record.attempt || (typeof record.attempt.idempotencyKey === "string" && validPlan(record.attempt.plan)
      && Number.isInteger(record.attempt.baseDocumentVersion) && record.attempt.baseDocumentVersion >= 0
      && Number.isInteger(record.attempt.pageCount) && record.attempt.pageCount >= 1
      && ["manual", "undo"].includes(record.attempt.source)));
}

export function readLessonDrafts(storage, scope) {
  const scopedPrefix = scopePrefix(scope);
  const records = new Map();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(scopedPrefix)) continue;
    let record;
    try { record = JSON.parse(storage.getItem(key)); } catch { throw new Error("invalid_lesson_draft"); }
    if (!validRecord(record, scope) || lessonDraftKey(record) !== key) throw new Error("invalid_lesson_draft");
    const previous = records.get(record.id);
    if (!previous || record.baseVersion > previous.baseVersion || (record.baseVersion === previous.baseVersion && record.updatedAt > previous.updatedAt)) records.set(record.id, record);
  }
  return [...records.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function removeLessonDraft(storage, record) {
  const key = lessonDraftKey(record);
  if (storage.getItem(key) === JSON.stringify(record)) storage.removeItem(key);
}

export function writeLessonDraft(storage, record, previous = null) {
  if (!validRecord(record, record)) throw new Error("invalid_lesson_draft");
  const key = lessonDraftKey(record);
  const existing = storage.getItem(key);
  if (existing && (!previous || existing !== JSON.stringify(previous))) throw new Error("draft_changed_elsewhere");
  storage.setItem(key, JSON.stringify(record)); // Synchronous: no debounce/reload gap.
  if (previous && lessonDraftKey(previous) !== key) {
    try { removeLessonDraft(storage, previous); } catch { /* The new record is durable; the older keyed copy is safe to retain. */ }
  }
  return record;
}

function changesAlreadyPresent(base, draft, canonical) {
  return lessonDraftFields.every((field) => draft[field] === base[field] || draft[field] === canonical[field]);
}

export function reconcileLessonDraft(record, canonical, version) {
  if (!validPlan(canonical) || version < record.baseVersion) throw new Error("draft_newer_than_canonical");
  let base = record.baseDocument;
  let attempt = record.attempt;
  if (attempt && changesAlreadyPresent(base, attempt.plan, canonical)) {
    base = attempt.plan;
    attempt = null;
  } else if (attempt && version !== attempt.baseDocumentVersion) {
    attempt = null;
  }
  const document = { ...canonical };
  const conflicts = [];
  for (const field of lessonDraftFields) {
    const local = record.document[field];
    const remote = canonical[field];
    const carried = record.conflicts.find((entry) => entry.field === field);
    if (local === remote) continue;
    if (carried) {
      document[field] = local;
      conflicts.push({ field, base: carried.base, local, remote });
    } else if (local !== base[field]) {
      document[field] = local;
      if (remote !== base[field]) conflicts.push({ field, base: base[field], local, remote });
    }
  }
  return {
    document, conflicts, attempt,
    synchronized: !attempt && conflicts.length === 0 && sameLessonDocument(document, canonical),
    baseDocument: { ...canonical }, baseVersion: version,
  };
}

export function resolveLessonDraftConflict(record, field, value) {
  if (!record.conflicts.some((entry) => entry.field === field) || typeof value !== "string") throw new Error("invalid_draft_resolution");
  return { ...record, document: { ...record.document, [field]: value }, conflicts: record.conflicts.filter((entry) => entry.field !== field), updatedAt: Date.now() };
}
