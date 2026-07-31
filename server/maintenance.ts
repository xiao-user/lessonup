import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasSupabase } from "./config.js";

export class LessonUpMaintenance {
  private readonly client: SupabaseClient | null;

  constructor() {
    this.client = hasSupabase
      ? createClient(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : null;
  }

  start() {
    if (!this.client) return () => undefined;
    let active = false;
    const run = async () => {
      if (active) return;
      active = true;
      try {
        const recovery = await this.client!.rpc("recover_all_expired_agent_runs");
        if (recovery.error) throw new Error(recovery.error.message);
        const result = await this.client!.rpc("perform_lessonup_maintenance");
        if (result.error) throw new Error(result.error.message);
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
