import type {
  FrameworkContinuityCandidateRecord,
  LessonBlueprintRecord,
  LessonClassFeedbackRecord,
} from "../domain.js";

export type ContinuityDecision = FrameworkContinuityCandidateRecord["decision"];

export type ContinuityWritebackHint = {
  feedbackId: string;
  statement: string;
  continuityFingerprint: string | null;
  continuityDirection: LessonClassFeedbackRecord["continuityDirection"];
  continuityOutcome: LessonClassFeedbackRecord["continuityOutcome"];
  sourceBlueprint: {
    id: string;
    title: string;
    plannedPeriod: number;
    version: number;
  } | null;
  nextBlueprint: {
    id: string;
    title: string;
    plannedPeriod: number;
    version: number;
    mainActivity: string;
    observableProduct: string;
    assessmentEvidence: string;
  } | null;
};

/** Same-unit successor used when class feedback should reshape the next period. */
export function findNextUnitBlueprint<T extends {
  id: string;
  semesterUnitId: string;
  plannedPeriod: number;
}>(
  blueprints: T[],
  sourceBlueprintId: string | null | undefined,
): T | null {
  if (!sourceBlueprintId) return null;
  const source = blueprints.find((item) => item.id === sourceBlueprintId);
  if (!source) return null;
  return blueprints.find((item) => (
    item.semesterUnitId === source.semesterUnitId
    && item.plannedPeriod === source.plannedPeriod + 1
  )) ?? null;
}

export function needsContinuityWriteback(
  record: Pick<LessonClassFeedbackRecord, "kind" | "continuityOutcome" | "writebackStatus">,
) {
  if (record.writebackStatus === "applied" || record.writebackStatus === "not_applicable") {
    return false;
  }
  return record.kind === "continuity_outcome"
    && (record.continuityOutcome === "weak" || record.continuityOutcome === "skipped");
}

export function defaultClassFeedbackWritebackStatus(
  input: Pick<LessonClassFeedbackRecord, "kind" | "continuityOutcome">,
): LessonClassFeedbackRecord["writebackStatus"] {
  if (input.kind !== "continuity_outcome") return null;
  if (input.continuityOutcome === "weak" || input.continuityOutcome === "skipped") return "pending";
  if (input.continuityOutcome === "worked") return "not_applicable";
  return null;
}

/** Deterministic next-blueprint targets for weak/skipped continuity outcomes. */
export function buildContinuityWritebackHints(
  records: LessonClassFeedbackRecord[],
  blueprints: LessonBlueprintRecord[],
): ContinuityWritebackHint[] {
  return records
    .filter(needsContinuityWriteback)
    .map((record) => {
      const source = blueprints.find((item) => item.id === record.lessonBlueprintId) ?? null;
      const next = findNextUnitBlueprint(blueprints, record.lessonBlueprintId);
      return {
        feedbackId: record.id,
        statement: record.statement,
        continuityFingerprint: record.continuityFingerprint,
        continuityDirection: record.continuityDirection,
        continuityOutcome: record.continuityOutcome,
        sourceBlueprint: source
          ? {
              id: source.id,
              title: source.title,
              plannedPeriod: source.plannedPeriod,
              version: source.version,
            }
          : null,
        nextBlueprint: next
          ? {
              id: next.id,
              title: next.title,
              plannedPeriod: next.plannedPeriod,
              version: next.version,
              mainActivity: next.mainActivity,
              observableProduct: next.observableProduct,
              assessmentEvidence: next.assessmentEvidence,
            }
          : null,
      };
    });
}

export function suggestContinuityWritebackActivity(hint: ContinuityWritebackHint) {
  const outcome = hint.continuityOutcome === "skipped" ? "未落实" : "偏弱";
  const direction = hint.continuityDirection === "prepare" ? "铺垫" : "复习";
  const base = hint.statement.replace(/\s+/g, " ").trim();
  return `承接上一课${direction}（课堂效果${outcome}）：先用短任务核验“${base}”，再进入本课主活动。`;
}

