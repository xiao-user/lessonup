import { describe, expect, it } from "vitest";
import type {
  SemesterFrameworkAggregate,
  SemesterFrameworkPatchProposal,
} from "./domain.js";
import {
  applySemesterFrameworkPatch,
  materializeSemesterFrameworkPatch,
  SemesterFrameworkPatchError,
} from "./semester-framework-patch.js";

const frameworkId = "00000000-0000-4000-8000-000000000101";
const unitId = "00000000-0000-4000-8000-000000000102";
const timestamp = "2026-08-01T00:00:00.000Z";

function aggregate(): SemesterFrameworkAggregate {
  return {
    framework: {
      id: frameworkId,
      ownerId: "00000000-0000-4000-8000-000000000001",
      notebookId: "00000000-0000-4000-8000-000000000002",
      textbookId: "00000000-0000-4000-8000-000000000003",
      catalogReleaseId: "00000000-0000-4000-8000-000000000004",
      semanticReleaseId: null,
      title: "七年级上学期教学框架",
      term: "上学期",
      startDate: "2026-09-01",
      totalWeeks: 18,
      weeklyPeriods: 5,
      lessonDurationMinutes: 40,
      capacityRatio: 0.9,
      planningHorizonWeeks: 2,
      contextProfile: { classSummary: "基础差异较大" },
      version: 2,
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    units: [{
      id: unitId,
      frameworkId,
      curriculumNodeId: "00000000-0000-4000-8000-000000000005",
      sortNo: 1,
      plannedStartWeek: null,
      plannedEndWeek: null,
      plannedPeriods: 0,
      learningGoals: "",
      teacherNotes: "",
      status: "unplanned",
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    blueprints: [],
    outcomeSelections: [],
  };
}

function materialize(
  proposal: SemesterFrameworkPatchProposal,
  current = aggregate(),
) {
  return materializeSemesterFrameworkPatch({ proposal, aggregate: current });
}

describe("semester framework ResourcePatch", () => {
  it("updates framework and unit fields as one versioned aggregate", () => {
    const current = aggregate();
    const patch = materialize({
      summary: "安排第一单元并明确目标",
      operations: [{
        op: "replace_framework_field",
        field: "planningHorizonWeeks",
        expectedValue: 2,
        replacement: 3,
      }, {
        op: "replace_unit_field",
        unitId,
        field: "learningGoals",
        expectedValue: "",
        replacement: "能解释关键概念并完成基础迁移任务",
      }],
    }, current);

    const updated = applySemesterFrameworkPatch(
      current,
      patch,
      "2026-08-01T01:00:00.000Z",
    );

    expect(updated.framework).toMatchObject({
      planningHorizonWeeks: 3,
      version: 3,
      updatedAt: "2026-08-01T01:00:00.000Z",
    });
    expect(updated.units[0]).toMatchObject({
      learningGoals: "能解释关键概念并完成基础迁移任务",
      version: 1,
      updatedAt: "2026-08-01T01:00:00.000Z",
    });
  });

  it("rebases over unrelated teacher edits but rejects a changed target", () => {
    const original = aggregate();
    const patch = materialize({
      summary: "调整第一单元课时",
      operations: [{
        op: "replace_unit_field",
        unitId,
        field: "plannedPeriods",
        expectedValue: 0,
        replacement: 6,
      }],
    }, original);
    const unrelatedEdit = aggregate();
    unrelatedEdit.framework.version = 3;
    unrelatedEdit.units[0]!.teacherNotes = "教师刚补充的备注";
    unrelatedEdit.units[0]!.version = 1;

    const rebased = applySemesterFrameworkPatch(unrelatedEdit, patch);
    expect(rebased.units[0]).toMatchObject({
      plannedPeriods: 6,
      teacherNotes: "教师刚补充的备注",
      version: 2,
    });

    const conflictingEdit = aggregate();
    conflictingEdit.units[0]!.plannedPeriods = 4;
    expect(() => applySemesterFrameworkPatch(conflictingEdit, patch)).toThrowError(
      expect.objectContaining<Partial<SemesterFrameworkPatchError>>({ code: "stale_resource" }),
    );
  });

  it("rejects duplicate targets and invalid aggregate ranges before approval", () => {
    expect(() => materialize({
      summary: "重复修改",
      operations: [{
        op: "replace_framework_field",
        field: "weeklyPeriods",
        expectedValue: 5,
        replacement: 4,
      }, {
        op: "replace_framework_field",
        field: "weeklyPeriods",
        expectedValue: 5,
        replacement: 3,
      }],
    })).toThrowError(expect.objectContaining<Partial<SemesterFrameworkPatchError>>({
      code: "duplicate_framework_patch_target",
    }));

    expect(() => materialize({
      summary: "设置无效周次",
      operations: [{
        op: "replace_unit_field",
        unitId,
        field: "plannedStartWeek",
        expectedValue: null,
        replacement: 10,
      }, {
        op: "replace_unit_field",
        unitId,
        field: "plannedEndWeek",
        expectedValue: null,
        replacement: 8,
      }],
    })).toThrowError(expect.objectContaining<Partial<SemesterFrameworkPatchError>>({
      code: "semester_unit_week_range_invalid",
    }));

    expect(() => materialize({
      summary: "把蓝图临时写进备注",
      operations: [{
        op: "replace_unit_field",
        unitId,
        field: "teacherNotes",
        expectedValue: "",
        replacement: "【待新增蓝图】第2课时……第3课时……",
      }],
    })).toThrowError(expect.objectContaining<Partial<SemesterFrameworkPatchError>>({
      code: "blueprint_requires_structured_operations",
    }));
  });

  it("creates a batch of formal lesson blueprints in one approval", () => {
    const current = aggregate();
    const patch = materialize({
      summary: "补全第一单元两节课",
      operations: [{
        op: "create_lesson_blueprint",
        semesterUnitId: unitId,
        curriculumNodeId: "chapter-1",
        chapterPeriodNo: 1,
        title: "观察景物与提取证据",
        mainActivity: "学生圈画景物描写并按观察角度分类",
        observableProduct: "一张景物描写证据表",
        assessmentEvidence: "能用原文说明观察角度与情感的联系",
        anticipatedDifficulties: [],
        plannedMinutes: 40,
        teacherNotes: "",
      }, {
        op: "create_lesson_blueprint",
        semesterUnitId: unitId,
        curriculumNodeId: "chapter-2",
        chapterPeriodNo: 1,
        title: "比较修辞表达效果",
        mainActivity: "学生比较两组语句并说明修辞选择",
        observableProduct: "一段有证据的表达效果说明",
        assessmentEvidence: "能指出修辞、语境和表达效果",
        anticipatedDifficulties: [],
        plannedMinutes: 40,
        teacherNotes: "",
      }],
    }, current);

    expect(patch.operations).toEqual([
      expect.objectContaining({ op: "create_lesson_blueprint", plannedPeriod: 1, sortNo: 1 }),
      expect.objectContaining({ op: "create_lesson_blueprint", plannedPeriod: 2, sortNo: 2 }),
    ]);
    expect(new Set(patch.operations.map((operation) => (
      operation.op === "create_lesson_blueprint" ? operation.blueprintId : null
    ))).size).toBe(2);

    const updated = applySemesterFrameworkPatch(current, patch);
    expect(updated.blueprints.map((blueprint) => blueprint.title)).toEqual([
      "观察景物与提取证据",
      "比较修辞表达效果",
    ]);
    expect(updated.units[0]).toMatchObject({ plannedPeriods: 2, status: "planned", version: 1 });
    expect(updated.framework.version).toBe(3);
  });

  it("expands a compact multi-unit planning command into one snapshot-bound patch", () => {
    const current = aggregate();
    const secondUnitId = "00000000-0000-4000-8000-000000000103";
    current.units.push({
      ...current.units[0]!,
      id: secondUnitId,
      curriculumNodeId: "00000000-0000-4000-8000-000000000006",
      sortNo: 2,
    });
    const unitPlan = (targetUnitId: string, week: number, title: string) => ({
      op: "plan_semester_unit" as const,
      unitId: targetUnitId,
      plannedStartWeek: week,
      plannedEndWeek: week + 1,
      learningGoals: `完成${title}的核心学习任务`,
      blueprints: [{
        curriculumNodeId: `chapter-${week}`,
        chapterPeriodNo: 1,
        title,
        mainActivity: `围绕${title}组织证据整理活动`,
        observableProduct: `${title}学习成果单`,
        assessmentEvidence: `能够用成果单说明${title}的学习结果`,
        anticipatedDifficulties: [],
        plannedMinutes: 40,
        teacherNotes: "",
      }],
    });

    const patch = materialize({
      summary: "一次完成两个单元的课时规划",
      operations: [
        unitPlan(unitId, 1, "第一单元整合课"),
        unitPlan(secondUnitId, 3, "第二单元整合课"),
      ],
    }, current);

    expect(patch.operations).toHaveLength(8);
    expect(patch.operations.filter((operation) => (
      operation.op === "create_lesson_blueprint"
    ))).toHaveLength(2);
    expect(patch.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        op: "replace_unit_field",
        unitId,
        field: "plannedStartWeek",
        expectedValue: null,
        replacement: 1,
      }),
      expect.objectContaining({
        op: "create_lesson_blueprint",
        semesterUnitId: secondUnitId,
        plannedPeriod: 1,
      }),
    ]));

    const updated = applySemesterFrameworkPatch(current, patch);
    expect(updated.blueprints.map((blueprint) => blueprint.title)).toEqual([
      "第一单元整合课",
      "第二单元整合课",
    ]);
    expect(updated.units).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: unitId, plannedStartWeek: 1, plannedPeriods: 1 }),
      expect.objectContaining({ id: secondUnitId, plannedStartWeek: 3, plannedPeriods: 1 }),
    ]));
  });

  it("reconciles the same chapter period and only creates genuinely missing periods", () => {
    const current = aggregate();
    const initial = applySemesterFrameworkPatch(current, materialize({
      summary: "先建立《春》第一课时",
      operations: [{
        op: "create_lesson_blueprint",
        semesterUnitId: unitId,
        curriculumNodeId: "spring",
        chapterPeriodNo: 1,
        title: "《春》",
        mainActivity: "通读课文",
        observableProduct: "圈画结果",
        assessmentEvidence: "能够说出主要景物",
        anticipatedDifficulties: [],
        plannedMinutes: 40,
        teacherNotes: "",
      }],
    }));

    const patch = materialize({
      summary: "按两课时建议重新规划《春》",
      operations: [{
        op: "plan_semester_unit",
        unitId,
        plannedStartWeek: null,
        plannedEndWeek: null,
        learningGoals: "能分析写景语言并通过朗读表达情感",
        blueprints: [1, 2].map((chapterPeriodNo) => ({
          curriculumNodeId: "spring",
          chapterPeriodNo,
          title: `《春》第${chapterPeriodNo}课时`,
          mainActivity: chapterPeriodNo === 1 ? "辨认春日图景" : "比较比喻并设计朗读标记",
          observableProduct: chapterPeriodNo === 1 ? "春景证据表" : "朗读标记稿",
          assessmentEvidence: chapterPeriodNo === 1 ? "能用原文概括图景" : "能说明朗读处理依据",
          anticipatedDifficulties: [],
          plannedMinutes: chapterPeriodNo === 1 ? 45 : 40,
          teacherNotes: "",
        })),
      }],
    }, initial);

    expect(patch.operations.filter((operation) => operation.op === "create_lesson_blueprint")).toHaveLength(1);
    expect(patch.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        op: "replace_lesson_blueprint_field",
        blueprintId: initial.blueprints[0]!.id,
        field: "plannedMinutes",
        replacement: 45,
      }),
      expect.objectContaining({
        op: "create_lesson_blueprint",
        chapterPeriodNo: 2,
      }),
    ]));

    const updated = applySemesterFrameworkPatch(initial, patch);
    expect(updated.blueprints).toHaveLength(2);
    expect(updated.blueprints.map((blueprint) => [blueprint.chapterPeriodNo, blueprint.title])).toEqual([
      [1, "《春》第1课时"],
      [2, "《春》第2课时"],
    ]);
    expect(updated.blueprints[0]!.plannedMinutes).toBe(45);
  });

  it("keeps a complete semester plan atomic when expansion exceeds 64 low-level operations", () => {
    const current = aggregate();
    current.units = Array.from({ length: 6 }, (_, index) => ({
      ...current.units[0]!,
      id: `00000000-0000-4000-8000-${String(102 + index).padStart(12, "0")}`,
      curriculumNodeId: `unit-${index + 1}`,
      sortNo: index + 1,
    }));
    const proposal: SemesterFrameworkPatchProposal = {
      summary: "一次确认整学期六个单元和四十七条课时蓝图",
      operations: current.units.map((unit, unitIndex) => ({
        op: "plan_semester_unit",
        unitId: unit.id,
        plannedStartWeek: unitIndex * 2 + 1,
        plannedEndWeek: unitIndex * 2 + 2,
        learningGoals: `第${unitIndex + 1}单元可测目标`,
        blueprints: Array.from(
          { length: unitIndex === 5 ? 7 : 8 },
          (_, blueprintIndex) => ({
            curriculumNodeId: `unit-${unitIndex + 1}-lesson-${blueprintIndex + 1}`,
            chapterPeriodNo: 1,
            title: `第${unitIndex + 1}单元第${blueprintIndex + 1}课时`,
            mainActivity: "教师组织任务，学生完成证据整理",
            observableProduct: "一份可观察的学习成果",
            assessmentEvidence: "根据成果判断目标是否达成",
            anticipatedDifficulties: [],
            plannedMinutes: 40,
            teacherNotes: "",
          }),
        ),
      })),
    };

    const patch = materialize(proposal, current);
    expect(patch.operations).toHaveLength(65);

    const updated = applySemesterFrameworkPatch(current, patch);
    expect(updated.framework.version).toBe(3);
    expect(updated.blueprints).toHaveLength(47);
    expect(updated.units.every((unit) => unit.status === "planned")).toBe(true);
  });

  it("field-rebases blueprint edits but makes deletion depend on the complete entity version", () => {
    const withBlueprints = applySemesterFrameworkPatch(aggregate(), materialize({
      summary: "新增两节课",
      operations: ["第一课", "第二课"].map((title, index) => ({
        op: "create_lesson_blueprint" as const,
        semesterUnitId: unitId,
        curriculumNodeId: `chapter-${index + 1}`,
        chapterPeriodNo: 1,
        title,
        mainActivity: `活动 ${index + 1}`,
        observableProduct: `产出 ${index + 1}`,
        assessmentEvidence: `证据 ${index + 1}`,
        anticipatedDifficulties: [],
        plannedMinutes: 40,
        teacherNotes: "",
      })),
    }));
    const first = withBlueprints.blueprints[0]!;
    const second = withBlueprints.blueprints[1]!;
    const editAndDelete = materialize({
      summary: "调整第一课并删除第二课",
      operations: [{
        op: "replace_lesson_blueprint_field",
        blueprintId: first.id,
        field: "title",
        expectedValue: first.title,
        replacement: "第一课：观察与证据",
      }, {
        op: "delete_lesson_blueprint",
        blueprintId: second.id,
        expectedVersion: second.version,
      }],
    }, withBlueprints);
    const unrelatedTeacherEdit = structuredClone(withBlueprints);
    unrelatedTeacherEdit.blueprints[0]!.mainActivity = "教师刚调整的真实活动";
    unrelatedTeacherEdit.blueprints[0]!.version += 1;

    const updated = applySemesterFrameworkPatch(unrelatedTeacherEdit, editAndDelete);
    expect(updated.blueprints).toHaveLength(1);
    expect(updated.blueprints[0]).toMatchObject({
      title: "第一课：观察与证据",
      mainActivity: "教师刚调整的真实活动",
    });
    expect(editAndDelete.operations[1]).toMatchObject({
      expectedTitle: "第二课",
      expectedSemesterUnitId: unitId,
    });

    const changedDeletionTarget = structuredClone(withBlueprints);
    changedDeletionTarget.blueprints[1]!.version += 1;
    expect(() => applySemesterFrameworkPatch(changedDeletionTarget, editAndDelete)).toThrowError(
      expect.objectContaining<Partial<SemesterFrameworkPatchError>>({ code: "stale_resource" }),
    );
  });
});
