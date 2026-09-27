import type { LessonRepository } from "../../repository.js";
import { type Emit } from "./contracts.js";

export async function emitRunEvidence(repository: Pick<LessonRepository, "listRunEvidence">, userId: string, runId: string, emit: Emit) {
  const evidence = await repository.listRunEvidence(userId, runId);
  const sources = [...new Map(evidence.map((record) => [record.source.id, record.source])).values()];
  for (const source of sources) await emit({ type: "source.added", runId, source });
  return sources;
}
