import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const professionalDimensions = ["content_accuracy", "diagnostic_reasoning", "instruction_alignment", "classroom_feasibility", "evidence_calibration", "inclusion_and_transfer"] as const;
export const professionalAnchors: Record<typeof professionalDimensions[number], string[]> = {
  content_accuracy: ["关键学科判断错误或编造依据", "内容大致相关，关键概念或适用条件含混", "学科解释正确，能对应给定课程材料与课时边界", "准确处理概念边界、反例及资料冲突，说明取舍"],
  diagnostic_reasoning: ["把猜测当真实学情或给学生贴固定标签", "列出泛化错因，没有区分解释的证据", "区分观察与假设，提出替代解释和可检验预期", "设计能区分主要解释与替代解释的检查，考虑反证"],
  instruction_alignment: ["活动或评价无法检验关键目标", "目标、活动、产出之间只有口号式联系", "目标对应具体任务、学生产出与成功判据", "判据能指导后续教学决定，避免用参与和完成替代理解"],
  classroom_feasibility: ["无法实施或违反明确课堂条件", "主要动作、时间容量或教师负担未处理", "教师动作、学生任务和材料可执行，符合已知约束", "最小充分调整，处理失败分支与教师工作量，保留有效设计"],
  evidence_calibration: ["编造观察或把采用、前后变化称为因果效果", "能说不确定，但关键结论超出证据", "核对来源、目标、任务、判据、群体与提示，结论强度合适", "主动定位缺失、冲突与混杂条件，允许不改或无法判断，并提出最有价值的下一证据"],
  inclusion_and_transfer: ["排除学生或以固定能力标签决定机会", "机械分层或强行跨学科，未检查独立学习", "支架适合任务，保留共同学习目标，区分提示下作答与独立完成", "以适当新任务、延迟或迁移检验学习；跨学科联系服务问题，并处理表达或参与障碍"],
};

const materialSchema = z.object({
  prompt: z.string().min(1), document: z.unknown().refine((value) => value !== undefined), businessContext: z.unknown().refine((value) => value !== undefined),
}).strict();
const sampleSchema = z.object({ sampleId: z.string().uuid(), material: materialSchema, response: z.string() }).strict();
export const professionalPacketSchema = z.object({
  version: z.literal(1), packetId: z.string().uuid(), samples: z.array(sampleSchema).min(1),
}).strict();
export type ProfessionalPacket = z.infer<typeof professionalPacketSchema>;
export const professionalRatingSchema = z.object({
  packetId: z.string().uuid(), packetFingerprint: z.string().length(64), sampleId: z.string().uuid(),
  reviewerId: z.string().trim().min(1), authorType: z.literal("human"), independent: z.literal(true),
  expertise: z.object({ subject: z.string().trim().min(1), stage: z.string().trim().min(1), experience: z.string().trim().min(1) }).strict(),
  dimensions: z.object(Object.fromEntries(professionalDimensions.map((key) => [key, z.object({
    score: z.number().int().min(0).max(3), evidence: z.string().trim().min(1),
  }).strict()])) as Record<typeof professionalDimensions[number], z.ZodObject<{ score: z.ZodNumber; evidence: z.ZodString }>>).strict(),
  criticalFindings: z.array(z.object({
    kind: z.enum(["fabricated_evidence", "causal_overclaim", "content_error", "exclusion"]), evidence: z.string().trim().min(1),
  }).strict()),
}).strict();

export function packetFingerprint(packet: ProfessionalPacket) {
  return createHash("sha256").update(JSON.stringify(professionalPacketSchema.parse(packet))).digest("hex");
}

/** Export only canonical task/context/output. Hide automated grades and identity metadata. */
export function createProfessionalPacket(raw: unknown) {
  // The isolated native smoke runner uses `results`; the authenticated API
  // evaluation runner uses `cases`. Both must include the same review material.
  if (raw && typeof raw === "object" && "results" in raw && !("cases" in raw)) raw = { ...raw, cases: raw.results };
  const report = z.object({ cases: z.array(z.object({
    id: z.string().min(1), assistantResponse: z.string(), reviewMaterial: materialSchema,
  })).min(1) }).parse(raw);
  const mapping: Record<string, string> = {};
  const samples = report.cases.map((item) => {
    const sampleId = randomUUID(); mapping[sampleId] = item.id;
    return { sampleId, material: item.reviewMaterial, response: item.assistantResponse };
  });
  // Random IDs also produce a randomized order without exposing source case IDs.
  samples.sort((a, b) => a.sampleId.localeCompare(b.sampleId));
  const packet: ProfessionalPacket = { version: 1, packetId: randomUUID(), samples };
  return { packet, key: { packetId: packet.packetId, packetFingerprint: packetFingerprint(packet), mapping } };
}

export function summarizeProfessionalReviews(rawPacket: unknown, rawRatings: unknown) {
  const packet = professionalPacketSchema.parse(rawPacket);
  const fingerprint = packetFingerprint(packet);
  const ratings = z.array(professionalRatingSchema).parse(rawRatings);
  const sampleIds = new Set(packet.samples.map((item) => item.sampleId));
  if (sampleIds.size !== packet.samples.length) throw new Error("duplicate_review_sample");
  const seen = new Set<string>();
  for (const rating of ratings) {
    if (rating.packetId !== packet.packetId || rating.packetFingerprint !== fingerprint || !sampleIds.has(rating.sampleId)) throw new Error("review_material_mismatch");
    const id = JSON.stringify([rating.sampleId, rating.reviewerId]);
    if (seen.has(id)) throw new Error("duplicate_reviewer_rating");
    seen.add(id);
  }
  const samples = packet.samples.map((sample) => {
    const reviews = ratings.filter((item) => item.sampleId === sample.sampleId);
    const disagreements = professionalDimensions.filter((dimension) => reviews.length > 1
      && Math.max(...reviews.map((item) => item.dimensions[dimension].score)) - Math.min(...reviews.map((item) => item.dimensions[dimension].score)) >= 2);
    const criticalFindings = reviews.flatMap((item) => item.criticalFindings.map((finding) => ({ reviewerId: item.reviewerId, ...finding })));
    const scores = reviews.flatMap((item) => professionalDimensions.map((key) => item.dimensions[key].score));
    const average = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
    const status = criticalFindings.length ? "failed" : reviews.length < 2 ? "pending"
      : disagreements.length ? "needs_adjudication" : scores.some((value) => value < 2) || average! < 2.5 ? "failed" : "passed";
    return { sampleId: sample.sampleId, status, reviewers: reviews.length, average, disagreements, criticalFindings };
  });
  return { packetId: packet.packetId, packetFingerprint: fingerprint, passed: samples.every((item) => item.status === "passed"), samples,
    boundary: "Human ratings are self-attested. This checks coverage and disagreements, not reviewer credentials, expert accreditation or actual classroom effectiveness." };
}
