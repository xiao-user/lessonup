import { describe, expect, it } from "vitest";
import { deterministicCapabilityPlan } from "../agent/capability-router.js";
import { presentationLanguageForRequest, resolvePresentationTurn, type PendingPresentationInteraction } from "./presentation-turn.js";

const request = "基于当前教案生成课堂 PPT";
const requestedAt = "2026-08-20T00:00:00.000Z";
const resourceId = "lesson-a";
const task = (overrides: Partial<PendingPresentationInteraction> = {}): PendingPresentationInteraction => ({
  kind: "presentation_generation", originalRequest: request, documentVersion: 4,
  requestedAt, confirmedTheme: "theme09", resourceId, ...overrides,
});
const resolve = (message: string, pendingInteraction?: PendingPresentationInteraction | null, version = 4, resource = resourceId) => resolvePresentationTurn({
  message, routedPlan: deterministicCapabilityPlan(message), pendingInteraction,
  documentVersion: version, resourceId: resource, now: requestedAt,
});

// These tests model the persisted protocol, including intervening conversation,
// rather than merely asserting that isolated retry words match a regex.
describe("presentation turn protocol", () => {
  it("binds Dashi language from the original teacher request", () => {
    expect(presentationLanguageForRequest("请生成 PPT，使用 theme02")).toBe("zh");
    expect(presentationLanguageForRequest("Create a classroom deck with theme02")).toBe("en");
    expect(presentationLanguageForRequest("02")).toBeUndefined();
  });

  it("continues immediately from a numeric theme choice", () => {
    const result = resolve("02", task({ kind: "presentation_theme", confirmedTheme: undefined }));
    expect(result.plan).toMatchObject({
      presentationRequested: true, presentationThemeConfirmationRequired: false,
      confirmedPresentationTheme: "theme02", skillIds: ["dashi-ppt"],
    });
    expect(result.presentationRequest).toBe(request);
    expect(result.pendingInteraction).toMatchObject({ kind: "presentation_generation", confirmedTheme: "theme02", resourceId });
  });

  it.each(["presentation_theme", "presentation_generation"] as const)("does not recover %s across a changed document snapshot", (kind) => {
    const result = resolve("确认主题：金色指数风（theme10）", task({ kind }), 5);
    expect(result.plan.presentationRequested).toBe(false);
    expect(result.pendingInteraction).toBeNull();
    expect(result.expiredInteraction).toBe(true);
  });

  it.each(["presentation_theme", "presentation_generation"] as const)("does not recover %s across a different resource", (kind) => {
    const result = resolve("继续", task({ kind }), 4, "lesson-b");
    expect(result.plan.presentationRequested).toBe(false);
    expect(result.pendingInteraction).toBeNull();
    expect(result.expiredInteraction).toBe(true);
  });

  it("does not assign legacy unscoped state to a resource supplied by the caller", () => {
    const result = resolve("02", task({ kind: "presentation_theme", resourceId: undefined }));
    expect(result.plan.presentationRequested).toBe(false);
    expect(result.pendingInteraction).toBeNull();
    expect(result.expiredInteraction).toBe(true);
  });

  it.each(["重新试试", "继续生成PPT", "确认主题：金色指数风（theme10）", "由你选择合适的主题"])("surfaces an expired task for explicit recovery rather than falling back: %s", (message) => {
    const result = resolve(message, task(), 5);
    expect(result.expiredInteraction).toBe(true);
    expect(result.pendingInteraction).toBeNull();
    expect(result.presentationRequest).toBe(message);
  });

  it.each(["谢谢", "为什么这个故事适合本课？", "theme10是什么风格？"])("silently clears an expired task during unrelated discussion: %s", (message) => {
    const result = resolve(message, task(), 5);
    expect(result.expiredInteraction).toBeUndefined();
    expect(result.pendingInteraction).toBeNull();
    expect(result.plan.presentationRequested).toBe(false);
  });

  it("creates a new current-snapshot task from a complete fresh request despite stale pending", () => {
    const fresh = "请基于当前教案制作新的PPT，使用theme10";
    const result = resolve(fresh, task(), 5, "lesson-b");
    expect(result.expiredInteraction).toBeUndefined();
    expect(result.plan).toMatchObject({ presentationRequested: true, confirmedPresentationTheme: "theme10" });
    expect(result.pendingInteraction).toMatchObject({ originalRequest: fresh, documentVersion: 5, resourceId: "lesson-b" });
  });

  it.each(["好的", "谢谢", "为什么这个故事适合本课？", "theme10是什么风格？", "你来选择一个例子"])("suspends rather than consumes the task during ordinary conversation: %s", (message) => {
    const saved = task();
    const result = resolve(message, saved);
    expect(result.plan.presentationRequested).toBe(false);
    expect(result.presentationRequest).toBe(message);
    expect(result.pendingInteraction).toEqual({ ...saved, resumeReferenceRequired: true });
  });

  it("retains an unanswered theme choice across ordinary conversation without generating", () => {
    const saved = task({ kind: "presentation_theme", confirmedTheme: undefined });
    const discussion = resolve("好的", saved);
    expect(discussion.plan.presentationRequested).toBe(false);
    expect(discussion.pendingInteraction).toMatchObject({ kind: "presentation_theme", resumeReferenceRequired: true });
    const choice = resolve("确认主题：金色指数风（theme10）", discussion.pendingInteraction);
    expect(choice.plan.confirmedPresentationTheme).toBe("theme10");
    expect(choice.presentationRequest).toBe(request);
  });

  it("keeps retry identity and fixed theme after a failure", () => {
    const result = resolve("重新试试", task());
    expect(result.plan).toMatchObject({ presentationRequested: true, confirmedPresentationTheme: "theme09" });
    expect(result.presentationRequest).toBe(request);
    expect(result.pendingInteraction).toMatchObject({ requestedAt, documentVersion: 4, resourceId, confirmedTheme: "theme09" });
  });

  it("requires a presentation reference for a bare retry after intervening conversation", () => {
    const discussion = resolve("请解释四步法", task());
    const ambiguous = resolve("继续", discussion.pendingInteraction);
    expect(ambiguous.plan.presentationRequested).toBe(false);
    expect(ambiguous.pendingInteraction).toMatchObject({ originalRequest: request });
    const resumed = resolve("继续刚才的PPT", ambiguous.pendingInteraction);
    expect(resumed.plan).toMatchObject({ presentationRequested: true, confirmedPresentationTheme: "theme09" });
    expect(resumed.presentationRequest).toBe(request);
    expect(resumed.pendingInteraction?.resumeReferenceRequired).toBeUndefined();
  });

  it("supports the production retry then explicit theme confirmation without changing task identity", () => {
    const failed = task({ confirmedTheme: undefined });
    const retry = resolve("重新试试", failed);
    const confirmation = resolve("确认主题：金色指数风（theme10）", retry.pendingInteraction);
    expect(retry.plan.presentationRequested).toBe(true);
    expect(confirmation.plan).toMatchObject({ presentationRequested: true, confirmedPresentationTheme: "theme10" });
    expect(confirmation.pendingInteraction).toMatchObject({ originalRequest: request, requestedAt, documentVersion: 4, resourceId });
  });

  it("delegates first selection without inventing a bound theme, then preserves the tool-persisted choice", () => {
    const delegated = resolve("由你选择合适的主题", task({ kind: "presentation_theme", confirmedTheme: undefined }));
    expect(delegated.plan.presentationRequested).toBe(true);
    expect(delegated.plan.confirmedPresentationTheme).toBeUndefined();
    const toolBound = { ...delegated.pendingInteraction!, confirmedTheme: "theme10" };
    const retried = resolve("重新试试", toolBound);
    expect(retried.plan.confirmedPresentationTheme).toBe("theme10");
    expect(retried.presentationRequest).toBe(request);
  });

  it.each(["取消", "算了", "不要生成"])("clears recoverable state only on explicit dismissal: %s", (message) => {
    const result = resolve(message, task());
    expect(result.plan.presentationRequested).toBe(false);
    expect(result.plan.presentationThemeDismissed).toBe(true);
    expect(result.pendingInteraction).toBeNull();
    expect(resolve("重新试试", result.pendingInteraction).plan.presentationRequested).toBe(false);
  });

  it("starts a fresh request rather than resuming an unrelated suspended original", () => {
    const fresh = "为第二课时制作PPT，使用theme03";
    const result = resolve(fresh, task({ resumeReferenceRequired: true }));
    expect(result.plan).toMatchObject({ presentationRequested: true, confirmedPresentationTheme: "theme03" });
    expect(result.presentationRequest).toBe(fresh);
    expect(result.pendingInteraction).toMatchObject({ originalRequest: fresh, requestedAt, resourceId });
  });

  it("asks for a theme only for a fresh presentation request without a choice", () => {
    const result = resolve(request);
    expect(result.plan.presentationThemeConfirmationRequired).toBe(true);
    expect(result.pendingInteraction).toEqual({
      kind: "presentation_theme", originalRequest: request, documentVersion: 4,
      requestedAt, confirmedTheme: undefined, resourceId,
    });
  });
});
