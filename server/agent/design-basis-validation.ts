import type { LessonAgentContext, LessonDesignBasisPatchProposal } from "../domain.js";
import { LessonDesignBasisPatchError } from "../lesson-design-basis-patch.js";
import type { LessonRepository } from "../repository.js";
import { WritePreflightError } from "./write-scope.js";

export async function validateLessonDesignProposalReferences(args: {
  repository: LessonRepository;
  context: LessonAgentContext;
  proposal: LessonDesignBasisPatchProposal;
}) {
  const evidence = await args.repository.listRunEvidence(args.context.userId, args.context.runId);
  const observedSources = new Set(evidence.map((record) => record.source.id));
  const nodes = args.context.contextProfile.textbookId
    ? await args.repository.listCurriculumNodes({
        textbookId: args.context.contextProfile.textbookId,
        maxLevel: 8,
      })
    : [];
  const nodeIds = new Set(nodes.map((node) => node.nodeId));

  for (const operation of args.proposal.operations) {
    if (operation.op !== "create_design_basis_entry") continue;
    if (!["knowledge_point", "review", "prepare"].includes(operation.kind)) continue;
    if (!operation.evidenceSourceIds.length) {
      throw new LessonDesignBasisPatchError("design_basis_evidence_required");
    }
    if (operation.evidenceSourceIds.some((sourceId) => !observedSources.has(sourceId))) {
      throw new LessonDesignBasisPatchError("unobserved_design_basis_evidence");
    }
    const entity = operation.semanticEntityId
      ? await args.repository.getCurriculumSemanticEntity(operation.semanticEntityId)
      : null;
    if (!entity) throw new WritePreflightError("unknown_curriculum_entity");
    const entitySources = new Set(entity.sources.map((source) => source.id));
    if (!operation.evidenceSourceIds.some((sourceId) => entitySources.has(sourceId))) {
      throw new WritePreflightError("curriculum_evidence_mismatch");
    }
    if (operation.kind === "review" || operation.kind === "prepare") {
      const related = operation.relatedSemanticEntityId
        ? await args.repository.getCurriculumSemanticEntity(operation.relatedSemanticEntityId)
        : null;
      if (!related) throw new WritePreflightError("unknown_curriculum_entity");
      if (
        !operation.relatedCurriculumNodeId
        || !args.context.contextProfile.textbookId
        || !nodeIds.has(operation.relatedCurriculumNodeId)
      ) throw new WritePreflightError("curriculum_node_scope_invalid");
    }
  }
}
