import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

/** Decision quality is reviewed separately from the lesson's subject content. */
export const decisionDimensions = [
  "decision_clarity",
  "evidence_locatability",
  "alternatives_counterevidence",
  "uncertainty_applicability",
  "verification_signal",
  "teacher_usability",
] as const;
export type DecisionDimension = (typeof decisionDimensions)[number];

export const decisionAnchors: Record<DecisionDimension, string[]> = {
  decision_clarity: [
    "只描述内容或活动，没有可命名的判断",
    "有判断，但选项、范围或责任人不清楚，难以执行",
    "判断明确：要改变什么、保持什么、在什么条件下成立",
    "判断聚焦关键不确定性，能直接指导课堂取舍并说明不做什么",
  ],
  evidence_locatability: [
    "无来源、无法定位，或编造课标/教材/学生表现",
    "有来源名称但缺少定位、版本或与判断的关联",
    "证据可定位、版本明确，并说明支撑哪一项判断",
    "区分一手证据、二手解读与合成材料；主动标出冲突与失效条件",
  ],
  alternatives_counterevidence: [
    "只给一个方案，没有比较，也没有反例",
    "列出备选但没有实质取舍，或反例只是形式",
    "至少比较两个选项的代价与收益，并给出反例或替代解释",
    "用可区分证据的方式处理主要解释与替代解释，说明为何放弃其他选项",
  ],
  uncertainty_applicability: [
    "把不确定当确定，或把单次表现推广到所有学生",
    "笼统说不确定，但没有说明缺什么证据、影响哪些结论",
    "说明适用范围、假设与不确定性，不超出证据",
    "明确哪些结论暂不可下、缺哪类证据，并给出最小可行的下一步",
  ],
  verification_signal: [
    "没有预期信号，或只用完成活动/采用方案代替效果",
    "有检查方式，但不可观察或与判断无关",
    "给出可观察的预期信号与时间点，区分提示下表现与独立表现",
    "预设证伪条件，包含保持/迁移或延迟检查，并说明无法验证时的处理",
  ],
  teacher_usability: [
    "无法在真实课时与工作量内使用",
    "信息冗长或缺少执行顺序，教师需要重新组织",
    "教师能在现有课时内理解、检查并执行，负担可控",
    "最小充分信息：先给判断与证据，按需展开；保留教师最终决定权",
  ],
};

const briefSchema = z.object({
  caseId: z.string().trim().min(1),
  decisionType: z.string().trim().min(1),
  context: z.string().trim().min(1),
  baseline: z.string().trim().min(1),
  treatment: z.string().trim().min(1),
}).strict();

export const decisionPacketSchema = z.object({
  version: z.literal(1),
  packetId: z.string().uuid(),
  samples: z.array(z.object({
    sampleId: z.string().uuid(),
    decisionType: z.string().min(1),
    context: z.string().min(1),
    brief: z.string().min(1),
  }).strict()).min(2),
}).strict();
export type DecisionPacket = z.infer<typeof decisionPacketSchema>;

export const decisionRatingSchema = z.object({
  packetId: z.string().uuid(),
  packetFingerprint: z.string().length(64),
  sampleId: z.string().uuid(),
  reviewerId: z.string().trim().min(1),
  expertise: z.object({
    subject: z.string().trim().min(1),
    stage: z.string().trim().min(1),
    experience: z.string().trim().min(1),
  }).strict(),
  dimensions: z.object(Object.fromEntries(decisionDimensions.map((dimension) => [dimension, z.object({
    score: z.number().int().min(0).max(3),
    evidence: z.string().trim().min(1),
  }).strict()])) as Record<DecisionDimension, z.ZodObject<{ score: z.ZodNumber; evidence: z.ZodString }>>).strict(),
  criticalFindings: z.array(z.object({
    kind: z.enum(["fabricated_evidence", "causal_overclaim", "content_error", "exclusion"]),
    evidence: z.string().trim().min(1),
  }).strict()).default([]),
}).strict();
export type DecisionRating = z.infer<typeof decisionRatingSchema>;

export function decisionPacketFingerprint(packet: DecisionPacket) {
  return createHash("sha256").update(JSON.stringify(decisionPacketSchema.parse(packet))).digest("hex");
}

