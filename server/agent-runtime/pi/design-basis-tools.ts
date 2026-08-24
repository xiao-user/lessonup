import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { LessonAgentContext } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: null,
});

export function createPiDesignBasisReadTools(
  repository: LessonRepository,
  context: LessonAgentContext,
): AgentTool<any>[] {
  return [{
    name: "read_lesson_design_basis",
    label: "读取教案设计依据",
    description: "读取当前教案绑定的结构化设计依据、来源和版本。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const aggregate = await repository.getLessonDesignBasis(context.userId, context.lessonFileId);
      if (!aggregate || aggregate.basis.notebookId !== context.notebookId) {
        throw new Error("lesson_design_basis_not_found");
      }
      return textResult(aggregate);
    },
  }];
}
