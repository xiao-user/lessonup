import { z } from "zod";
import type { LessonPlan } from "../domain.js";
import { dashiGoalSchema, dashiThemeSchema, type DashiGoal } from "./dashi-goal.js";

export { dashiThemeSchema } from "./dashi-goal.js";

export const approvedPresentationGoalRequestSchema = z.object({
  expectedDocumentVersion: z.number().int().nonnegative(),
  goal: dashiGoalSchema,
}).strict();

export type DirectClassroomPresentationRecord = {
  id: string;
  ownerId: string;
  notebookId: string;
  lessonFileId: string;
  title: string;
  theme: z.infer<typeof dashiThemeSchema>;
  sourceDocumentVersion: number;
  sourceDocument: LessonPlan;
  // Old local prototype records contain the deleted LessonUp outline shape.
  // Keep them readable but do not open them as an editable native Dashi deck.
  dashiGoal: DashiGoal | null;
  /**
   * Native Dashi goals stay canonical. The browser theme runtime mounts that
   * goal; older self-contained files are not opened through this path.
   */
  delivery: "native-dashi" | "legacy-static";
  // Points to the one private generated HTML object. The editor shell and
  // theme runtimes are shared application assets and never stored per deck.
  storageKey: string;
  mediaType: string;
  byteSize: number;
  checksum: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * A small durable status record for rendering the exact approved Dashi goal.
 */
export type ClassroomPresentationGeneration = {
  id: string;
  ownerId: string;
  notebookId: string;
  lessonFileId: string;
  sourceDocumentVersion: number;
  sourceDocument: LessonPlan;
  lessonTitle: string;
  subject: string;
  gradeLevel: string;
  learnerProfile: string;
  lessonDurationMinutes: number;
  /** The teacher-confirmed, version-bound native Dashi plan. */
  goal: DashiGoal | null;
  status: "generating" | "ready" | "failed";
  presentationId: string | null;
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
};

export type BeginClassroomPresentationGenerationResult = {
  generation: ClassroomPresentationGeneration;
  created: boolean;
};
