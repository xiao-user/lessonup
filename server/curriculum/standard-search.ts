import { createHash } from "node:crypto";
import type { LessonRepository } from "../repository.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// Bump whenever retrieval filtering or ranking semantics change so results
// produced by an older SQL contract cannot silently bypass the new policy.
export const CURRICULUM_STANDARD_RETRIEVAL_VERSION = "grade-aware-v3";

export const normalizedCurriculumStandardQuery = (query: string) => query
  .normalize("NFKC")
  .trim()
  .replace(/\s+/g, " ");

export const curriculumStandardSearchCacheIdentity = (input: {
  releaseFingerprint: string | null;
  subject: string;
  stage: string;
  grade: string;
  query: string;
  /** Whether query vectors take part in ranking; vectorless results must not stand in for vector ones. */
  semantic?: boolean;
}) => ({
  contextFingerprint: sha256(JSON.stringify({
    retrievalVersion: CURRICULUM_STANDARD_RETRIEVAL_VERSION,
    release: input.releaseFingerprint ?? "unpublished",
    subject: input.subject,
    stage: input.stage,
    grade: input.grade,
    semantic: input.semantic ?? true,
  })),
  querySha256: sha256(normalizedCurriculumStandardQuery(input.query)),
});

/**
 * Searches the published standards within the notebook's verified subject,
 * stage and grade, reusing the exact latest result for the same published
 * release, scope and query. `embed` throwing means the service failed: the
 * search still runs on text alone, but that degraded result is not cached.
 */
export async function searchScopedCurriculumStandards(args: {
  repository: LessonRepository;
  scope: { userId: string; notebookId: string; runId: string };
  query: string;
  limit: number;
  embed?: (query: string) => Promise<number[] | undefined>;
}) {
  const notebook = await args.repository.getNotebook(args.scope.userId, args.scope.notebookId);
  if (!notebook) throw new Error("notebook_not_found");
  const releaseFingerprint = await args.repository.getPublishedCurriculumStandardFingerprint();
  const cacheIdentity = curriculumStandardSearchCacheIdentity({
    releaseFingerprint,
    subject: notebook.subject,
    stage: notebook.stage,
    grade: notebook.grade,
    query: args.query,
    semantic: Boolean(args.embed),
  });
  const cached = await args.repository.getCurriculumStandardSearchCache({
    ...cacheIdentity,
    limit: args.limit,
  }).catch(() => null);
  let results: Awaited<ReturnType<LessonRepository["searchCurriculumStandards"]>>;
  let freshness: "reused" | "retrieved";
  if (cached) {
    results = cached.results;
    freshness = "reused";
  } else {
    const normalizedQuery = normalizedCurriculumStandardQuery(args.query);
    let vector: number[] | undefined;
    let degraded = false;
    if (args.embed) {
      try {
        vector = await args.embed(normalizedQuery);
        degraded = !vector?.length;
      } catch (error) {
        degraded = true;
        console.warn("Query embedding unavailable; using lexical retrieval", error instanceof Error ? error.message : "unknown_error");
      }
    }
    results = await args.repository.searchCurriculumStandards({
      query: normalizedQuery,
      subject: notebook.subject,
      stage: notebook.stage,
      grade: notebook.grade,
      limit: args.limit,
      embedding: vector,
    });
    freshness = "retrieved";
    if (!degraded) {
      await args.repository.saveCurriculumStandardSearchCache({
        ...cacheIdentity,
        limit: args.limit,
        results,
      }).catch(() => undefined);
    }
  }
  await args.repository.recordRunEvidence(
    args.scope.userId,
    args.scope.runId,
    "curriculum_standard_search",
    results,
  );
  return { status: results.length ? "available" as const : "unavailable" as const, freshness, results };
}
