import type {
  AgentRunEvidenceKind,
  AgentRunEvidenceRecord,
  CapabilityPlan,
} from "../domain.js";

const directlyObservedKinds = new Set<AgentRunEvidenceKind>([
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

const evidenceKindToolHint: Partial<Record<AgentRunEvidenceKind, string>> = {
  knowledge_search: "search_knowledge",
  curriculum_standard_search: "search_curriculum_standards",
  knowledge_passage: "read_knowledge_source",
  attachment_read: "read_attached_source",
  web_open: "open_web_page",
  curriculum_textbook: "lookup_curriculum_textbooks",
  curriculum_outline: "read_curriculum_outline",
  curriculum_semantics: "read_curriculum_node_semantics",
  curriculum_knowledge: "read_curriculum_knowledge_points",
};

/**
 * Tool-visible recovery: the model must see which reads are still missing,
 * not a bare `evidence_required` token that it retries by re-proposing.
 */
export function evidenceRequiredToolError(missingKinds: AgentRunEvidenceKind[]) {
  const hints = missingKinds
    .map((kind) => evidenceKindToolHint[kind])
    .filter((hint): hint is string => Boolean(hint));
  const message = missingKinds.length
    ? `本轮还缺少这些已观察依据（${missingKinds.join("、")}）。请先调用 ${hints.join("、") || "对应读取工具"}，取得结果后再提交提案。`
    : "本轮尚未读取任何可引用依据。请先读取课标、知识点、附件或知识检索结果，再提交提案。";
  return new Error(JSON.stringify({
    error: "evidence_required",
    missingKinds,
    message,
  }));
}

export function validateObservedEvidence(args: {
  plan: CapabilityPlan;
  evidence: AgentRunEvidenceRecord[];
}) {
  if (!args.plan.evidenceRequired) {
    return { tripwireTriggered: false, outputInfo: { code: "ok", missingKinds: [] as AgentRunEvidenceKind[] } };
  }

  const observedKinds = new Set(
    args.evidence
      .map((record) => record.kind)
      .filter((kind) => directlyObservedKinds.has(kind)),
  );
  const requiredKinds = args.plan.requiredEvidenceKinds ?? [];
  const missingKinds = requiredKinds.filter((kind) => !observedKinds.has(kind));
  const hasDirectEvidence = observedKinds.size > 0;

  return {
    tripwireTriggered: !hasDirectEvidence || missingKinds.length > 0,
    outputInfo: {
      code: !hasDirectEvidence || missingKinds.length > 0 ? "evidence_required" : "ok",
      missingKinds,
    },
  };
}
