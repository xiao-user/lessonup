export const THINKING_LEVELS = [
  { value: "low", label: "轻度", description: "教案任务更快推理；致谢仍由模型作答" },
  { value: "high", label: "增强", description: "更充分推理" },
  { value: "max", label: "深度", description: "最完整推理" },
];

export const DEFAULT_THINKING_LEVEL = "low";
export const THINKING_LEVEL_STORAGE_KEY = "lessonup:thinking-level";

const THINKING_LEVEL_VALUES = new Set(THINKING_LEVELS.map((item) => item.value));

export function parseThinkingLevel(value) {
  return THINKING_LEVEL_VALUES.has(value) ? value : DEFAULT_THINKING_LEVEL;
}

export function thinkingLevelLabel(value) {
  const parsed = parseThinkingLevel(value);
  return THINKING_LEVELS.find((item) => item.value === parsed)?.label ?? "轻度";
}

export function readStoredThinkingLevel() {
  try {
    return parseThinkingLevel(window.localStorage.getItem(THINKING_LEVEL_STORAGE_KEY));
  } catch {
    return DEFAULT_THINKING_LEVEL;
  }
}

export function persistThinkingLevel(value) {
  const next = parseThinkingLevel(value);
  try {
    window.localStorage.setItem(THINKING_LEVEL_STORAGE_KEY, next);
  } catch {
    // Private mode and quota failures still keep the in-memory selection.
  }
  return next;
}
