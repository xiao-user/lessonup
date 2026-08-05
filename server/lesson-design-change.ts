import {
  lessonDesignChangePatchSchema,
  lessonDesignChangeToolSchema,
  type AgentRunEvidenceRecord,
  type LessonDesignBasisAggregate,
  type LessonDesignChangePatch,
  type LessonDesignChangeProposal,
  type LessonFileRecord,
} from "./domain.js";
import { materializeDesignBasisProjection } from "./design-basis-projection.js";
import {
  applyLessonDesignBasisPatch,
  materializeLessonDesignBasisPatch,
} from "./lesson-design-basis-patch.js";

export class LessonDesignChangeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LessonDesignChangeError";
  }
}

export function materializeLessonDesignChange(args: {
  proposal: LessonDesignChangeProposal;
  aggregate: LessonDesignBasisAggregate;
  file: LessonFileRecord;
  observedEvidence?: AgentRunEvidenceRecord[];
  timestamp?: string;
}): LessonDesignChangePatch {
  const proposal = lessonDesignChangeToolSchema.parse(args.proposal);
  if (args.aggregate.basis.lessonFileId !== args.file.id) {
    throw new LessonDesignChangeError("lesson_design_change_scope_invalid");
  }

  const designBasisPatch = materializeLessonDesignBasisPatch({
    proposal: {
      summary: proposal.summary,
      operations: proposal.designBasisOperations,
    },
    aggregate: args.aggregate,
    observedEvidence: args.observedEvidence,
  });
  const projectedAggregate = applyLessonDesignBasisPatch(
    args.aggregate,
    designBasisPatch,
    args.timestamp ?? new Date().toISOString(),
  );

  const proposedCreates = proposal.designBasisOperations.filter((operation) => (
    operation.op === "create_design_basis_entry"
  ));
  const materializedCreates = designBasisPatch.operations.filter((operation) => (
    operation.op === "create_design_basis_entry"
  ));
  if (proposedCreates.length !== materializedCreates.length) {
    throw new LessonDesignChangeError("lesson_design_change_reference_invalid");
  }
  const createdEntryIds = new Map<string, string>();
  proposedCreates.forEach((operation, index) => {
    if (!operation.referenceKey) {
      throw new LessonDesignChangeError("lesson_design_change_reference_invalid");
    }
    createdEntryIds.set(operation.referenceKey, materializedCreates[index].entryId);
  });

  const documentPatch = materializeDesignBasisProjection({
    aggregate: projectedAggregate,
    file: args.file,
    proposal: {
      summary: proposal.summary,
      operations: proposal.documentOperations.map((operation) => ({
        field: operation.field,
        replacement: operation.replacement,
        basisEntryIds: [
          ...operation.basisEntryIds,
          ...operation.createdBasisEntryRefs.map((reference) => {
            const entryId = createdEntryIds.get(reference);
            if (!entryId) {
              throw new LessonDesignChangeError("lesson_design_change_reference_invalid");
            }
            return entryId;
          }),
        ],
        usesLearnerContext: operation.usesLearnerContext,
      })),
    },
  });

  return lessonDesignChangePatchSchema.parse({
    ...documentPatch,
    designBasisPatch,
  });
}
