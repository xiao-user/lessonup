import type { SqlDatabase } from "../platform/sql-database.js";
import type { LessonRepository } from "../repository.js";
import { MemoryLessonRepository } from "./memory-repository.js";
import { createD1LessonCoreRepository } from "./d1-lesson-core-repository.js";

export function createRepository(database?: SqlDatabase): LessonRepository {
  return database ? createD1LessonCoreRepository(database) : new MemoryLessonRepository();
}
