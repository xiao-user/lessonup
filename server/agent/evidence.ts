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
  "curriculum_standard_search",
  "knowledge_passage",
  "attachment_read",
  "web_open",
  "curriculum_textbook",
  "curriculum_outline",
  "curriculum_semantics",
  "curriculum_knowledge",
]);

const evidenceKey = (source: SourceRef) => source.url ?? source.id;

export function bindPatchToObservedEvidence(args: {
  patch: DocumentPatch;
  evidence: AgentRunEvidenceRecord[];
  evidenceRequired: boolean;
  requiredEvidenceKinds?: AgentRunEvidenceRecord["kind"][];
}) {
  const observed = new Map<string, SourceRef>();
  const observedByKind = new Map<AgentRunEvidenceRecord["kind"], SourceRef[]>();
  for (const record of args.evidence) {
    if (!eligibleEvidenceKinds.has(record.kind)) continue;
    observed.set(record.source.id, record.source);
    observed.set(evidenceKey(record.source), record.source);
    const byKind = observedByKind.get(record.kind) ?? [];
    byKind.push(record.source);
    observedByKind.set(record.kind, byKind);
  }

  const requested = args.patch.citations ?? [];
  const required = args.requiredEvidenceKinds ?? [];
  const requiredSources = required.flatMap((kind) => {
    const sources = observedByKind.get(kind) ?? [];
    if (!sources.length) throw new AgentEvidenceError("evidence_required");
    return sources;
  });
  const citationCandidates = requested.length
    ? [...requested, ...requiredSources]
    : args.evidenceRequired
      ? [...observed.values()]
      : requiredSources;
  const citations = citationCandidates.map((citation) => {
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
