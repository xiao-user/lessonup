import { config } from "./config.js";
import type { SqlDatabase } from "./platform/sql-database.js";

/** Global D1 recovery transitions for leases with no active request owner. */
export class LessonUpMaintenance {
  private readonly database: SqlDatabase | null;

  constructor(database: SqlDatabase | null = null) {
    this.database = database;
  }

  start() {
    if (!this.database) return () => undefined;
    let active = false;
    const run = async () => {
      if (active) return;
      active = true;
      try {
        await runLessonUpMaintenance(this.database!);
      } catch (error) {
        console.error("LessonUp maintenance failed", error instanceof Error ? error.message : "unknown_error");
      } finally {
        active = false;
      }
    };
    void run();
    const timer = setInterval(() => void run(), config.MAINTENANCE_INTERVAL_MS);
    return () => clearInterval(timer);
  }
}

/** One portable maintenance pass, usable from Worker scheduled events. */
export async function runLessonUpMaintenance(database: SqlDatabase, now = new Date().toISOString()) {
  await database.batch([
    { sql: `UPDATE agent_approvals SET state = 'expired', continuation_error = 'approval_expired', resolved_at = ?
      WHERE state = 'pending' AND expires_at <= ?`, params: [now, now] },
    { sql: `UPDATE agent_runs SET status = 'failed', error = 'approval_expired', completed_at = ?
      WHERE status NOT IN ('completed', 'cancelled') AND EXISTS (
        SELECT 1 FROM agent_approvals WHERE agent_approvals.owner_id = agent_runs.owner_id
          AND agent_approvals.run_id = agent_runs.id AND agent_approvals.state = 'expired'
      )`, params: [now] },
    { sql: `UPDATE agent_threads SET status = 'failed', updated_at = ?
      WHERE status IN ('awaiting_approval', 'running') AND EXISTS (
        SELECT 1 FROM agent_approvals WHERE agent_approvals.owner_id = agent_threads.owner_id
          AND agent_approvals.thread_id = agent_threads.id AND agent_approvals.state = 'expired'
      )`, params: [now] },
    { sql: `UPDATE knowledge_sources SET status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
        available_at = ?, worker_id = NULL, lease_expires_at = NULL,
        last_error = COALESCE(last_error, 'worker_lease_expired'), updated_at = ?
      WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`, params: [now, now, now] },
  ]);
}
