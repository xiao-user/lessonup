import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { BrowserDashiSkill } from "../../presentations/browser-dashi-skill.js";
import type { DashiThemeId } from "../../presentations/dashi-theme-catalog.js";
import { DashiPlanningError, type DashiPlanningErrorCode } from "../../presentations/dashi-planning-errors.js";

const themeIds = [
  "theme01", "theme02", "theme03", "theme04", "theme05", "theme06",
  "theme07", "theme08", "theme09", "theme10", "theme11", "theme12",
] as const;

type PlanningCapability = Pick<BrowserDashiSkill, "queryLayouts" | "inspectLayouts">;

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: null,
});

const progressResult = (label: string, current?: number, total?: number) => ({
  content: [],
  details: { publicProgress: { label, current, total } },
});

const asRecord = (value: unknown) => (
  value && typeof value === "object" ? value as Record<string, unknown> : {}
);

const asArray = (value: unknown) => Array.isArray(value) ? value : [];

/** Map natural classroom intent onto Dashi's visual taxonomy. */
function roleForIntent(intent: string) {
  const value = intent.toLowerCase();
  if (/封面|课题|标题|cover|opening title/.test(value)) return "cover";
  if (/复习|衔接|导入|背景|起点|context|review|opening/.test(value)) return "context";
  if (/原文|例句|材料|观察|圈画|阅读|文本|observation|material|text/.test(value)) return "observation";
  if (/对照|比较|辨析|区别|comparison|contrast/.test(value)) return "comparison";
  if (/关系|结构|概念图|关联|relationship|structure/.test(value)) return "relationship";
  if (/方法|步骤|支架|流程|分析|process|method|scaffold/.test(value)) return "process";
  if (/练习|任务|写作|操作|讨论|actions?|task|practice|writing/.test(value)) return "actions";
  if (/揭示|结论|检验|评价|反馈|结果|result|reveal|assessment/.test(value)) return "result";
  if (/收束|小结|迁移|作业|closing|summary|transfer/.test(value)) return "closing";
  if (/案例|示例|case|example/.test(value)) return "case";
  return "statement";
}

function compactCandidate(value: unknown) {
  const item = asRecord(value);
  return {
    layout: item.layout,
    label: item.label,
    roles: asArray(item.roles),
    copyFields: asArray(item.copyKeys),
    arrays: asArray(item.arrayMeta).map((entry) => {
      const array = asRecord(entry);
      return {
        key: array.key,
        role: array.role,
        defaultVisibleCount: array.defaultVisibleCount,
        minCount: array.min,
        maxCount: array.maxCount,
        countKey: array.countKey,
      };
    }),
    mediaFields: asArray(item.mediaSlots).map((entry) => asRecord(entry).field),
  };
}

function compactQueryResult(intent: string, role: string, value: unknown) {
  const result = asRecord(value);
  return {
    intent,
    role,
    candidates: asArray(result.layouts).map(compactCandidate),
    hint: result.hint,
  };
}

function compactInspection(value: unknown) {
  const item = asRecord(value);
  return {
    layout: item.layout,
    label: item.label,
    copyFields: asArray(item.copyKeys),
    copyBudgets: item.copyBudgets,
    fillPlan: item.fillPlan,
    arrays: asArray(item.arrayMeta).map((entry) => {
      const array = asRecord(entry);
      return {
        key: array.key,
        role: array.role,
        minCount: array.min,
        defaultVisibleCount: array.defaultVisibleCount,
        maxCount: array.maxCount,
        countKey: array.countKey,
      };
    }),
    propShapes: item.propShapes,
    mediaSlots: item.mediaSlots,
    contentLocked: item.contentLocked,
  };
}

function rawLayouts(value: unknown) {
  const root = asRecord(value);
  return Array.isArray(root.layouts) ? root.layouts : [value];
}

/**
 * One presentation run owns one Dashi planning session. The server binds the
 * confirmed theme; the Agent describes classroom intents and never has to
 * speak Dashi's internal role/query syntax.
 */
