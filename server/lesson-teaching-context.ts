import type { LessonClassFeedbackRecord, LessonDesignBasisAggregate } from "./domain.js";
import type { LessonRepository } from "./repository.js";
import { classFeedbackProvenance } from "./class-feedback-provenance.js";

type TeachingContextRepository = Pick<LessonRepository,
  "getLessonDesignBasis" | "getSemesterFramework" | "listLessonClassFeedback" | "listLearningReviews">;
type Scope = { ownerId: string; notebookId: string; lessonFileId: string };

const FEEDBACK_LIMIT = 8;
const PREVIOUS_LESSON_LIMIT = 3;

/** A bounded, canonical view shared by Agent reads. No model or write policy. */
export async function readLessonTeachingContext(repository: TeachingContextRepository, scope: Scope) {
  const aggregate = await repository.getLessonDesignBasis(scope.ownerId, scope.lessonFileId);
  if (!aggregate || aggregate.basis.notebookId !== scope.notebookId
    || aggregate.basis.lessonFileId !== scope.lessonFileId) {
    throw new Error("lesson_design_basis_not_found");
  }
  const [planning, current, currentReviews] = await Promise.all([
    readPlanning(repository, scope, aggregate),
    repository.listLessonClassFeedback(scope.ownerId, {
      lessonFileId: scope.lessonFileId, limit: FEEDBACK_LIMIT + 1,
    }),
    repository.listLearningReviews(scope.ownerId, { lessonFileId: scope.lessonFileId, limit: 4 }),
  ]);
  const reviewWindow = (records: typeof currentReviews) => {
    const scoped = records.filter((item) => item.baseline.notebookId === scope.notebookId && item.followup.notebookId === scope.notebookId);
    return { records: scoped.slice(0, 3), truncated: scoped.length > 3 };
  };
  const previous = await Promise.all(planning.previousLessons.map(async (blueprint) => {
    const [feedback, reviews] = await Promise.all([
      repository.listLessonClassFeedback(scope.ownerId, { lessonBlueprintId: blueprint.id, limit: FEEDBACK_LIMIT + 1 }),
      repository.listLearningReviews(scope.ownerId, { lessonBlueprintId: blueprint.id, limit: 4 }),
    ]);
    return { blueprintId: blueprint.id, title: blueprint.title, learningReviews: reviewWindow(reviews),
      ...feedbackWindow(feedback.filter((item) => item.notebookId === scope.notebookId
        && item.lessonBlueprintId === blueprint.id
        && (!item.semesterFrameworkId || item.semesterFrameworkId === aggregate.basis.frameworkId))),
    };
  }));
  return {
    ...aggregate,
    planning,
    classroomFeedback: {
      currentLesson: feedbackWindow(current.filter((item) => (
        item.notebookId === scope.notebookId && item.lessonFileId === scope.lessonFileId
      ))),
      learningReviews: reviewWindow(currentReviews),
      previousLessons: previous,
      coverage: "当前课时与同单元最近三个前序课时；空结果表示没有记录，不代表学生已掌握。",
    },
  };
}

function feedbackWindow(records: LessonClassFeedbackRecord[]) {
  return {
    records: records.slice(0, FEEDBACK_LIMIT).map((record) => ({
      ...record, provenance: classFeedbackProvenance(record.kind),
    })),
    truncated: records.length > FEEDBACK_LIMIT,
  };
}

async function readPlanning(repository: TeachingContextRepository, scope: Scope, aggregate: LessonDesignBasisAggregate) {
  const { basis } = aggregate;
  const empty = { previousLessons: [], nextLesson: null, unit: null, blueprint: null };
  if (!basis.frameworkId) return { ...empty, status: "unbound" as const };
  const framework = await repository.getSemesterFramework(scope.ownerId, basis.frameworkId);
  if (!framework || framework.framework.notebookId !== scope.notebookId) {
    // A stale binding cannot grant access to a different resource.
    return { ...empty, status: "unavailable" as const };
  }
  const unit = framework.units.find((item) => item.id === basis.semesterUnitId
    && item.frameworkId === basis.frameworkId);
  const blueprint = framework.blueprints.find((item) => item.id === basis.lessonBlueprintId
    && item.frameworkId === basis.frameworkId && item.semesterUnitId === unit?.id);
  if (!unit || !blueprint) return { ...empty, status: "unavailable" as const };
  const siblings = framework.blueprints.filter((item) => item.frameworkId === basis.frameworkId
    && item.semesterUnitId === unit.id && item.status !== "cancelled")
    .sort((left, right) => left.plannedPeriod - right.plannedPeriod || left.sortNo - right.sortNo
      || left.id.localeCompare(right.id));
  return {
    status: "available" as const,
    frameworkVersion: framework.framework.version,
    sourceFrameworkVersion: basis.sourceFrameworkVersion,
    sourceBlueprintVersion: basis.sourceBlueprintVersion,
    stale: basis.status === "stale" || basis.sourceFrameworkVersion !== framework.framework.version
      || basis.sourceBlueprintVersion !== blueprint.version,
    lessonDurationMinutes: framework.framework.lessonDurationMinutes,
    unit,
    blueprint,
    previousLessons: siblings.filter((item) => item.plannedPeriod < blueprint.plannedPeriod)
      .slice(-PREVIOUS_LESSON_LIMIT),
    nextLesson: siblings.find((item) => item.plannedPeriod > blueprint.plannedPeriod) ?? null,
  };
}
