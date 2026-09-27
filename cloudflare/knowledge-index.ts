import { KnowledgeIndexWorker } from "../server/knowledge/worker.js";
import { D1KnowledgeSourceStore } from "../server/knowledge/source-store.js";
import { D1SqlDatabase } from "../server/platform/d1-sql-database.js";
import { R2ObjectStorage } from "../server/platform/r2-object-storage.js";

/** Bounded scheduled drain; D1 leases make overlapping invocations safe. */
export async function processKnowledgeQueue(env: Env, limit = 4) {
  const database = new D1SqlDatabase(env.LESSONUP_DB);
  const worker = new KnowledgeIndexWorker(
    new R2ObjectStorage(env.LESSONUP_PRIVATE_OBJECTS),
    new D1KnowledgeSourceStore(database),
  );
  for (let index = 0; index < limit; index += 1) {
    if (!await worker.processNext()) break;
  }
}
