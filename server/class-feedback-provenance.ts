import type { LessonClassFeedbackKind } from "./domain.js";

export type ClassFeedbackProvenance = {
  level: "teacher_observation" | "teacher_judgment" | "teacher_inference" | "teacher_decision";
  label: string;
  boundary: string;
};

/**
 * Classroom feedback is valuable local evidence, but never a replacement for
 * platform curriculum facts. Make that distinction explicit for both the UI
 * and agent tool surfaces rather than relying on the model to infer it.
 */
export function classFeedbackProvenance(kind: LessonClassFeedbackKind): ClassFeedbackProvenance {
  switch (kind) {
    case "observation":
      return {
        level: "teacher_observation",
        label: "教师课堂事实",
        boundary: "来自本班课堂的直接观察，不是平台教材或课程标准事实。",
      };
    case "practice_gap":
      return {
        level: "teacher_judgment",
        label: "教师课堂判断",
        boundary: "用于调整本班练习与支架，不代表其他班级或平台的通用结论。",
      };
    case "error_cause":
      return {
        level: "teacher_inference",
        label: "教师推断（待后续观察校正）",
        boundary: "这是对错因的教学推断；应通过后续学生表现校正，不能当作已核验事实。",
      };
    case "continuity_outcome":
      return {
        level: "teacher_decision",
        label: "教师决定：衔接效果",
        boundary: "这是对本班本次复习或铺垫效果的决定性记录，不是平台已核验的先修关系。",
      };
  }
}
