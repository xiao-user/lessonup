import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  semesterFrameworkPatchSchema,
  type SemesterFrameworkAggregate,
  type SemesterFrameworkPatch,
  type SemesterFrameworkPatchProposal,
} from "./domain.js";

export class SemesterFrameworkPatchError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const frameworkValueSchemas = {
  title: z.string().trim().min(1).max(120),
  term: z.string().trim().min(1).max(40),
  startDate: z.string().date().nullable(),
  totalWeeks: z.number().int().min(1).max(30),
  weeklyPeriods: z.number().int().min(1).max(30),
  lessonDurationMinutes: z.union([z.literal(40), z.literal(45)]),
  capacityRatio: z.number().min(0.5).max(1),
  planningHorizonWeeks: z.number().int().min(1).max(8),
  contextProfile: z.record(z.string(), z.unknown()),
  status: z.enum(["draft", "active", "completed", "archived"]),
} as const;

const unitValueSchemas = {
  plannedStartWeek: z.number().int().min(1).max(30).nullable(),
  plannedEndWeek: z.number().int().min(1).max(30).nullable(),
  plannedPeriods: z.number().int().min(0).max(100),
  learningGoals: z.string().max(20_000),
  teacherNotes: z.string().max(20_000),
  status: z.enum(["unplanned", "planned", "in_progress", "completed", "deferred"]),
} as const;

const blueprintValueSchemas = {
  curriculumNodeId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  mainActivity: z.string().max(20_000),
  observableProduct: z.string().max(20_000),
  assessmentEvidence: z.string().max(20_000),
  anticipatedDifficulties: z.array(z.unknown()).max(100),
  plannedMinutes: z.number().int().min(20).max(60),
  teacherNotes: z.string().max(20_000),
  status: z.enum(["draft", "ready", "taught", "adjusted", "cancelled"]),
} as const;

function parseReplacement(
  operation: SemesterFrameworkPatch["operations"][number],
) {
  try {
    if (operation.op === "replace_framework_field") {
      return frameworkValueSchemas[operation.field].parse(operation.replacement);
    }
    if (operation.op === "replace_unit_field") {
      return unitValueSchemas[operation.field].parse(operation.replacement);
    }
    if (operation.op === "replace_lesson_blueprint_field") {
      return blueprintValueSchemas[operation.field].parse(operation.replacement);
    }
    throw new SemesterFrameworkPatchError("invalid_framework_patch_operation");
  } catch {
    throw new SemesterFrameworkPatchError("invalid_framework_patch_value");
  }
}

function assertAggregateConstraints(aggregate: SemesterFrameworkAggregate) {
  const framework = aggregate.framework;
  if (framework.planningHorizonWeeks > framework.totalWeeks) {
    throw new SemesterFrameworkPatchError("planning_horizon_exceeds_term");
  }
  for (const unit of aggregate.units) {
    if (
      unit.plannedStartWeek != null
      && unit.plannedEndWeek != null
      && unit.plannedStartWeek > unit.plannedEndWeek
    ) {
      throw new SemesterFrameworkPatchError("semester_unit_week_range_invalid");
    }
    if (
      (unit.plannedStartWeek ?? unit.plannedEndWeek ?? 1) > framework.totalWeeks
      || (unit.plannedEndWeek ?? unit.plannedStartWeek ?? 1) > framework.totalWeeks
    ) {
      throw new SemesterFrameworkPatchError("semester_unit_week_exceeds_term");
    }
  }
  const unitIds = new Set(aggregate.units.map((unit) => unit.id));
  const blueprintIds = new Set<string>();
  const unitPeriods = new Set<string>();
  const sortNumbers = new Set<number>();
  for (const blueprint of aggregate.blueprints) {
    if (!unitIds.has(blueprint.semesterUnitId)) {
      throw new SemesterFrameworkPatchError("semester_unit_not_found");
    }
    if (blueprintIds.has(blueprint.id)) {
      throw new SemesterFrameworkPatchError("duplicate_lesson_blueprint_id");
    }
    blueprintIds.add(blueprint.id);
    const periodKey = `${blueprint.semesterUnitId}:${blueprint.plannedPeriod}`;
    if (unitPeriods.has(periodKey) || sortNumbers.has(blueprint.sortNo)) {
      throw new SemesterFrameworkPatchError("duplicate_lesson_blueprint_position");
    }
    unitPeriods.add(periodKey);
    sortNumbers.add(blueprint.sortNo);
  }
}

