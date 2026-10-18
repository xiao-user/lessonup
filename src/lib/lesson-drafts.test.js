import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLessonDraft, lessonDraftFields, lessonDraftKey, lessonDraftScope, readLessonDrafts, reconcileLessonDraft, removeLessonDraft, resolveLessonDraftConflict, writeLessonDraft } from "./lesson-drafts.js";
const plan = (fields = {}) => ({ ...Object.fromEntries(lessonDraftFields.map((field) => [field, ""])), ...fields });
const scope = { ownerId: "teacher-a", fileId: "lesson-1" };
const draft = (base, document, options = {}) => createLessonDraft(scope, base, 3, document, { id: "tab-a", updatedAt: 100, ...options });
const storage = () => {
  const values = new Map();
  return { get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};

describe("owner-scoped durable lesson drafts", () => {
  it("does not infer ownership from file id or accept conflicting owner metadata", () => {
    assert.equal(lessonDraftScope({ id: "lesson-1" }, {}), null);
    assert.equal(lessonDraftScope({ id: "lesson-1", ownerId: "b" }, { ownerId: "a" }), null);
    assert.deepEqual(lessonDraftScope({ id: "lesson-1" }, { ownerId: "a" }), { ownerId: "a", fileId: "lesson-1" });
  });
  it("writes synchronously before any network/debounce and isolates owners and files", () => {
    const store = storage();
    const record = draft(plan(), plan({ objectives: "解释相似点" }));
    writeLessonDraft(store, record);
    assert.equal(JSON.parse(store.getItem(lessonDraftKey(record))).document.objectives, "解释相似点");
    assert.deepEqual(readLessonDrafts(store, scope), [record]);
    assert.deepEqual(readLessonDrafts(store, { ...scope, ownerId: "teacher-b" }), []);
    assert.deepEqual(readLessonDrafts(store, { ...scope, fileId: "lesson-2" }), []);
    assert.throws(() => readLessonDrafts(store, { fileId: "lesson-1" }), /draft_owner_unavailable/);
  });
  it("retains independent tabs instead of overwriting one draft", () => {
    const store = storage();
    writeLessonDraft(store, draft(plan(), plan({ objectives: "甲" })));
    writeLessonDraft(store, draft(plan(), plan({ objectives: "乙" }), { id: "tab-b" }));
    assert.equal(readLessonDrafts(store, scope).length, 2);
  });
  it("does not erase newer typing when an old response arrives", () => {
    const store = storage();
    const first = draft(plan(), plan({ objectives: "第一句" }));
    const second = { ...first, document: plan({ objectives: "第二句" }), updatedAt: 101 };
    writeLessonDraft(store, first); writeLessonDraft(store, second, first);
    removeLessonDraft(store, first);
    assert.deepEqual(readLessonDrafts(store, scope), [second]);
    assert.throws(() => writeLessonDraft(store, first, first), /draft_changed_elsewhere/);
  });
  it("does not claim durability when storage is unavailable", () => {
    const store = storage();
    store.setItem = () => { throw new Error("QuotaExceededError"); };
    assert.throws(() => writeLessonDraft(store, draft(plan(), plan({ objectives: "保留" }))), /QuotaExceededError/);
    assert.equal(store.length, 0);
  });
  it("keeps the newly keyed baseline even if old-key cleanup fails", () => {
    const store = storage();
    const first = draft(plan(), plan({ objectives: "保留" }));
    writeLessonDraft(store, first);
    const rebased = { ...first, baseVersion: 4, updatedAt: 100 };
    store.removeItem = () => { throw new Error("storage unavailable"); };
    writeLessonDraft(store, rebased, first);
    assert.deepEqual(readLessonDrafts(store, scope), [rebased]);
  });
});

describe("canonical reconciliation", () => {
  it("restores the draft against an unchanged canonical baseline", () => {
    const base = plan({ topic: "春" });
    const result = reconcileLessonDraft(draft(base, { ...base, objectives: "解释表达效果" }), base, 3);
    assert.equal(result.synchronized, false);
    assert.equal(result.document.objectives, "解释表达效果");
    assert.deepEqual(result.conflicts, []);
  });
  it("recognizes an already committed draft, including unrelated remote updates", () => {
    const base = plan(); const local = plan({ objectives: "解释" });
    const result = reconcileLessonDraft(draft(base, local), { ...local, preparation: "远端新材料" }, 5);
    assert.equal(result.synchronized, true);
    assert.equal(result.document.preparation, "远端新材料");
    assert.equal(result.attempt, null);
  });
  it("rebases different-field remote updates without losing either edit", () => {
    const base = plan({ assessment: "识别" });
    const result = reconcileLessonDraft(draft(base, { ...base, objectives: "解释" }), { ...base, preparation: "远端材料" }, 4);
    assert.equal(result.document.objectives, "解释"); assert.equal(result.document.preparation, "远端材料");
    assert.equal(result.document.assessment, "识别"); assert.deepEqual(result.conflicts, []);
  });
  it("keeps same-field conflicts blocked after reload until an explicit choice", () => {
    const base = plan({ objectives: "起点" });
    const original = draft(base, { ...base, objectives: "本机" });
    const remote = { ...base, objectives: "云端" };
    const result = reconcileLessonDraft(original, remote, 4);
    assert.deepEqual(result.conflicts, [{ field: "objectives", base: "起点", local: "本机", remote: "云端" }]);
    const restored = createLessonDraft(scope, remote, 4, result.document, { id: original.id, conflicts: result.conflicts });
    assert.equal(reconcileLessonDraft(restored, remote, 4).conflicts.length, 1);
    const resolved = resolveLessonDraftConflict(restored, "objectives", remote.objectives);
    assert.equal(reconcileLessonDraft(resolved, remote, 4).synchronized, true);
  });
  it("acknowledges a lost response and preserves typing after its submitted snapshot", () => {
    const base = plan(); const submitted = plan({ objectives: "已提交第一句" });
    const attempt = { plan: submitted, pageCount: 1, source: "manual", baseDocumentVersion: 3, idempotencyKey: "same-command" };
    const record = draft(base, { ...submitted, objectives: "提交后继续输入" }, { attempt });
    const result = reconcileLessonDraft(record, { ...submitted, preparation: "他人补充" }, 5);
    assert.equal(result.attempt, null); assert.equal(result.document.objectives, "提交后继续输入");
    assert.equal(result.document.preparation, "他人补充"); assert.deepEqual(result.conflicts, []);
  });
  it("retains an unresolved attempt unchanged when the head has not moved", () => {
    const base = plan(); const local = plan({ objectives: "待保存" });
    const attempt = { plan: local, pageCount: 2, source: "manual", baseDocumentVersion: 3, idempotencyKey: "same-command" };
    assert.deepEqual(reconcileLessonDraft(draft(base, local, { attempt }), base, 3).attempt, attempt);
  });
  it("does not discard an in-flight write when the teacher has already undone it", () => {
    const base = plan(); const submitted = plan({ objectives: "在途内容" });
    const attempt = { plan: submitted, pageCount: 1, source: "manual", baseDocumentVersion: 3, idempotencyKey: "in-flight" };
    const record = draft(base, base, { attempt });
    const beforeCommit = reconcileLessonDraft(record, base, 3);
    assert.equal(beforeCommit.synchronized, false);
    assert.deepEqual(beforeCommit.attempt, attempt);
    const afterCommit = reconcileLessonDraft(record, submitted, 4);
    assert.equal(afterCommit.attempt, null);
    assert.equal(afterCommit.synchronized, false);
    assert.equal(afterCommit.document.objectives, "");
  });
  it("invalidates a stale command after another commit and blocks rollback", () => {
    const base = plan(); const local = plan({ objectives: "待保存" });
    const record = draft(base, local, { attempt: { plan: local, pageCount: 1, source: "manual", baseDocumentVersion: 3, idempotencyKey: "old" } });
    assert.equal(reconcileLessonDraft(record, { ...base, preparation: "新材料" }, 4).attempt, null);
    assert.throws(() => reconcileLessonDraft(record, base, 2), /draft_newer_than_canonical/);
  });
});
