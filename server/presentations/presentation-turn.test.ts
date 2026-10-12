import { describe, expect, it } from "vitest";
import { deterministicCapabilityPlan } from "../agent/capability-router.js";
import { presentationLanguageForRequest, resolvePresentationTurn } from "./presentation-turn.js";

const request = "基于当前教案生成课堂 PPT";
const requestedAt = "2026-08-20T00:00:00.000Z";

describe("presentation turn protocol", () => {
  it("binds Dashi language from the original teacher request", () => {
    expect(presentationLanguageForRequest("请生成 PPT，使用 theme02")).toBe("zh");
    expect(presentationLanguageForRequest("Create a classroom deck with theme02")).toBe("en");
    expect(presentationLanguageForRequest("02")).toBeUndefined();
  });

  it("continues immediately from a numeric theme choice", () => {
    const result = resolvePresentationTurn({
      message: "02",
      routedPlan: deterministicCapabilityPlan("02"),
      documentVersion: 4,
      pendingInteraction: { kind: "presentation_theme", originalRequest: request, documentVersion: 4, requestedAt },
    });

    expect(result.plan).toMatchObject({
      presentationRequested: true,
      presentationThemeConfirmationRequired: false,
      confirmedPresentationTheme: "theme02",
      skillIds: ["dashi-ppt"],
    });
    expect(result.presentationRequest).toBe(request);
    expect(result.pendingInteraction).toMatchObject({ kind: "presentation_generation", confirmedTheme: "theme02" });
  });

  it("keeps a pending theme choice across an editor autosave and binds generation to the latest version", () => {
    const result = resolvePresentationTurn({
      message: "theme01",
      routedPlan: deterministicCapabilityPlan("theme01"),
      documentVersion: 5,
      pendingInteraction: { kind: "presentation_theme", originalRequest: request, documentVersion: 4, requestedAt },
    });

    expect(result.plan).toMatchObject({
      presentationRequested: true,
      confirmedPresentationTheme: "theme01",
      skillIds: ["dashi-ppt"],
    });
    expect(result.presentationRequest).toBe(request);
    expect(result.pendingInteraction).toMatchObject({ kind: "presentation_generation", documentVersion: 5 });
  });

  it("does not let an acknowledgement consume a pending theme request", () => {
    const result = resolvePresentationTurn({
      message: "好的",
      routedPlan: deterministicCapabilityPlan("好的"),
      documentVersion: 4,
      pendingInteraction: { kind: "presentation_theme", originalRequest: request, documentVersion: 4, requestedAt },
    });

    expect(result.plan.presentationRequested).toBe(false);
    expect(result.plan.presentationThemeDismissed).toBe(true);
    expect(result.pendingInteraction).toBeNull();
  });

  it("does not restart a pending generation from ordinary conversation", () => {
    const result = resolvePresentationTurn({
      message: "谢谢",
      routedPlan: deterministicCapabilityPlan("谢谢"),
      documentVersion: 4,
      pendingInteraction: {
        kind: "presentation_generation",
        originalRequest: request,
        documentVersion: 4,
        requestedAt,
        confirmedTheme: "theme02",
      },
    });

    expect(result.plan.presentationRequested).toBe(false);
    expect(result.pendingInteraction).toBeNull();
  });

  it("preserves the confirmed theme for an explicit retry", () => {
    const result = resolvePresentationTurn({
      message: "继续",
      routedPlan: deterministicCapabilityPlan("继续"),
      documentVersion: 4,
      pendingInteraction: {
        kind: "presentation_generation",
        originalRequest: request,
        documentVersion: 4,
        requestedAt,
        confirmedTheme: "theme09",
      },
    });

    expect(result.plan).toMatchObject({ presentationRequested: true, confirmedPresentationTheme: "theme09" });
    expect(result.presentationRequest).toBe(request);
  });

  it("does not retry generation against a changed document snapshot", () => {
    const result = resolvePresentationTurn({
      message: "继续",
      routedPlan: deterministicCapabilityPlan("继续"),
      documentVersion: 5,
      pendingInteraction: {
        kind: "presentation_generation",
        originalRequest: request,
        documentVersion: 4,
        requestedAt,
        confirmedTheme: "theme09",
      },
    });

    expect(result.plan.presentationRequested).toBe(false);
    expect(result.pendingInteraction).toBeNull();
  });

  it("asks for a theme only for a fresh presentation request without a choice", () => {
    const result = resolvePresentationTurn({
      message: request,
      routedPlan: deterministicCapabilityPlan(request),
      documentVersion: 4,
      now: requestedAt,
    });

    expect(result.plan.presentationThemeConfirmationRequired).toBe(true);
    expect(result.pendingInteraction).toEqual({
      kind: "presentation_theme",
      originalRequest: request,
      documentVersion: 4,
      requestedAt,
      confirmedTheme: undefined,
    });
  });
});
