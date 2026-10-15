import type { AgentRunEvidenceKind, SourceRef } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";

/**
 * Wraps a repository so a run's retrievals are remembered by kind, including a
 * search that found nothing: `recordRunEvidence` is the one place every
 * evidence tool reports to, and it stores nothing for an empty result.
 * A consult-only answer that honestly says "no source found" has still looked,
 * which is all the evidence tripwire asks of it.
 */
export function trackEvidenceAttempts(repository: LessonRepository) {
  const attempts = new Set<AgentRunEvidenceKind>();
  const tracked = new Proxy(repository, {
    get(target, property) {
      if (property === "recordRunEvidence") {
        return async (ownerId: string, runId: string, kind: AgentRunEvidenceKind, sources: SourceRef[]) => {
          await target.recordRunEvidence(ownerId, runId, kind, sources);
          attempts.add(kind);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { repository: tracked, attempts: attempts as ReadonlySet<AgentRunEvidenceKind> };
}
