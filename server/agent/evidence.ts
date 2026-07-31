import type {
  AgentRunEvidenceRecord,
  DocumentPatch,
  SourceRef,
} from "../domain.js";

export class AgentEvidenceError extends Error {
  constructor(public readonly code: "evidence_required" | "unverified_patch_citation") {
    super(code);
    this.name = "AgentEvidenceError";
  }
}

const eligibleEvidenceKinds = new Set<AgentRunEvidenceRecord["kind"]>([
  "knowledge_search",
  "knowledge_passage",
  "attachment_read",
  "web_open",
  "curriculum_textbook",
  "curriculum_outline",
]);

const evidenceKey = (source: SourceRef) => source.url ?? source.id;

export function bindPatchToObservedEvidence(args: {
  patch: DocumentPatch;
  evidence: AgentRunEvidenceRecord[];
  evidenceRequired: boolean;
}) {
  const observed = new Map<string, SourceRef>();
  for (const record of args.evidence) {
    if (!eligibleEvidenceKinds.has(record.kind)) continue;
    observed.set(record.source.id, record.source);
    observed.set(evidenceKey(record.source), record.source);
  }

  const requested = args.patch.citations ?? [];
  const citations = (requested.length ? requested : (
    args.evidenceRequired ? [...observed.values()] : []
  )).map((citation) => {
    const canonical = observed.get(citation.id) ?? observed.get(evidenceKey(citation));
    if (!canonical) throw new AgentEvidenceError("unverified_patch_citation");
    return canonical;
  });
  const unique = [...new Map(citations.map((citation) => [evidenceKey(citation), citation])).values()];
  if (args.evidenceRequired && unique.length === 0) {
    throw new AgentEvidenceError("evidence_required");
  }
  return {
    ...args.patch,
    citations: unique.length ? unique : undefined,
  };
}
