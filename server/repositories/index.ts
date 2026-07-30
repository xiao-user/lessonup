import { config, hasSupabase } from "../config.js";
import type { LessonRepository } from "../repository.js";
import { MemoryLessonRepository } from "./memory-repository.js";
import { SupabaseLessonRepository } from "./supabase-repository.js";

export function createRepository(): LessonRepository {
  if (hasSupabase) {
    return new SupabaseLessonRepository(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!);
  }
  return new MemoryLessonRepository();
}
