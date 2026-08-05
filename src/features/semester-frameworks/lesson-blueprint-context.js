const positiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const orderedChapterBlueprints = (blueprint, unitBlueprints = []) => {
  const matching = unitBlueprints
    .filter((candidate) => candidate.curriculumNodeId === blueprint?.curriculumNodeId)
    .sort((left, right) => (
      (left.plannedPeriod ?? Number.MAX_SAFE_INTEGER)
      - (right.plannedPeriod ?? Number.MAX_SAFE_INTEGER)
      || (left.sortNo ?? Number.MAX_SAFE_INTEGER) - (right.sortNo ?? Number.MAX_SAFE_INTEGER)
    ));
  if (!matching.some((candidate) => candidate.id === blueprint?.id)) matching.push(blueprint);
  return matching.filter(Boolean);
};

export function lessonPeriodContext(blueprint, unitBlueprints = [], knowledgeRecord = null) {
  const chapterBlueprints = orderedChapterBlueprints(blueprint, unitBlueprints);
  const blueprintIndex = Math.max(0, chapterBlueprints.findIndex((candidate) => (
    candidate.id === blueprint?.id
  )));
  const periodNo = positiveInteger(blueprint?.chapterPeriodNo) ?? blueprintIndex + 1;
  const recommendations = [...(knowledgeRecord?.periodRecommendations ?? [])]
    .filter((item) => positiveInteger(item.periodNo))
    .sort((left, right) => Number(left.periodNo) - Number(right.periodNo));
  const recommendedCount = Math.max(0, ...recommendations.map((item) => Number(item.periodNo)));
  const existingPeriodNumbers = new Set(chapterBlueprints.map((candidate, index) => (
    positiveInteger(candidate.chapterPeriodNo) ?? index + 1
  )));
  const existingPeriodCount = Math.max(0, ...existingPeriodNumbers);
  const periodCount = Math.max(1, periodNo, existingPeriodCount, recommendedCount);
  const recommendation = recommendations.find((item) => Number(item.periodNo) === periodNo) ?? null;
  const points = knowledgeRecord?.points ?? [];
  const hasPeriodAssignments = points.some((item) => positiveInteger(item.recommendedPeriod));
  const currentPoints = hasPeriodAssignments
    ? points.filter((item) => (
        positiveInteger(item.recommendedPeriod) === periodNo
        || positiveInteger(item.recommendedPeriod) == null
      ))
    : points;

  return {
    periodNo,
    periodCount,
    recommendation,
    previousRecommendation: recommendations.find((item) => Number(item.periodNo) === periodNo - 1) ?? null,
    nextRecommendation: recommendations.find((item) => Number(item.periodNo) === periodNo + 1) ?? null,
    points: currentPoints,
    missingPeriods: recommendations.filter((item) => (
      !existingPeriodNumbers.has(Number(item.periodNo))
    )).length,
  };
}

export function nextLessonPeriodContext(curriculumNodeId, unitBlueprints = [], knowledgeRecord = null) {
  const chapterBlueprints = unitBlueprints.filter((candidate) => (
    candidate.curriculumNodeId === curriculumNodeId
  ));
  return lessonPeriodContext(
    {
      id: "new",
      curriculumNodeId,
      chapterPeriodNo: Math.max(
        0,
        ...chapterBlueprints.map((candidate, index) => (
          positiveInteger(candidate.chapterPeriodNo) ?? index + 1
        )),
      ) + 1,
      plannedPeriod: Number.MAX_SAFE_INTEGER,
    },
    chapterBlueprints,
    knowledgeRecord,
  );
}

export function lessonPeriodLabel(periodNo, periodCount) {
  return periodCount > 1 ? `第 ${periodNo} 课时` : "第 1 课时";
}

const recommendationSummary = (recommendation, points = []) => {
  const pointNames = points.map((item) => item.point?.canonicalName).filter(Boolean);
  if (pointNames.length) return pointNames.slice(0, 3).join("、");
  return recommendation?.title || "上一课时的学习结果";
};

export function withinChapterContinuityDraft(periodContext) {
  const lines = [];
  if (periodContext.periodNo > 1) {
    lines.push(`本篇承接：先用简短任务唤醒第 ${periodContext.periodNo - 1} 课时的${recommendationSummary(periodContext.previousRecommendation)}，再进入本课学习。`);
  }
  if (periodContext.periodNo < periodContext.periodCount) {
    lines.push(`本课铺垫：保留本课学生产出，作为第 ${periodContext.periodNo + 1} 课时“${periodContext.nextRecommendation?.title || "后续学习"}”的起点。`);
  }
  return lines.join("\n");
}

export function continuityDraft(candidates = [], periodContext = null) {
  const reviews = candidates.filter((item) => item.direction === "review").slice(0, 2);
  const preparations = candidates.filter((item) => item.direction === "prepare").slice(0, 2);
  return [
    periodContext ? withinChapterContinuityDraft(periodContext) : null,
    reviews.length
      ? `复习旧知：${reviews.map((item) => `${item.relatedPointName}（用于衔接${item.currentPointName}）`).join("；")}`
      : null,
    preparations.length
      ? `后续铺垫：${preparations.map((item) => `${item.currentPointName} → ${item.relatedPointName}`).join("；")}`
      : null,
  ].filter(Boolean).join("\n");
}
