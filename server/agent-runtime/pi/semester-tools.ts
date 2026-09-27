import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { LessonRepository } from "../../repository.js";

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: null,
});

export type PiSemesterToolScope = {
  ownerId: string;
  notebookId: string;
  semesterFrameworkId: string;
};

/** Framework identifiers are server-bound; unit IDs are validated against it. */
export function createPiSemesterReadTools(
  repository: LessonRepository,
  scope: PiSemesterToolScope,
): AgentTool<any>[] {
  const aggregate = async () => {
    const value = await repository.getSemesterFramework(scope.ownerId, scope.semesterFrameworkId);
    if (!value || value.framework.notebookId !== scope.notebookId) {
      throw new Error("pi_semester_scope_invalid");
    }
    return value;
  };

  const readFramework: AgentTool<any> = {
    name: "read_semester_framework",
    label: "读取学期框架",
    description: "读取当前服务端绑定的完整学期框架、单元和课时蓝图。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => textResult(await aggregate()),
  };

  const readUnit: AgentTool<any> = {
    name: "read_semester_unit",
    label: "读取单元计划",
    description: "读取当前框架中的一个单元及其课时蓝图。",
    parameters: Type.Object({ unitId: Type.String({ format: "uuid" }) }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const { unitId } = input as { unitId: string };
      const value = await aggregate();
      const unit = value.units.find((candidate) => candidate.id === unitId);
      if (!unit) throw new Error("semester_unit_scope_invalid");
      return textResult({
        frameworkVersion: value.framework.version,
        unit,
        blueprints: value.blueprints.filter((blueprint) => blueprint.semesterUnitId === unitId),
      });
    },
  };

  const readContinuity: AgentTool<any> = {
    name: "read_semester_framework_continuity",
    label: "核对学期教学连续性",
    description: "读取当前框架已计算的单元与课时连续性结果。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      await aggregate();
      return textResult(await repository.getSemesterFrameworkContinuity(
        scope.ownerId,
        scope.semesterFrameworkId,
      ));
    },
  };

  const readFeedback: AgentTool<any> = {
    name: "read_framework_class_feedback",
    label: "读取课堂反馈",
    description: "读取当前学期框架关联的真实课堂反馈。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      await aggregate();
      return textResult(await repository.listLessonClassFeedback(scope.ownerId, {
        semesterFrameworkId: scope.semesterFrameworkId,
      }));
    },
  };

  const getVersion: AgentTool<any> = {
    name: "get_semester_framework_version",
    label: "核对框架版本",
    description: "读取当前框架版本。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => textResult({ frameworkVersion: (await aggregate()).framework.version }),
  };

  return [readFramework, readUnit, readContinuity, readFeedback, getVersion];
}
