import type { DashiGoal } from "./dashi-goal.js";

export type DashiThemeId = DashiGoal["themePack"];

export const dashiThemeCatalog: ReadonlyArray<{
  id: DashiThemeId;
  name: string;
  character: string;
}> = [
  { id: "theme01", name: "轻拟态风", character: "柔和、克制、通用" },
  { id: "theme02", name: "炫光紫绿风", character: "高对比、未来感" },
  { id: "theme03", name: "深浅代码风", character: "理性、技术感" },
  { id: "theme04", name: "玻璃糖果风", character: "明快、轻盈、活泼" },
  { id: "theme05", name: "色谱图表风", character: "数据、比较、分析" },
  { id: "theme06", name: "深色图谱风", character: "关系、结构、沉浸" },
  { id: "theme07", name: "冷白调研风", character: "清晰、研究、纪实" },
  { id: "theme08", name: "黑金实验风", character: "实验、质感、聚焦" },
  { id: "theme09", name: "深蓝杂志风", character: "文本、叙事、阅读" },
  { id: "theme10", name: "金色指数风", character: "典雅、历史、成果" },
  { id: "theme11", name: "高能增长风", character: "行动、节奏、冲击" },
  { id: "theme12", name: "声波霓虹风", character: "声音、艺术、舞台感" },
] as const;

const normalized = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, "");

export function parseDashiTheme(message: string): DashiThemeId | null {
  const value = normalized(message);
  // The theme picker is numbered, so a teacher naturally replies with "02"
  // or "2". Treat a standalone catalog number exactly like theme02; do not
  // interpret numbers embedded in a longer ordinary message as a choice.
  const numericChoice = value.match(/^(?:0?[1-9]|1[0-2])$/)?.[0];
  // Match complete identifiers, with two-digit alternatives first. A partial
  // match of theme10 as theme1 silently changed the teacher's explicit choice.
  const explicitIds = [...message.matchAll(/(?:^|[^a-z0-9])theme[\s_-]*(1[0-2]|0?[1-9])(?![a-z0-9])/giu)]
    .map((match) => `theme${String(Number(match[1])).padStart(2, "0")}` as DashiThemeId);
  if (new Set(explicitIds).size > 1) return null;
  if (numericChoice) return `theme${String(Number(numericChoice)).padStart(2, "0")}` as DashiThemeId;
  if (explicitIds[0]) return explicitIds[0];
  if (/theme[\s_-]*\d/iu.test(message)) return null;
  return dashiThemeCatalog.find((theme) => value.includes(normalized(theme.name)))?.id ?? null;
}

export const delegatesDashiThemeChoice = (message: string) => (
  /你来(?:决定|选择|选)|由你(?:决定|选择|选)|自动(?:选择|匹配)|智能匹配|合适(?:即可|就行)|都可以|随意|不挑/.test(message)
);

export const cancelsDashiThemeChoice = (message: string) => (
  /^(?:取消|算了|不做了|先不做|暂时不做|不要生成|cancel)[。！!\s]*$/i.test(message.trim())
);

export const dashiThemeCatalogForPrompt = () => dashiThemeCatalog
  .map((theme) => `${theme.id} ${theme.name}（${theme.character}）`)
  .join("；");