/** Pair baseline/treatment briefs, then hide the variant label behind random sample ids. */
export function createDecisionPacket(raw: unknown) {
  const input = z.object({ cases: z.array(briefSchema).min(1) }).parse(
    Array.isArray(raw) ? { cases: raw } : raw,
  );
  if (new Set(input.cases.map((item) => item.caseId)).size !== input.cases.length) throw new Error("duplicate_decision_case");
  const mapping: Record<string, { caseId: string; variant: "baseline" | "treatment" }> = {};
  const samples = input.cases.flatMap((item) => (["baseline", "treatment"] as const).map((variant) => {
    const sampleId = randomUUID();
    mapping[sampleId] = { caseId: item.caseId, variant };
    return {
      sampleId,
      decisionType: item.decisionType,
      context: item.context,
      brief: item[variant],
    };
  }));
  samples.sort((left, right) => left.sampleId.localeCompare(right.sampleId));
  const packet: DecisionPacket = { version: 1, packetId: randomUUID(), samples };
  return {
    packet,
    key: { packetId: packet.packetId, packetFingerprint: decisionPacketFingerprint(packet), mapping },
  };
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function bootstrapInterval(values: number[], seed = 42) {
  if (values.length < 2) return null;
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    const sample = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]);
    means.push(mean(sample)!);
  }
  means.sort((left, right) => left - right);
  return [means[Math.floor(means.length * 0.025)], means[Math.floor(means.length * 0.975)]];
}

/** Pooled quadratic-weighted kappa (two raters per pair) for ordinal 0-3 scores. */
export function quadraticWeightedKappa(pairs: Array<[number, number]>) {
  if (!pairs.length) return null;
  const size = 4;
  const observed = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (const [left, right] of pairs) observed[left][right] += 1;
  const total = pairs.length;
  const leftMargin = observed.map((row) => row.reduce((sum, value) => sum + value, 0));
  const rightMargin = observed[0].map((_, column) => observed.reduce((sum, row) => sum + row[column], 0));
  const weight = (a: number, b: number) => 1 - ((a - b) ** 2) / ((size - 1) ** 2);
  let observedAgreement = 0;
  let expectedAgreement = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      observedAgreement += weight(row, column) * observed[row][column] / total;
      expectedAgreement += weight(row, column) * (leftMargin[row] / total) * (rightMargin[column] / total);
    }
  }
  return expectedAgreement === 1 ? null : (observedAgreement - expectedAgreement) / (1 - expectedAgreement);
}