/** Seed message that forces framework Agent into one approval-gated writeback turn. */
export function buildContinuityWritebackSeed(hint: ContinuityWritebackHint) {
  const outcomeLabel = hint.continuityOutcome === "skipped" ? "未落实" : "偏弱";
  const directionLabel = hint.continuityDirection === "prepare" ? "后续铺垫" : "复习旧知";
  const lines = [
    "【衔接回写】",
    `feedbackId:${hint.feedbackId}`,
    "请读取课堂反馈中的待回写建议，只调整同单元下一课时蓝图，并直接提交一次框架修改确认。",
    `课堂反馈：${hint.statement}`,
    `衔接方向：${directionLabel}；课堂效果：${outcomeLabel}。`,
  ];
  if (hint.sourceBlueprint) {
    lines.push(
      `来源课时：单元第 ${hint.sourceBlueprint.plannedPeriod} 课「${hint.sourceBlueprint.title}」。`,
    );
  }
  if (hint.nextBlueprint) {
    lines.push(
      `建议修改：单元第 ${hint.nextBlueprint.plannedPeriod} 课「${hint.nextBlueprint.title}」。`,
      `当前主要教学活动：${hint.nextBlueprint.mainActivity || "（空）"}`,
      `当前达成证据：${hint.nextBlueprint.assessmentEvidence || "（空）"}`,
      `可把薄弱衔接落实为：${suggestContinuityWritebackActivity(hint)}`,
      "优先改主要教学活动或达成证据；不要静默改写，也不要拆成多次审批。",
    );
  } else {
    lines.push("同单元尚无下一课时蓝图：请说明缺口，询问是否新建，不要编造已有蓝图。");
  }
  return lines.join("\n");
}

export function parseContinuityWritebackFeedbackId(message: string) {
  const match = message.match(/【衔接回写】[\s\S]*?feedbackId:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match?.[1] ?? null;
}

/** Only bind writeback IDs that still need apply on the current framework. */
export function resolveScopedWritebackFeedbackId(
  feedbackId: string | null | undefined,
  records: Array<Pick<LessonClassFeedbackRecord, "id" | "semesterFrameworkId" | "writebackStatus">>,
  frameworkId: string,
) {
  if (!feedbackId) return undefined;
  const matched = records.find((record) => (
    record.id === feedbackId
    && record.semesterFrameworkId === frameworkId
    && record.writebackStatus === "pending"
  ));
  return matched?.id;
}

/** Prefer teacher-accepted links; never seed dismissed ones into A4 drafts. */
export function selectContinuityForDraft(
  candidates: Array<Pick<
    FrameworkContinuityCandidateRecord,
    "direction" | "decision" | "evidenceKind" | "relatedPointName" | "currentPointName"
  >>,
  limitPerDirection = 2,
) {
  const usable = candidates.filter((candidate) => candidate.decision !== "dismissed");
  const pick = (direction: "review" | "prepare") => {
    const inDirection = usable.filter((candidate) => candidate.direction === direction);
    const accepted = inDirection.filter((candidate) => candidate.decision === "accepted");
    const pool = accepted.length
      ? accepted
      : inDirection.sort((left, right) => (
        (left.evidenceKind === "lexical_similarity" ? 1 : 0)
          - (right.evidenceKind === "lexical_similarity" ? 1 : 0)
      ));
    return pool.slice(0, limitPerDirection);
  };
  return [...pick("review"), ...pick("prepare")];
}

export function applyContinuityDecisions<T extends {
  fingerprint: string;
  decision: ContinuityDecision;
}>(
  candidates: T[],
  decisions: Map<string, ContinuityDecision>,
): T[] {
  return candidates.map((candidate) => {
    const decision = decisions.get(candidate.fingerprint);
    return decision ? { ...candidate, decision } : candidate;
  });
}

export function continuityFingerprintFromCandidateId(candidateId: string) {
  return candidateId.startsWith("lexical-")
    ? candidateId.slice("lexical-".length)
    : null;
}