function operationKey(operation: SemesterFrameworkPatch["operations"][number]) {
  if (operation.op === "replace_framework_field") return `framework:${operation.field}`;
  if (operation.op === "replace_unit_field") return `unit:${operation.unitId}:${operation.field}`;
  if (operation.op === "create_lesson_blueprint") return `blueprint:create:${operation.blueprintId}`;
  if (operation.op === "delete_lesson_blueprint") return `blueprint:delete:${operation.blueprintId}`;
  return `blueprint:${operation.blueprintId}:${operation.field}`;
}

function applyOperations(
  aggregate: SemesterFrameworkAggregate,
  patch: SemesterFrameworkPatch,
  timestamp: string,
) {
  const next = structuredClone(aggregate);
  const seen = new Set<string>();
  const modifiedUnits = new Set<string>();
  const modifiedBlueprints = new Set<string>();
  const deletedBlueprints = new Set(
    patch.operations
      .filter((operation) => operation.op === "delete_lesson_blueprint")
      .map((operation) => operation.blueprintId),
  );
  if (patch.operations.some((operation) => (
    operation.op === "replace_lesson_blueprint_field"
    && deletedBlueprints.has(operation.blueprintId)
  ))) {
    throw new SemesterFrameworkPatchError("conflicting_blueprint_patch_operations");
  }
  for (const operation of patch.operations) {
    const key = operationKey(operation);
    if (seen.has(key)) throw new SemesterFrameworkPatchError("duplicate_framework_patch_target");
    seen.add(key);

    if (operation.op === "replace_framework_field") {
      const current = next.framework[operation.field];
      if (!isDeepStrictEqual(current, operation.expectedValue)) {
        throw new SemesterFrameworkPatchError("stale_resource");
      }
      const replacement = parseReplacement(operation);
      Object.assign(next.framework, { [operation.field]: replacement });
      continue;
    }

    if (operation.op === "replace_unit_field") {
      const unit = next.units.find((candidate) => candidate.id === operation.unitId);
      if (!unit) throw new SemesterFrameworkPatchError("semester_unit_not_found");
      const current = unit[operation.field];
      if (!isDeepStrictEqual(current, operation.expectedValue)) {
        throw new SemesterFrameworkPatchError("stale_resource");
      }
      const replacement = parseReplacement(operation);
      Object.assign(unit, { [operation.field]: replacement });
      modifiedUnits.add(unit.id);
      continue;
    }

    if (operation.op === "create_lesson_blueprint") {
      const unit = next.units.find((candidate) => candidate.id === operation.semesterUnitId);
      if (!unit) throw new SemesterFrameworkPatchError("semester_unit_not_found");
      if (next.blueprints.some((candidate) => candidate.id === operation.blueprintId)) {
        throw new SemesterFrameworkPatchError("duplicate_lesson_blueprint_id");
      }
      next.blueprints.push({
        id: operation.blueprintId,
        frameworkId: next.framework.id,
        semesterUnitId: operation.semesterUnitId,
        curriculumNodeId: operation.curriculumNodeId,
        chapterPeriodNo: operation.chapterPeriodNo,
        plannedPeriod: operation.plannedPeriod,
        sortNo: operation.sortNo,
        title: operation.title,
        mainActivity: operation.mainActivity,
        observableProduct: operation.observableProduct,
        assessmentEvidence: operation.assessmentEvidence,
        anticipatedDifficulties: structuredClone(operation.anticipatedDifficulties),
        plannedMinutes: operation.plannedMinutes,
        teacherNotes: operation.teacherNotes,
        status: operation.status,
        version: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      unit.plannedPeriods = Math.max(unit.plannedPeriods, operation.plannedPeriod);
      if (unit.status === "unplanned") unit.status = "planned";
      modifiedUnits.add(unit.id);
      continue;
    }

    const blueprint = next.blueprints.find((candidate) => candidate.id === operation.blueprintId);
    if (!blueprint) throw new SemesterFrameworkPatchError("lesson_blueprint_not_found");
    if (operation.op === "delete_lesson_blueprint") {
      if (blueprint.version !== operation.expectedVersion) {
        throw new SemesterFrameworkPatchError("stale_resource");
      }
      // plannedPeriod and sortNo are stable chronology. Deletion leaves a gap
      // instead of silently renumbering other independently versioned lessons.
      next.blueprints = next.blueprints.filter((candidate) => candidate.id !== blueprint.id);
      next.outcomeSelections = next.outcomeSelections.filter((selection) => (
        selection.lessonBlueprintId !== blueprint.id
      ));
      modifiedUnits.add(blueprint.semesterUnitId);
      continue;
    }

    const current = blueprint[operation.field];
    if (!isDeepStrictEqual(current, operation.expectedValue)) {
      throw new SemesterFrameworkPatchError("stale_resource");
    }
    const replacement = parseReplacement(operation);
    Object.assign(blueprint, { [operation.field]: replacement });
    modifiedBlueprints.add(blueprint.id);
  }

  assertAggregateConstraints(next);
  next.framework.version = aggregate.framework.version + 1;
  next.framework.updatedAt = timestamp;
  next.units = next.units.map((unit) => modifiedUnits.has(unit.id)
    ? { ...unit, version: unit.version + 1, updatedAt: timestamp }
    : unit);
  next.blueprints = next.blueprints.map((blueprint) => modifiedBlueprints.has(blueprint.id)
    ? { ...blueprint, version: blueprint.version + 1, updatedAt: timestamp }
    : blueprint);
  return next;
}

export function materializeSemesterFrameworkPatch(args: {
  proposal: SemesterFrameworkPatchProposal;
  aggregate: SemesterFrameworkAggregate;
}) {
  for (const operation of args.proposal.operations) {
    if (
      operation.op !== "replace_unit_field"
      || operation.field !== "teacherNotes"
      || typeof operation.replacement !== "string"
    ) continue;
    const lessonMarkers = operation.replacement.match(/第\s*\d+\s*课时/g) ?? [];
    if (
      lessonMarkers.length >= 2
      || /待新增蓝图|plannedPeriod|mainActivity|observableProduct|assessmentEvidence/.test(
        operation.replacement,
      )
    ) {
      throw new SemesterFrameworkPatchError("blueprint_requires_structured_operations");
    }
  }
  type AtomicProposalOperation = Exclude<
    SemesterFrameworkPatchProposal["operations"][number],
    { op: "plan_semester_unit" }
  >;
  const expandedOperations: AtomicProposalOperation[] = [];
  const proposedBlueprintKeys = new Set<string>();
  const nextImplicitChapterPeriodByKey = new Map<string, number>();
  const reconcileBlueprint = (
    semesterUnitId: string,
    proposal: Extract<AtomicProposalOperation, { op: "create_lesson_blueprint" }>,
    fallbackChapterPeriodNo?: number,
  ) => {
    const existingChapterPeriods = args.aggregate.blueprints
      .filter((blueprint) => (
        blueprint.semesterUnitId === semesterUnitId
        && blueprint.curriculumNodeId === proposal.curriculumNodeId
      ))
      .map((blueprint) => blueprint.chapterPeriodNo);
    const chapterKey = `${semesterUnitId}:${proposal.curriculumNodeId}`;
    let chapterPeriodNo = proposal.chapterPeriodNo ?? fallbackChapterPeriodNo;
    if (chapterPeriodNo == null) {
      chapterPeriodNo = (nextImplicitChapterPeriodByKey.get(chapterKey)
        ?? Math.max(0, ...existingChapterPeriods)) + 1;
      nextImplicitChapterPeriodByKey.set(chapterKey, chapterPeriodNo);
    }
    const normalizedProposal = { ...proposal, chapterPeriodNo };
    const identity = `${semesterUnitId}:${proposal.curriculumNodeId}:${chapterPeriodNo}`;
    if (proposedBlueprintKeys.has(identity)) {
      throw new SemesterFrameworkPatchError("duplicate_lesson_blueprint_identity");
    }
    proposedBlueprintKeys.add(identity);
    const existing = args.aggregate.blueprints.find((blueprint) => (
      blueprint.semesterUnitId === semesterUnitId
      && blueprint.curriculumNodeId === proposal.curriculumNodeId
      && blueprint.chapterPeriodNo === chapterPeriodNo
    ));
    if (!existing) {
      expandedOperations.push({ ...normalizedProposal, semesterUnitId });
      return;
    }
    const fields = [
      "title",
      "mainActivity",
      "observableProduct",
      "assessmentEvidence",
      "anticipatedDifficulties",
      "teacherNotes",
      "plannedMinutes",
    ] as const;
    for (const field of fields) {
      const replacement = normalizedProposal[field];
      if (replacement == null || isDeepStrictEqual(existing[field], replacement)) continue;
      expandedOperations.push({
        op: "replace_lesson_blueprint_field",
        blueprintId: existing.id,
        field,
        expectedValue: existing[field],
        replacement,
      });
    }
  };
  for (const operation of args.proposal.operations) {
    if (operation.op !== "plan_semester_unit") {
      if (operation.op === "create_lesson_blueprint") {
        reconcileBlueprint(operation.semesterUnitId, operation);
      } else {
        expandedOperations.push(operation);
      }
      continue;
    }
    const unit = args.aggregate.units.find((candidate) => candidate.id === operation.unitId);
    if (!unit) throw new SemesterFrameworkPatchError("semester_unit_not_found");
    const replacements: Array<{
      field: "plannedStartWeek" | "plannedEndWeek" | "learningGoals";
      replacement: number | string | null;
    }> = [
      { field: "plannedStartWeek", replacement: operation.plannedStartWeek },
      { field: "plannedEndWeek", replacement: operation.plannedEndWeek },
      { field: "learningGoals", replacement: operation.learningGoals },
    ];
    for (const { field, replacement } of replacements) {
      const expectedValue = unit[field];
      if (isDeepStrictEqual(expectedValue, replacement)) continue;
      expandedOperations.push({
        op: "replace_unit_field",
        unitId: operation.unitId,
        field,
        expectedValue,
        replacement,
      });
    }
    const nextChapterPeriodByNode = new Map<string, number>();
    for (const blueprint of operation.blueprints) {
      const fallbackChapterPeriodNo = (nextChapterPeriodByNode.get(blueprint.curriculumNodeId) ?? 0) + 1;
      nextChapterPeriodByNode.set(blueprint.curriculumNodeId, fallbackChapterPeriodNo);
      reconcileBlueprint(operation.unitId, {
        ...blueprint,
        op: "create_lesson_blueprint",
        semesterUnitId: operation.unitId,
      }, fallbackChapterPeriodNo);
    }
  }
  const nextPeriodByUnit = new Map(args.aggregate.units.map((unit) => [
    unit.id,
    Math.max(0, ...args.aggregate.blueprints
      .filter((blueprint) => blueprint.semesterUnitId === unit.id)
      .map((blueprint) => blueprint.plannedPeriod)),
  ]));
  let nextSortNo = Math.max(0, ...args.aggregate.blueprints.map((blueprint) => blueprint.sortNo));
  const operations = expandedOperations.map((operation) => {
    if (operation.op === "delete_lesson_blueprint") {
      const blueprint = args.aggregate.blueprints.find((candidate) => (
        candidate.id === operation.blueprintId
      ));
      return {
        ...operation,
        expectedTitle: blueprint?.title,
        expectedSemesterUnitId: blueprint?.semesterUnitId,
      };
    }
    if (operation.op !== "create_lesson_blueprint") return operation;
    const plannedPeriod = (nextPeriodByUnit.get(operation.semesterUnitId) ?? 0) + 1;
    nextPeriodByUnit.set(operation.semesterUnitId, plannedPeriod);
    nextSortNo += 1;
    return {
      ...operation,
      blueprintId: crypto.randomUUID(),
      plannedPeriod,
      sortNo: nextSortNo,
      plannedMinutes: operation.plannedMinutes
        ?? args.aggregate.framework.lessonDurationMinutes,
      status: "draft" as const,
    };
  });
  const patch = semesterFrameworkPatchSchema.parse({
    summary: args.proposal.summary,
    operations,
    frameworkId: args.aggregate.framework.id,
    baseFrameworkVersion: args.aggregate.framework.version,
  });
  // Validate all targets, values and aggregate invariants before an approval is
  // shown. Applying later repeats the same checks against the latest snapshot.
  applyOperations(args.aggregate, patch, args.aggregate.framework.updatedAt);
  return patch;
}

export function applySemesterFrameworkPatch(
  aggregate: SemesterFrameworkAggregate,
  patch: SemesterFrameworkPatch,
  timestamp = new Date().toISOString(),
) {
  if (aggregate.framework.id !== patch.frameworkId) {
    throw new SemesterFrameworkPatchError("semester_framework_scope_invalid");
  }
  // baseFrameworkVersion is chronology, not a blanket conflict boundary.
  // Field/entity expected values decide whether a stale proposal can rebase.
  return applyOperations(aggregate, patch, timestamp);
}
