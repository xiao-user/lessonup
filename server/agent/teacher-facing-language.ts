/**
 * Shared teacher-facing vocabulary for Agent tool results and instructions.
 *
 * Internals (camelCase / UUIDs) stay in `toolRef` for subsequent tool calls.
 * Teacher-visible prose and the semantic half of tool results use these labels
 * so the model is less likely to echo schema fields into the transcript.
 */

export const teacherFacingInstruction = [
  "对教师的最终说明只使用界面文案或教学语义：课时名称、第几课时、主要教学活动、学生可观察产出、达成证据、预判难点、单元目标、教材章节等。",
  "工具结果里的 toolRef、英文字段名、蓝图/单元/教材 UUID 只供后续工具调用，禁止写进回复、列表或代码块。",
  "需要指代某一课时蓝图时，用其课时名称与第几课时，例如「《济南的冬天》第2课时：拟人」。",
].join("");

type BlueprintLike = {
  id: string;
  semesterUnitId: string;
  curriculumNodeId: string;
  chapterPeriodNo: number;
  sortNo: number;
  version: number;
  title: string;
  mainActivity: string;
  observableProduct: string;
  assessmentEvidence: string;
  anticipatedDifficulties: unknown[];
  plannedMinutes: number;
  teacherNotes: string;
  status: string;
};

type UnitLike = {
  id: string;
  curriculumNodeId: string;
  plannedStartWeek: number | null;
  plannedEndWeek: number | null;
  plannedPeriods: number;
  learningGoals: string;
  teacherNotes: string;
  status: string;
};

export function presentSemesterBlueprintForAgent(
  blueprint: BlueprintLike,
  extras: {
    curriculumNodeTitle: string;
    knowledgePoints?: unknown;
    periodRecommendations?: unknown;
  },
) {
  return {
    toolRef: {
      blueprintId: blueprint.id,
      semesterUnitId: blueprint.semesterUnitId,
      curriculumNodeId: blueprint.curriculumNodeId,
      chapterPeriodNo: blueprint.chapterPeriodNo,
      sortNo: blueprint.sortNo,
      version: blueprint.version,
    },
    课时名称: blueprint.title,
    章节课时: `第${blueprint.chapterPeriodNo}课时`,
    课时顺序: blueprint.sortNo,
    教材章节: extras.curriculumNodeTitle,
    主要教学活动: blueprint.mainActivity,
    学生可观察产出: blueprint.observableProduct,
    达成证据: blueprint.assessmentEvidence,
    预判难点: blueprint.anticipatedDifficulties.filter(
      (value): value is string => typeof value === "string",
    ),
    课堂分钟: blueprint.plannedMinutes,
    蓝图备注: blueprint.teacherNotes,
    状态: blueprint.status,
    知识点: extras.knowledgePoints ?? [],
    课时建议: extras.periodRecommendations ?? [],
  };
}

export function presentSemesterUnitForAgent(
  unit: UnitLike,
  curriculumNodeTitle: string,
) {
  return {
    toolRef: {
      unitId: unit.id,
      curriculumNodeId: unit.curriculumNodeId,
    },
    教材单元: curriculumNodeTitle,
    起始周: unit.plannedStartWeek,
    结束周: unit.plannedEndWeek,
    计划课时: unit.plannedPeriods,
    单元目标: unit.learningGoals,
    教师备注: unit.teacherNotes,
    状态: unit.status,
  };
}
