import { describe, expect, it } from "vitest";

import {
  createDecisionPacket,
  decisionDimensions,
  decisionPacketFingerprint,
  summarizeDecisionReviews,
} from "./decision-quality.js";

const cases = [
  {
    caseId: "case-1", decisionType: "goal_evidence", context: "五年级语文，理解反复的表达效果。",
    baseline: "以出口条复述反复的作用作为达成证据。",
    treatment: "以无提示新段落中的解释作为达成证据，比较两个选项并说明取舍。",
  },
  {
    caseId: "case-2", decisionType: "scaffolding", context: "五年级语文，表达困难学生的支架。",
    baseline: "给表达困难学生降低目标。",
    treatment: "保留共同目标，提供句式支架并在独立任务中检查。",
  },
];

function ratingsFor(packet: ReturnType<typeof createDecisionPacket>["packet"], key: ReturnType<typeof createDecisionPacket>["key"], reviewerId: string, score: (sampleId: string) => number) {
  return packet.samples.map((sample) => ({
    packetId: packet.packetId,
    packetFingerprint: key.packetFingerprint,
    sampleId: sample.sampleId,
    reviewerId,
    expertise: { subject: "语文", stage: "小学", experience: "10 年" },
    dimensions: Object.fromEntries(decisionDimensions.map((dimension) => [dimension, { score: score(sample.sampleId), evidence: "可定位证据与取舍说明。" }])),
    criticalFindings: [],
  }));
}

describe("decision quality review package", () => {
  it("blinds baseline and treatment behind random sample ids", () => {
    const { packet, key } = createDecisionPacket({ cases });
    expect(packet.samples).toHaveLength(4);
    expect(Object.keys(key.mapping)).toHaveLength(4);
    expect(key.packetFingerprint).toBe(decisionPacketFingerprint(packet));
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain("baseline");
    expect(serialized).not.toContain("treatment");
    expect(serialized).not.toContain("case-1");
  });

  it("reports a paired difference and perfect agreement when reviewers agree", () => {
    const { packet, key } = createDecisionPacket({ cases });
    const score = (sampleId: string) => key.mapping[sampleId].variant === "treatment" ? 3 : 2;
    const ratings = [
      ...ratingsFor(packet, key, "reviewer-a", score),
      ...ratingsFor(packet, key, "reviewer-b", score),
    ];
    const report = summarizeDecisionReviews(packet, key, ratings);
    expect(report.status).toBe("reviewed");
    expect(report.summary.meanDifference).toBe(1);
    expect(report.summary.agreement.decision_clarity).toBe(1);
    expect(report.disagreements).toEqual([]);
  });

  it("keeps the review pending until two reviewers cover every sample", () => {
    const { packet, key } = createDecisionPacket({ cases });
    const ratings = ratingsFor(packet, key, "reviewer-a", () => 2);
    const report = summarizeDecisionReviews(packet, key, ratings);
    expect(report.status).toBe("pending");
    expect(report.incompleteSamples).toHaveLength(4);
  });

  it("rejects duplicate reviewer ratings against the same packet", () => {
    const { packet, key } = createDecisionPacket({ cases });
    const ratings = ratingsFor(packet, key, "reviewer-a", () => 2);
    expect(() => summarizeDecisionReviews(packet, key, [...ratings, ...ratings])).toThrow("duplicate_reviewer_rating");
  });
});
