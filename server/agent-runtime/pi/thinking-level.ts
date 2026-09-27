export const TEACHER_THINKING_LEVELS = ["low", "high", "max"] as const;
export type TeacherThinkingLevel = (typeof TEACHER_THINKING_LEVELS)[number];
export const DEFAULT_TEACHER_THINKING_LEVEL: TeacherThinkingLevel = "low";

export function resolveTeacherThinkingLevel(value: unknown): TeacherThinkingLevel {
  return TEACHER_THINKING_LEVELS.includes(value as TeacherThinkingLevel)
    ? (value as TeacherThinkingLevel)
    : DEFAULT_TEACHER_THINKING_LEVEL;
}

/**
 * Fast chat uses the lowest GLM-5.3-legal effort. Omitting reasoning_effort
 * lets that host default to max. Agent turns keep the PromptBar value.
 */
export function resolveRunThinkingLevel(args: {
  lane: "fast" | "agent";
  requested: unknown;
}): TeacherThinkingLevel {
  if (args.lane === "fast") return "low";
  return resolveTeacherThinkingLevel(args.requested);
}
