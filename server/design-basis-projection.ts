import { isDeepStrictEqual } from "node:util";

import {
  documentPatchSchema,
  type DesignBasisProjectionProposal,
  type DocumentPatch,
  type LessonDesignBasisAggregate,
  type LessonField,
  type LessonFileRecord,
  type SourceRef,
} from "./domain.js";
import { materializeDocumentPatchProposal } from "./document-patch.js";

const PROJECTABLE_FIELDS = new Set<LessonField>([
  "objectives",
  "focus",
  "preparation",
  "process",
  "assessment",
  "homework",
  "board",
  "reflection",
]);

export class DesignBasisProjectionError extends Error {
  constructor(
    public readonly code: "invalid_projection" | "stale_design_basis",
    message: string,
  ) {
    super(message);
    this.name = "DesignBasisProjectionError";
  }
}

const uniqueSources = (sources: SourceRef[]) => [
  ...new Map(sources.map((source) => [source.url ?? source.id, source])).values(),
];

export function assertDesignBasisProjectionCurrent(
  patch: DocumentPatch,
  aggregate: LessonDesignBasisAggregate,
) {
  const projection = patch.projection;
  if (!projection) return;
  if (
    projection.basisId !== aggregate.basis.id
    || patch.fileId !== aggregate.basis.lessonFileId
  ) {
    throw new DesignBasisProjectionError("stale_design_basis", "投影来源不属于当前教案");
  }

  const refs = new Map(projection.entryRefs.map((ref) => [ref.entryId, ref]));
  if (refs.size !== projection.entryRefs.length) {
    throw new DesignBasisProjectionError("invalid_projection", "投影中存在重复的设计依据条目");
  }
  for (const ref of projection.entryRefs) {
    const entry = aggregate.entries.find((candidate) => candidate.id === ref.entryId);
    if (
      !entry
      || entry.version !== ref.expectedVersion
      || entry.statement !== ref.expectedStatement
      || entry.decision !== "accepted"
      || !entry.teacherConfirmed
    ) {
      throw new DesignBasisProjectionError("stale_design_basis", "投影所依据的教学决定已经变化");
    }
  }
  if (
    projection.expectedLearnerContext !== undefined
    && !isDeepStrictEqual(
      projection.expectedLearnerContext,
      aggregate.basis.learnerContext,
    )
  ) {
    throw new DesignBasisProjectionError("stale_design_basis", "投影所依据的学情已经变化");
  }

  const mappedEntries = new Set<string>();
  const mappedOperations = new Set<number>();
  for (const mapping of projection.operationMappings) {
    if (
      mapping.operationIndex >= patch.operations.length
      || mappedOperations.has(mapping.operationIndex)
      || (!mapping.entryIds.length && !mapping.usesLearnerContext)
      || mapping.entryIds.some((entryId) => !refs.has(entryId))
    ) {
      throw new DesignBasisProjectionError("invalid_projection", "投影来源映射无效");
    }
    mappedOperations.add(mapping.operationIndex);
    mapping.entryIds.forEach((entryId) => mappedEntries.add(entryId));
    if (mapping.usesLearnerContext && projection.expectedLearnerContext === undefined) {
      throw new DesignBasisProjectionError("invalid_projection", "投影缺少学情快照");
    }
  }
  if (
    mappedOperations.size !== patch.operations.length
    || mappedEntries.size !== refs.size
  ) {
    throw new DesignBasisProjectionError("invalid_projection", "投影没有完整绑定正文修改与设计依据");
  }
}

export function materializeDesignBasisProjection(args: {
  proposal: DesignBasisProjectionProposal;
  aggregate: LessonDesignBasisAggregate;
  file: LessonFileRecord;
}): DocumentPatch {
  if (args.aggregate.basis.lessonFileId !== args.file.id) {
    throw new DesignBasisProjectionError("invalid_projection", "设计依据与教案不匹配");
  }

  const entries = new Map(args.aggregate.entries.map((entry) => [entry.id, entry]));
  const selected = new Map<string, LessonDesignBasisAggregate["entries"][number]>();
  let usesLearnerContext = false;
  const documentOperations = args.proposal.operations.map((operation) => {
    if (!PROJECTABLE_FIELDS.has(operation.field)) {
      throw new DesignBasisProjectionError(
        "invalid_projection",
        `${operation.field} 不是设计依据可直接投影的课堂执行栏目`,
      );
    }
    for (const entryId of operation.basisEntryIds) {
      const entry = entries.get(entryId);
      if (!entry || entry.decision !== "accepted" || !entry.teacherConfirmed) {
        throw new DesignBasisProjectionError(
          "stale_design_basis",
          "只能投影当前已确认且仍被接受的设计依据",
        );
      }
      selected.set(entry.id, entry);
    }
    usesLearnerContext ||= operation.usesLearnerContext;
    return {
      field: operation.field,
      expectedText: args.file.document[operation.field],
      replacement: operation.replacement,
    };
  });
  if (usesLearnerContext && !Object.keys(args.aggregate.basis.learnerContext).length) {
    throw new DesignBasisProjectionError("invalid_projection", "当前设计依据没有可投影的学情信息");
  }

  const basePatch = materializeDocumentPatchProposal({
    proposal: {
      summary: args.proposal.summary,
      operations: documentOperations,
    },
    fileId: args.file.id,
    documentVersion: args.file.documentVersion,
    plan: args.file.document,
  });
  const entryRefs = [...selected.values()].map((entry) => ({
    entryId: entry.id,
    expectedVersion: entry.version,
    expectedStatement: entry.statement,
  }));
  const patch = documentPatchSchema.parse({
    ...basePatch,
    citations: uniqueSources([...selected.values()].flatMap((entry) => entry.evidence)),
    projection: {
      basisId: args.aggregate.basis.id,
      baseBasisVersion: args.aggregate.basis.version,
      entryRefs,
      expectedLearnerContext: usesLearnerContext
        ? args.aggregate.basis.learnerContext
        : undefined,
      operationMappings: args.proposal.operations.map((operation, operationIndex) => ({
        operationIndex,
        entryIds: operation.basisEntryIds,
        usesLearnerContext: operation.usesLearnerContext,
      })),
    },
  });
  assertDesignBasisProjectionCurrent(patch, args.aggregate);
  return patch;
}
