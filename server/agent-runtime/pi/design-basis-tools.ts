import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { LessonAgentContext } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import { readLessonTeachingContext } from "../../lesson-teaching-context.js";

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: null,
});

export function createPiDesignBasisReadTools(
  repository: LessonRepository,
  context: LessonAgentContext,
): AgentTool<any>[] {
  // Coalesce simultaneous reads, but do not retain a snapshot across later tool
  // turns: teacher edits and feedback may change while a run is alive.
  let pending: ReturnType<typeof readLessonTeachingContext> | undefined;
  const read = () => {
    if (!pending) {
      pending = readLessonTeachingContext(repository, {
        ownerId: context.userId, notebookId: context.notebookId, lessonFileId: context.lessonFileId,
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };
  return [{
    name: "read_lesson_design_basis",
    label: "读取教案设计依据",
    description: "一次读取当前教案设计依据、学情、来源单元目标、课时蓝图、相邻课时及当前与前序课堂反馈。包含版本与过期标记；空反馈不代表学生已掌握。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      return textResult(await read());
    },
  }, {
    name: "read_lesson_class_feedback",
    label: "读取课时学习反馈",
    description: "读取当前课时及同单元最近三个前序课时的课堂反馈与教师已审议的学习复测。每课时最多八条反馈、三项复测并标明截断；保留基线、后测、替代解释与限制，不把观察变化当作因果证明。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => textResult((await read()).classroomFeedback),
  }];
}
