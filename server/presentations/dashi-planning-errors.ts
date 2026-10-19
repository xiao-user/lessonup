const messages = {
  presentation_theme_required: "尚未选定演示主题，请选择主题或让助手选择后继续。",
  presentation_theme_invalid: "所选主题不在可用范围，请选择一个可用主题后继续。",
  presentation_theme_mismatch: "本次演示已有固定主题，请沿用该主题继续；更换主题需另行确认。",
  presentation_theme_binding_failed: "演示主题未能保存，本轮已停止。请稍后重试，保留当前演示任务。",
  presentation_planning_blocked: "演示主题校验重复失败，本轮已停止。请核对主题后继续当前演示任务。",
} as const;

export type DashiPlanningErrorCode = keyof typeof messages;
const terminalCodes: ReadonlySet<DashiPlanningErrorCode> = new Set([
  "presentation_theme_binding_failed", "presentation_planning_blocked",
]);

/** Errors carry only safe business codes; provider and persistence errors stay private. */
export class DashiPlanningError extends Error {
  constructor(readonly code: DashiPlanningErrorCode) { super(code); this.name = "DashiPlanningError"; }
}

export function safeDashiPlanningError(error: unknown): {
  code: DashiPlanningErrorCode; detail: string; terminal: boolean;
} | null {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (!Object.hasOwn(messages, code)) return null;
  const safeCode = code as DashiPlanningErrorCode;
  return { code: safeCode, detail: messages[safeCode], terminal: terminalCodes.has(safeCode) };
}

export const isTerminalDashiPlanningError = (error: unknown): boolean => Boolean(safeDashiPlanningError(error)?.terminal);
