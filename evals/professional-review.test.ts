import { describe, expect, it } from "vitest";
import { createProfessionalPacket, packetFingerprint, professionalDimensions, summarizeProfessionalReviews } from "./professional-review.js";

function fixture() {
  const exported = createProfessionalPacket({ cases: [{ id: "secret-model-case", assistantResponse: "保留现稿，另用独立任务检查理解。",
    reviewMaterial: { prompt: "检查目标与评价是否对应", document: { objectives: "解释证据", assessment: "独立解释词句" }, businessContext: { subject: "语文" } },
    businessGrade: { score: 1 }, performance: { model: "secret-model" }, passed: true }] });
  const rating = (reviewerId: string, score = 3) => ({ packetId: exported.packet.packetId, packetFingerprint: packetFingerprint(exported.packet),
    sampleId: exported.packet.samples[0]!.sampleId, reviewerId, authorType: "human", independent: true,
    expertise: { subject: "语文", stage: "初中", experience: "教研与评价" },
    dimensions: Object.fromEntries(professionalDimensions.map((key) => [key, { score, evidence: "对应任务、成功判据与限制的具体表述" }])), criticalFindings: [],
  });
  return { ...exported, rating };
}

describe("professional review coverage and calibration", () => {
  it("exports canonical material without revealing source case, model, automation grade or pass flag", () => {
    const { packet, key } = fixture();
    expect(JSON.stringify(packet)).not.toMatch(/secret-model|businessGrade|performance|passed/);
    expect(packet.samples[0]!.material.document).toHaveProperty("assessment");
    expect(key.mapping[packet.samples[0]!.sampleId]).toBe("secret-model-case");
  });
  it("keeps empty failed answers in the sample instead of selecting only successful outputs", () => {
    const { packet } = fixture();
    const source = { results: [{ id: "incomplete", assistantResponse: "", reviewMaterial: packet.samples[0]!.material, passed: false }] };
    expect(createProfessionalPacket(source).packet.samples[0]!.response).toBe("");
  });
  it("keeps missing reviews pending, requires two independent reviews, and rejects duplicates", () => {
    const { packet, rating } = fixture();
    expect(summarizeProfessionalReviews(packet, []).samples[0]!.status).toBe("pending");
    expect(summarizeProfessionalReviews(packet, [rating("a")]).passed).toBe(false);
    expect(summarizeProfessionalReviews(packet, [rating("a"), rating("b")]).passed).toBe(true);
    expect(() => summarizeProfessionalReviews(packet, [rating("a"), rating("a")])).toThrow("duplicate_reviewer_rating");
  });
  it("never lets a high average hide a critical evidence fabrication or a large disagreement", () => {
    const { packet, rating } = fixture();
    const critical = { ...rating("a"), criticalFindings: [{ kind: "fabricated_evidence", evidence: "回复编造了学生作品数量" }] };
    expect(summarizeProfessionalReviews(packet, [critical, rating("b")]).samples[0]!.status).toBe("failed");
    expect(summarizeProfessionalReviews(packet, [rating("a"), rating("b", 1)]).samples[0]!.status).toBe("needs_adjudication");
    expect(summarizeProfessionalReviews(packet, [rating("a", 2), rating("b", 2)]).samples[0]!.status).toBe("failed");
  });
  it("rejects changed material, unknown samples, missing dimensions and model-authored reviews", () => {
    const { packet, rating } = fixture();
    const changed = structuredClone(packet); changed.samples[0]!.response = "另一份回答";
    expect(() => summarizeProfessionalReviews(changed, [rating("a")])).toThrow("review_material_mismatch");
    expect(() => summarizeProfessionalReviews(packet, [{ ...rating("a"), sampleId: crypto.randomUUID() }])).toThrow("review_material_mismatch");
    expect(() => summarizeProfessionalReviews(packet, [{ ...rating("a"), dimensions: {} }])).toThrow();
    expect(() => summarizeProfessionalReviews(packet, [{ ...rating("a"), authorType: "model" }])).toThrow();
  });
});