export function createPiDashiPlanningSession(
  dashi: PlanningCapability,
  options: {
    theme?: DashiThemeId;
    seed?: string;
    onLayoutsInspected?: (layouts: string[], result: unknown) => void;
    onThemeBound?: (theme: DashiThemeId) => void | Promise<void>;
  } = {},
) {
  let activeTheme = options.theme;
  let bindingTheme: DashiThemeId | undefined;
  let binding: Promise<void> | undefined;
  let contractFailures = 0;
  let terminalError: DashiPlanningError | null = null;
  const fail = (code: DashiPlanningErrorCode): never => {
    if (terminalError) throw terminalError;
    contractFailures += 1;
    const terminal = code === "presentation_theme_binding_failed" || contractFailures > 1;
    const error = new DashiPlanningError(code === "presentation_theme_binding_failed" ? code
      : terminal ? "presentation_planning_blocked" : code);
    if (terminal) terminalError = error;
    throw error;
  };
  const bindTheme = async (requested?: DashiThemeId): Promise<DashiThemeId> => {
    if (terminalError) throw terminalError;
    const fixedTheme = activeTheme ?? bindingTheme;
    if (requested && !themeIds.includes(requested)) fail("presentation_theme_invalid");
    if (fixedTheme && requested && fixedTheme !== requested) fail("presentation_theme_mismatch");
    const theme = fixedTheme ?? requested;
    if (!theme) return fail("presentation_theme_required");
    if (!activeTheme) {
      if (!binding) {
        bindingTheme = theme;
        binding = (async () => {
          try { await options.onThemeBound?.(theme); }
          catch { fail("presentation_theme_binding_failed"); }
          activeTheme = theme;
        })();
      }
      await binding;
    }
    return theme;
  };
  const layoutQueryCache = new Map<string, unknown>();
  const queryLayouts: AgentTool<any> = {
    name: "query_dashi_layouts",
    label: "查询 Dashi 版式",
    description: "按课堂意图批量查询真实候选版式。教师已确认的主题固定不变，可省略 theme；教师委托选择且尚未绑定时，在首次查询的 theme 中选择一个可用主题。首次绑定保存成功后，后续查询沿用该主题，不得漂移。每一类页面用 queries 描述课堂功能。",
    parameters: Type.Object({
      theme: Type.Optional(Type.Union(themeIds.map((theme) => Type.Literal(theme)))),
      queries: Type.Array(Type.Object({
        intent: Type.String({ minLength: 1, maxLength: 120 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input, signal, onUpdate) => {
      const parameters = input as {
        theme?: DashiThemeId;
        queries: Array<{ intent: string; limit?: number }>;
      };
      const theme = await bindTheme(parameters.theme);
      if (terminalError) throw terminalError;
      const batches = [];
      for (const [index, query] of parameters.queries.entries()) {
        onUpdate?.(progressResult(
          `正在匹配“${query.intent}”的版式`,
          index + 1,
          parameters.queries.length,
        ));
        const role = roleForIntent(query.intent);
        const limit = query.limit ?? 6;
        const cacheKey = JSON.stringify({ theme, intent: query.intent, role, limit });
        let result = layoutQueryCache.get(cacheKey);
        let cached = true;
        if (!result) {
          cached = false;
          const queryNumber = layoutQueryCache.size + 1;
          result = await dashi.queryLayouts({
            theme,
            role,
            keyword: query.intent,
            seed: options.seed ? `${options.seed}:${queryNumber}:${index}:intent` : undefined,
            limit,
            signal,
          });
          // Dashi theme metadata is usually written for business decks, so a
          // classroom keyword can legitimately return zero matches. Fall back
          // to the visual role instead of making the Agent learn that mismatch.
          if (!asArray(asRecord(result).layouts).length) {
            result = await dashi.queryLayouts({
              theme,
              role,
              seed: options.seed ? `${options.seed}:${queryNumber}:${index}:role` : undefined,
              limit,
              signal,
            });
          }
          layoutQueryCache.set(cacheKey, result);
        }
        batches.push({ ...compactQueryResult(query.intent, role, result), cached });
      }
      contractFailures = 0;
      return textResult({ theme, batches });
    },
  };

  const inspectLayouts: AgentTool<any> = {
    name: "inspect_dashi_layouts",
    label: "检查 Dashi 版式",
    description: "批量检查最终候选的可写文案、容量、数组和媒体槽；所有 authored 值都写在 slides[].props，视觉控制由版式保留默认值。",
    parameters: Type.Object({
      layouts: Type.Array(Type.String({ pattern: "^theme(?:0[1-9]|1[0-2])_page\\d{3}$" }), {
        minItems: 1,
        maxItems: 40,
      }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input, signal, onUpdate) => {
      const layouts = [...new Set((input as { layouts: string[] }).layouts)];
      const theme = await bindTheme();
      if (terminalError) throw terminalError;
      if (layouts.some((layout) => !layout.startsWith(`${theme}_`))) fail("presentation_theme_mismatch");
      const inspected: unknown[] = [];
      for (let index = 0; index < layouts.length; index += 12) {
        onUpdate?.(progressResult(
          "正在核对最终版式容量",
          Math.min(index + 12, layouts.length),
          layouts.length,
        ));
        const result = await dashi.inspectLayouts({ layouts: layouts.slice(index, index + 12), signal });
        inspected.push(...rawLayouts(result));
      }
      const rawResult = { layouts: inspected };
      options.onLayoutsInspected?.(layouts, rawResult);
      contractFailures = 0;
      return textResult({ layouts: inspected.map(compactInspection) });
    },
  };

  return {
    tools: [queryLayouts, inspectLayouts],
    getTheme: () => activeTheme,
    getTerminalError: () => terminalError,
  };
}
