import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { NativeDashiPptSkill } from "../../presentations/native-dashi-skill.js";
import type { DashiThemeId } from "../../presentations/dashi-theme-catalog.js";

const themeIds = [
  "theme01", "theme02", "theme03", "theme04", "theme05", "theme06",
  "theme07", "theme08", "theme09", "theme10", "theme11", "theme12",
] as const;

const themeType = Type.Union(themeIds.map((theme) => Type.Literal(theme)));
type PlanningCapability = Pick<NativeDashiPptSkill, "queryLayouts" | "inspectLayouts">;

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
  } = {},
) {
  let activeTheme = options.theme;
  const layoutQueryCache = new Map<string, unknown>();
  const queryShape = {
    ...(options.theme ? {} : { theme: themeType }),
    queries: Type.Array(Type.Object({
      intent: Type.String({ minLength: 1, maxLength: 120 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
  };

  const queryLayouts: AgentTool<any> = {
    name: "query_dashi_layouts",
    label: "查询 Dashi 版式",
    description: options.theme
      ? `已绑定 ${options.theme}。按课堂意图批量查询真实候选版式；只需描述每一类页面要承担的课堂功能。`
      : "先选择一个主题，再按课堂意图批量查询真实候选版式。",
    parameters: Type.Object(queryShape, { additionalProperties: false }),
    execute: async (_toolCallId, input, signal, onUpdate) => {
      const parameters = input as {
        theme?: DashiThemeId;
        queries: Array<{ intent: string; limit?: number }>;
      };
      const requestedTheme = options.theme ?? parameters.theme;
      if (!requestedTheme || !themeIds.includes(requestedTheme)) throw new Error("presentation_theme_required");
      if (activeTheme && activeTheme !== requestedTheme) throw new Error("presentation_theme_mismatch");
      activeTheme = requestedTheme;
      const batches = [];
      for (const [index, query] of parameters.queries.entries()) {
        onUpdate?.(progressResult(
          `正在匹配“${query.intent}”的版式`,
          index + 1,
          parameters.queries.length,
        ));
        const role = roleForIntent(query.intent);
        const limit = query.limit ?? 6;
        const cacheKey = JSON.stringify({ theme: activeTheme, intent: query.intent, role, limit });
        let result = layoutQueryCache.get(cacheKey);
        let cached = true;
        if (!result) {
          cached = false;
          const queryNumber = layoutQueryCache.size + 1;
          result = await dashi.queryLayouts({
            theme: activeTheme,
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
              theme: activeTheme,
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
      return textResult({ theme: activeTheme, batches });
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
      return textResult({ layouts: inspected.map(compactInspection) });
    },
  };

  return {
    tools: [queryLayouts, inspectLayouts],
    getTheme: () => activeTheme,
  };
}