export function summarizeDecisionReviews(rawPacket: unknown, rawKey: unknown, rawRatings: unknown) {
  const packet = decisionPacketSchema.parse(rawPacket);
  const key = z.object({
    packetId: z.string().uuid(),
    packetFingerprint: z.string().length(64),
    mapping: z.record(z.string(), z.object({ caseId: z.string(), variant: z.enum(["baseline", "treatment"]) }).strict()),
  }).parse(rawKey);
  const fingerprint = decisionPacketFingerprint(packet);
  if (key.packetId !== packet.packetId || key.packetFingerprint !== fingerprint) throw new Error("decision_key_mismatch");
  const ratings = z.array(decisionRatingSchema).parse(rawRatings);
  const samples = new Map(packet.samples.map((sample) => [sample.sampleId, sample]));
  if (samples.size !== packet.samples.length) throw new Error("duplicate_review_sample");
  const mappedIds = Object.keys(key.mapping);
  if (mappedIds.length !== samples.size || mappedIds.some((id) => !samples.has(id))) throw new Error("decision_mapping_incomplete");
  const caseVariants = new Map<string, string[]>();
  for (const { caseId, variant } of Object.values(key.mapping)) {
    if (!caseId.trim()) throw new Error("decision_mapping_case_invalid");
    caseVariants.set(caseId, [...(caseVariants.get(caseId) ?? []), variant]);
  }
  for (const variants of caseVariants.values()) {
    if (variants.length !== 2 || new Set(variants).size !== 2) throw new Error("decision_mapping_pair_invalid");
  }
  const seen = new Set<string>();
  for (const rating of ratings) {
    if (rating.packetId !== packet.packetId || rating.packetFingerprint !== fingerprint || !samples.has(rating.sampleId)) {
      throw new Error("review_material_mismatch");
    }
    const id = JSON.stringify([rating.sampleId, rating.reviewerId]);
    if (seen.has(id)) throw new Error("duplicate_reviewer_rating");
    seen.add(id);
  }
  const bySample = new Map<string, DecisionRating[]>();
  for (const rating of ratings) bySample.set(rating.sampleId, [...(bySample.get(rating.sampleId) ?? []), rating]);

  const incomplete = packet.samples.filter((sample) => (bySample.get(sample.sampleId)?.length ?? 0) < 2).map((sample) => sample.sampleId);
  const disagreements: Array<{ sampleId: string; dimension: DecisionDimension }> = [];
  for (const sample of packet.samples) {
    const reviews = bySample.get(sample.sampleId) ?? [];
    for (const dimension of decisionDimensions) {
      const scores = reviews.map((review) => review.dimensions[dimension].score);
      if (scores.length > 1 && Math.max(...scores) - Math.min(...scores) >= 2) {
        disagreements.push({ sampleId: sample.sampleId, dimension });
      }
    }
  }
  const criticalFindings = ratings.flatMap((rating) => rating.criticalFindings.map((finding) => ({
    sampleId: rating.sampleId, reviewerId: rating.reviewerId, ...finding,
  })));

  const sampleAverages = packet.samples.map((sample) => {
    const reviews = bySample.get(sample.sampleId) ?? [];
    const scores = reviews.flatMap((review) => decisionDimensions.map((dimension) => review.dimensions[dimension].score));
    return { sampleId: sample.sampleId, average: mean(scores), reviewers: reviews.length };
  });
  const sampleById = new Map(sampleAverages.map((sample) => [sample.sampleId, sample]));
  const cases = [...new Set(Object.values(key.mapping).map((item) => item.caseId))];
  const paired = cases.map((caseId) => {
    const sampleIds = Object.entries(key.mapping).filter(([, value]) => value.caseId === caseId);
    const valueFor = (variant: "baseline" | "treatment") => {
      const sampleId = sampleIds.find(([, value]) => value.variant === variant)?.[0];
      return sampleId ? sampleById.get(sampleId)?.average ?? null : null;
    };
    const baseline = valueFor("baseline");
    const treatment = valueFor("treatment");
    return { caseId, baseline, treatment, difference: baseline !== null && treatment !== null ? treatment - baseline : null };
  });
  const differences = paired.map((item) => item.difference).filter((value): value is number => value !== null);
  const means = Object.fromEntries(decisionDimensions.map((dimension) => {
    const scoreFor = (variant: "baseline" | "treatment") => {
      const sampleIds = Object.entries(key.mapping).filter(([, value]) => value.variant === variant).map(([id]) => id);
      return mean(sampleIds.flatMap((id) => (bySample.get(id) ?? []).map((review) => review.dimensions[dimension].score)));
    };
    return [dimension, { baseline: scoreFor("baseline"), treatment: scoreFor("treatment") }];
  })) as Record<DecisionDimension, { baseline: number | null; treatment: number | null }>;
  const agreement = Object.fromEntries(decisionDimensions.map((dimension) => {
    const pairs: Array<[number, number]> = [];
    for (const sample of packet.samples) {
      const reviews = bySample.get(sample.sampleId) ?? [];
      for (let left = 0; left < reviews.length; left += 1) {
        for (let right = left + 1; right < reviews.length; right += 1) {
          pairs.push([reviews[left].dimensions[dimension].score, reviews[right].dimensions[dimension].score]);
        }
      }
    }
    return [dimension, quadraticWeightedKappa(pairs)];
  }));
  const differenceMean = mean(differences);
  const status = criticalFindings.length || disagreements.length ? "needs_adjudication"
    : incomplete.length ? "pending" : "reviewed";
  const direction = incomplete.length || differenceMean === null ? "undetermined"
    : differenceMean > 0 ? "higher" : differenceMean < 0 ? "lower" : "equal";
  return {
    packetId: packet.packetId,
    packetFingerprint: fingerprint,
    status,
    incompleteSamples: incomplete,
    disagreements,
    criticalFindings,
    cases: paired,
    summary: {
      baselineAverage: mean(paired.map((item) => item.baseline).filter((value): value is number => value !== null)),
      treatmentAverage: mean(paired.map((item) => item.treatment).filter((value): value is number => value !== null)),
      meanDifference: differenceMean,
      direction,
      differenceInterval: bootstrapInterval(differences),
      means,
      agreement,
    },
    boundary: "Internal expert-proxy review only. Reviewed means rating coverage is complete, not validated improvement. Direction and bootstrap intervals are descriptive, especially for small case sets. The coordinator mapping is trusted input; the packet fingerprint does not authenticate variant labels. This does not establish external expert consensus, classroom implementation or student learning.",
  };
}
