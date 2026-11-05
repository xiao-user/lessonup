import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import {
  canCompactPiMemory,
  PI_MEMORY_SUMMARY_HARD_TOKENS,
  fitPiMemorySummary,
  piKeepRecentTokens,
  piMemorySummaryTokens,
  shouldCompactPiMemory,
} from "./memory.js";

const userMessage = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: Date.now(),
});

const withUsage = (message: ReturnType<typeof fauxAssistantMessage>, totalTokens: number) => ({
  ...message,
  usage: {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

describe("Pi memory compaction helpers", () => {
  it("does not compact a short dialogue that reports modest usage", () => {
    const transcript = [
      userMessage("第一轮"),
      withUsage(fauxAssistantMessage("完成"), 120),
    ];
    expect(estimateContextTokens(transcript).usageTokens).toBe(120);
    expect(shouldCompactPiMemory(transcript, 128_000)).toBe(false);
    expect(canCompactPiMemory(transcript, 128_000)).toBe(false);
  });

  it("compacts when last usage approaches the window minus reserve", () => {
    const transcript = [
      userMessage("第一轮"),
      withUsage(fauxAssistantMessage("完成"), 120_000),
      userMessage("第二轮"),
      fauxAssistantMessage("x".repeat(80_000)),
    ];
    expect(shouldCompactPiMemory(transcript, 128_000)).toBe(true);
    expect(canCompactPiMemory(transcript, 128_000)).toBe(true);
    expect(piKeepRecentTokens(128_000)).toBe(8_000);
  });

  it("includes the system, schema, and turn-policy overhead in the context budget", () => {
    const transcript = [
      userMessage("第一轮"), fauxAssistantMessage("完成"),
      userMessage("第二轮"), fauxAssistantMessage("完成"),
    ];
    expect(shouldCompactPiMemory(transcript, 10_000)).toBe(false);
    expect(shouldCompactPiMemory(transcript, 10_000, undefined, 20_000)).toBe(true);
  });

  it("trims an overlong summary to a total token budget without losing its cursor", () => {
    const verbose = "课程决策".repeat(150);
    const fitted = fitPiMemorySummary({
      schemaVersion: 1,
      runtime: "pi",
      summarizedThrough: 12,
      goals: Array.from({ length: 12 }, () => verbose),
      durableFacts: Array.from({ length: 16 }, () => verbose),
      decisions: Array.from({ length: 16 }, () => verbose),
      resourceReferences: Array.from({ length: 24 }, (_, index) => ({ kind: "lesson", id: `lesson-${index}` })),
      evidence: Array.from({ length: 24 }, () => ({ claim: verbose })),
      unresolved: Array.from({ length: 12 }, () => verbose),
      rejectedOrSuperseded: Array.from({ length: 12 }, () => verbose),
    });
    expect(fitted.summarizedThrough).toBe(12);
    expect(piMemorySummaryTokens(fitted)).toBeLessThanOrEqual(PI_MEMORY_SUMMARY_HARD_TOKENS);
    expect(fitted.goals.length).toBeGreaterThan(0);
  });

  it("preserves unresolved work before generic background facts when trimming", () => {
    const verbose = "背景事实".repeat(120);
    const fitted = fitPiMemorySummary({
      schemaVersion: 1,
      runtime: "pi",
      summarizedThrough: 8,
      goals: ["继续完成当前教案"],
      durableFacts: Array.from({ length: 16 }, (_, index) => `${index}:${verbose}`),
      decisions: ["已经确认保留当前教学目标"],
      resourceReferences: [],
      evidence: [],
      unresolved: ["仍需补充评价证据"],
      rejectedOrSuperseded: [],
    }, 500);
    expect(fitted.unresolved).toEqual(["仍需补充评价证据"]);
    expect(fitted.decisions).toEqual(["已经确认保留当前教学目标"]);
    expect(fitted.durableFacts.length).toBeLessThan(16);
  });
});
