import { z } from "zod";

import type {
  LessonFileRecord,
  NotebookRecord,
  SemesterFrameworkAggregate,
} from "../domain.js";
import { requestPiText } from "../agent-runtime/pi/text.js";

const responseSchema = z.object({
  suggestions: z.array(z.string().trim().min(2).max(80)).min(1).max(3),
});

export function parseThreadStarters(content: string) {
  const normalized = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const objectStart = normalized.indexOf("{");
  const objectEnd = normalized.lastIndexOf("}");
  const candidate = objectStart >= 0 && objectEnd >= objectStart
    ? normalized.slice(objectStart, objectEnd + 1)
    : normalized;
  const parsed = responseSchema.parse(JSON.parse(candidate));
  return [...new Set(parsed.suggestions.map((suggestion) => suggestion.trim()))].slice(0, 3);
}

type ThreadStarterResource =
  | { notebook: NotebookRecord; file: LessonFileRecord; framework?: never }
  | { notebook: NotebookRecord; framework: SemesterFrameworkAggregate; file?: never };

function isFrameworkStarterResource(
  args: ThreadStarterResource,
): args is Extract<ThreadStarterResource, { framework: SemesterFrameworkAggregate }> {
  return args.framework !== undefined;
}

const excerpt = (value: unknown, limit = 500) => String(value ?? "").trim().slice(0, limit);

export async function generateThreadStarters(args: ThreadStarterResource) {
  const isFramework = isFrameworkStarterResource(args);
  const request = (repair?: string) => requestPiText({
    instructions: [
      "你为教师的新备课会话生成 3 个可直接发送的问题。",
      isFramework
        ? "问题必须来自当前真实学期框架，优先覆盖学期容量、单元目标、课时蓝图或教学连续性中最值得推进的不同方向。"
        : "问题必须来自当前真实教案内容，覆盖最值得继续完善的不同方向。",
      "每项 6 至 24 个汉字，不使用占位词，不声称已经读取外部资料。",
      "只输出 JSON：{\"suggestions\":[\"…\",\"…\",\"…\"]}。",
    ].join("\n"),
    input: repair
      ? `将下面内容修复为规定的 JSON，不新增解释：\n${repair.slice(0, 1_000)}`
      : JSON.stringify(isFrameworkStarterResource(args) ? {
          notebook: {
            title: args.notebook.title,
            subject: args.notebook.subject,
            year: args.notebook.year,
            className: args.notebook.className,
          },
          semesterFramework: {
            title: args.framework.framework.title,
            term: args.framework.framework.term,
            totalWeeks: args.framework.framework.totalWeeks,
            weeklyPeriods: args.framework.framework.weeklyPeriods,
            lessonDurationMinutes: args.framework.framework.lessonDurationMinutes,
            capacityRatio: args.framework.framework.capacityRatio,
            planningHorizonWeeks: args.framework.framework.planningHorizonWeeks,
            unitCount: args.framework.units.length,
            blueprintCount: args.framework.blueprints.length,
            units: args.framework.units.slice(0, 8).map((unit) => ({
              sortNo: unit.sortNo,
              plannedStartWeek: unit.plannedStartWeek,
              plannedEndWeek: unit.plannedEndWeek,
              plannedPeriods: unit.plannedPeriods,
              learningGoals: excerpt(unit.learningGoals),
              status: unit.status,
            })),
            blueprints: args.framework.blueprints.slice(0, 8).map((blueprint) => ({
              title: blueprint.title,
              plannedPeriod: blueprint.plannedPeriod,
              mainActivity: excerpt(blueprint.mainActivity, 240),
              observableProduct: excerpt(blueprint.observableProduct, 240),
              assessmentEvidence: excerpt(blueprint.assessmentEvidence, 240),
              plannedMinutes: blueprint.plannedMinutes,
              status: blueprint.status,
            })),
          },
        } : {
          notebook: {
            title: args.notebook.title,
            subject: args.notebook.subject,
            year: args.notebook.year,
            className: args.notebook.className,
          },
          lessonFile: {
            title: args.file.title,
            documentVersion: args.file.documentVersion,
            outline: Object.fromEntries(Object.entries(args.file.document).map(([field, value]) => [
              field,
              { empty: !String(value).trim(), characters: String(value).length },
            ])),
            excerpts: {
              objectives: excerpt(args.file.document.objectives),
              focus: excerpt(args.file.document.focus),
              process: excerpt(args.file.document.process),
              assessment: excerpt(args.file.document.assessment),
              reflection: excerpt(args.file.document.reflection),
            },
          },
        }),
    signal: AbortSignal.timeout(8_000),
  });
  const content = await request();
  try {
    return parseThreadStarters(content);
  } catch {
    const repaired = await request(content);
    return parseThreadStarters(repaired);
  }
}
