import {
  lessonDesignBasisPatchSchema,
  lessonDesignBasisPatchToolSchema,
  type AgentRunEvidenceRecord,
  type LessonDesignBasisAggregate,
  type LessonDesignBasisPatch,
  type LessonDesignBasisPatchProposal,
} from "./domain.js";

export class LessonDesignBasisPatchError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LessonDesignBasisPatchError";
  }
}

const sameValue = (left: unknown, right: unknown) => (
  JSON.stringify(left) === JSON.stringify(right)
);

const entryTarget = (operation: LessonDesignBasisPatch["operations"][number]) => {
  if (operation.op === "replace_design_basis_field") return `basis:${operation.field}`;
  if (operation.op === "create_design_basis_entry") return `entry:create:${operation.entryId}`;
  if (operation.op === "delete_design_basis_entry") return `entry:delete:${operation.entryId}`;
  return `entry:${operation.entryId}:${operation.field}`;
};

export function materializeLessonDesignBasisPatch(args: {
  proposal: LessonDesignBasisPatchProposal;
  aggregate: LessonDesignBasisAggregate;
  observedEvidence?: AgentRunEvidenceRecord[];
}): LessonDesignBasisPatch {
  const proposal = lessonDesignBasisPatchToolSchema.parse(args.proposal);
  const observedSources = new Map(
    (args.observedEvidence ?? []).map((record) => [record.source.id, record.source]),
  );
  let nextSortNo = Math.max(0, ...args.aggregate.entries.map((entry) => entry.sortNo));
  const operations = proposal.operations.map((operation) => {
    if (operation.op === "create_design_basis_entry") {
      const { evidenceSourceIds, ...content } = operation;
      if (
        (operation.kind === "knowledge_point"
          || operation.kind === "review"
          || operation.kind === "prepare")
        && evidenceSourceIds.length === 0
      ) {
        throw new LessonDesignBasisPatchError("design_basis_evidence_required");
      }
      const evidence = evidenceSourceIds.map((sourceId) => {
        const source = observedSources.get(sourceId);
        if (!source) throw new LessonDesignBasisPatchError("unobserved_design_basis_evidence");
        return source;
      });
      nextSortNo += 1;
      return {
        ...content,
        evidence,
        origin: "agent" as const,
        entryId: crypto.randomUUID(),
        sortNo: nextSortNo,
        teacherConfirmed: true,
      };
    }
    if (operation.op === "delete_design_basis_entry") {
      const entry = args.aggregate.entries.find((candidate) => candidate.id === operation.entryId);
      if (!entry) throw new LessonDesignBasisPatchError("design_basis_entry_not_found");
      return { ...operation, expectedStatement: entry.statement };
    }
    return operation;
  });
  return lessonDesignBasisPatchSchema.parse({
    basisId: args.aggregate.basis.id,
    fileId: args.aggregate.basis.lessonFileId,
    baseBasisVersion: args.aggregate.basis.version,
    summary: proposal.summary,
    operations,
  });
}

export function applyLessonDesignBasisPatch(
  aggregate: LessonDesignBasisAggregate,
  input: LessonDesignBasisPatch,
  timestamp: string,
): LessonDesignBasisAggregate {
  const patch = lessonDesignBasisPatchSchema.parse(input);
  if (
    patch.basisId !== aggregate.basis.id
    || patch.fileId !== aggregate.basis.lessonFileId
  ) {
    throw new LessonDesignBasisPatchError("design_basis_scope_invalid");
  }

  const next = structuredClone(aggregate);
  const seen = new Set<string>();
  const changedEntryIds = new Set<string>();

  for (const operation of patch.operations) {
    const target = entryTarget(operation);
    if (seen.has(target)) throw new LessonDesignBasisPatchError("duplicate_design_basis_patch_target");
    seen.add(target);

    if (operation.op === "replace_design_basis_field") {
      const current = next.basis[operation.field];
      if (!sameValue(current, operation.expectedValue)) {
        throw new LessonDesignBasisPatchError("stale_resource");
      }
      if (sameValue(current, operation.replacement)) {
        throw new LessonDesignBasisPatchError("no_effect_patch");
      }
      (next.basis as unknown as Record<string, unknown>)[operation.field] = structuredClone(
        operation.replacement,
      );
      continue;
    }

    if (operation.op === "create_design_basis_entry") {
      if (next.entries.some((entry) => entry.id === operation.entryId)) {
        throw new LessonDesignBasisPatchError("duplicate_design_basis_entry_id");
      }
      if (next.entries.some((entry) => entry.sortNo === operation.sortNo)) {
        throw new LessonDesignBasisPatchError("duplicate_design_basis_entry_order");
      }
      next.entries.push({
        id: operation.entryId,
        basisId: next.basis.id,
        kind: operation.kind,
        semanticEntityId: operation.semanticEntityId,
        semanticEntityName: null,
        relatedSemanticEntityId: operation.relatedSemanticEntityId,
        relatedSemanticEntityName: null,
        relatedCurriculumNodeId: operation.relatedCurriculumNodeId,
        relatedCurriculumNodeTitle: null,
        statement: operation.statement,
        rationale: operation.rationale,
        evidence: structuredClone(operation.evidence),
        decision: operation.decision,
        teacherConfirmed: operation.teacherConfirmed,
        origin: operation.origin,
        sortNo: operation.sortNo,
        version: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      continue;
    }

    const entry = next.entries.find((candidate) => candidate.id === operation.entryId);
    if (!entry) throw new LessonDesignBasisPatchError("design_basis_entry_not_found");
    if (operation.op === "delete_design_basis_entry") {
      if (entry.version !== operation.expectedVersion) {
        throw new LessonDesignBasisPatchError("stale_resource");
      }
      next.entries = next.entries.filter((candidate) => candidate.id !== entry.id);
      continue;
    }

    const current = entry[operation.field];
    if (!sameValue(current, operation.expectedValue)) {
      throw new LessonDesignBasisPatchError("stale_resource");
    }
    if (sameValue(current, operation.replacement)) {
      throw new LessonDesignBasisPatchError("no_effect_patch");
    }
    (entry as unknown as Record<string, unknown>)[operation.field] = structuredClone(
      operation.replacement,
    );
    entry.teacherConfirmed = true;
    changedEntryIds.add(entry.id);
  }

  for (const entry of next.entries) {
    if (!changedEntryIds.has(entry.id)) continue;
    entry.version += 1;
    entry.updatedAt = timestamp;
  }
  next.entries.sort((left, right) => left.sortNo - right.sortNo || left.id.localeCompare(right.id));
  next.basis.version += 1;
  next.basis.updatedAt = timestamp;
  return next;
}
