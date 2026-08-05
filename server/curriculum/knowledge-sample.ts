import { createHash } from "node:crypto";
import { z } from "zod";
import type { CurriculumNodeRecord, CurriculumTextbookRecord } from "../domain.js";

const samplePointSchema = z.object({
  name: z.string().trim().min(1),
  detail: z.string().trim().min(1),
  anchor: z.string().trim().min(1),
  grade: z.string().trim().min(1),
  period: z.number().int().positive(),
});

const sampleModuleSchema = z.object({
  unit: z.string().trim().min(1),
  module: z.string().trim().min(1),
  no: z.string(),
  title: z.string().trim().min(1),
  author: z.string(),
  pages: z.string().trim().min(1),
  points: z.array(samplePointSchema).min(1),
});

const knowledgePointSchema = z.object({
  "序号": z.number().int().positive(),
  "知识点ID": z.string().trim().min(1),
  "单元": z.string().trim().min(1),
  "板块": z.string().trim().min(1),
  "课号": z.string(),
  "课文/活动": z.string().trim().min(1),
  "作者/出处": z.string(),
  "教材页码": z.string().trim().min(1),
  "标准知识点名称": z.string().trim().min(1),
  "具体掌握内容": z.string().trim().min(1),
  "学生动作": z.string(),
  "达标判据": z.string(),
  "教材证据定位": z.string().trim().min(1),
  "证据等级": z.string().trim().min(1),
  "建议课时": z.number().int().positive(),
  "官方课时": z.string(),
  "核验状态": z.string(),
  "教材入口": z.string().url(),
  "备注": z.string(),
});

const periodMappingSchema = z.object({
  "序号": z.number().int().positive(),
  "单元": z.string().trim().min(1),
  "板块": z.string().trim().min(1),
  "课号": z.string(),
  "课文/活动": z.string().trim().min(1),
  "课时": z.string().trim().min(1),
  "本课时知识点": z.string(),
  "知识点ID": z.string().trim().min(1),
  "具体掌握内容": z.string(),
  "映射类型": z.string().trim().min(1),
  "官方课时": z.string(),
  "说明": z.string(),
});

export const curriculumKnowledgeSampleSchema = z.object({
  dataset_name: z.string().trim().min(1),
  book: z.object({
    title: z.string().trim().min(1),
    publisher: z.string().trim().min(1),
    revision_year: z.number().int(),
    official_ebook_entry: z.string().url(),
    revision_note: z.string().url(),
    moe_catalog: z.string().url(),
    curriculum_standard: z.string().url(),
  }),
  modules: z.array(sampleModuleSchema).min(1),
  knowledge_points: z.array(knowledgePointSchema).min(1),
  period_mapping: z.array(periodMappingSchema),
  generated_at: z.string().min(1),
});

export type CurriculumKnowledgeSample = z.infer<typeof curriculumKnowledgeSampleSchema>;

const normalizeUnit = (value: string) => value
  .normalize("NFKC")
  .replace(/[\s·:：，,。.!！?？、()（）《》〈〉\-—_]/g, "")
  .replace(/活动探究$/, "");

const normalizeBookTitle = (value: string) => value
  .normalize("NFKC")
  .replace(/^\([^)]*\)/, "")
  .replace(/[\s·:：，,。.!！?？、()（）《》〈〉\-—_]/g, "");

export const normalizeCurriculumModuleTitle = (value: string) => value
  .normalize("NFKC")
  .trim()
  .replace(/^\d+\s*[*＊]?\s*/, "")
  .replace(/^任务[一二三四五六七八九十]+\s*[:：]?\s*/, "")
  .replace(/[\s·:：，,。.!！?？、()（）《》〈〉\-—_]/g, "")
  .replace(/[一二]$/, "");

function nodePath(node: CurriculumNodeRecord, nodesById: Map<string, CurriculumNodeRecord>) {
  const path: CurriculumNodeRecord[] = [];
  const visited = new Set<string>();
  let cursor: CurriculumNodeRecord | undefined = node;
  while (cursor && !visited.has(cursor.nodeId)) {
    path.unshift(cursor);
    visited.add(cursor.nodeId);
    cursor = cursor.parentId ? nodesById.get(cursor.parentId) : undefined;
  }
  return path;
}

export type MatchedCurriculumModule = {
  moduleIndex: number;
  module: CurriculumKnowledgeSample["modules"][number];
  node: CurriculumNodeRecord;
  path: CurriculumNodeRecord[];
};

export function matchKnowledgeSampleModules(
  sample: CurriculumKnowledgeSample,
  nodes: CurriculumNodeRecord[],
): MatchedCurriculumModule[] {
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  return sample.modules.map((module, moduleIndex) => {
    const unitKey = normalizeUnit(module.unit);
    const titleKey = normalizeCurriculumModuleTitle(module.title);
    const candidates = nodes.filter((node) => {
      const path = nodePath(node, nodesById);
      const root = path[0];
      if (!root || normalizeUnit(root.title) !== unitKey) return false;
      return normalizeCurriculumModuleTitle(node.title) === titleKey;
    });
    if (candidates.length !== 1) {
      throw new Error(`curriculum_module_match_${candidates.length ? "ambiguous" : "missing"}:${module.unit}:${module.title}`);
    }
    const node = candidates[0]!;
    return { moduleIndex, module, node, path: nodePath(node, nodesById) };
  });
}

export const splitKnowledgePointIds = (value: string) => value
  .split(/[、,，;；\s]+/)
  .map((item) => item.trim())
  .filter(Boolean);

export type KnowledgeSampleValidation = {
  sample: CurriculumKnowledgeSample;
  matchedModules: MatchedCurriculumModule[];
  pointCount: number;
  periodCount: number;
  genericFields: { studentAction: boolean; achievementCriterion: boolean };
};

export function validateCurriculumKnowledgeSample(args: {
  value: unknown;
  textbook: CurriculumTextbookRecord;
  nodes: CurriculumNodeRecord[];
}): KnowledgeSampleValidation {
  const sample = curriculumKnowledgeSampleSchema.parse(args.value);
  if (args.textbook.subject !== "语文") throw new Error("curriculum_sample_subject_mismatch");
  if (normalizeBookTitle(sample.book.title) !== normalizeBookTitle(args.textbook.title)) {
    throw new Error("curriculum_sample_textbook_mismatch");
  }
  const pointIds = new Set<string>();
  const pointById = new Map<string, CurriculumKnowledgeSample["knowledge_points"][number]>();
  for (const point of sample.knowledge_points) {
    if (pointIds.has(point["知识点ID"])) throw new Error(`curriculum_knowledge_point_duplicate:${point["知识点ID"]}`);
    pointIds.add(point["知识点ID"]);
    pointById.set(point["知识点ID"], point);
  }
  const matchedModules = matchKnowledgeSampleModules(sample, args.nodes);
  if (new Set(matchedModules.map((item) => item.node.nodeId)).size !== matchedModules.length) {
    throw new Error("curriculum_module_target_duplicate");
  }

  const modulePointKeys = new Set(sample.modules.flatMap((module) => (
    module.points.map((point) => [
      module.unit, module.module, module.no, module.title,
      point.name, point.detail, point.anchor, point.grade, String(point.period),
    ].join("\u0000"))
  )));
  const masterPointKeys = new Set(sample.knowledge_points.map((point) => [
    point["单元"], point["板块"], point["课号"], point["课文/活动"],
    point["标准知识点名称"], point["具体掌握内容"], point["教材证据定位"],
    point["证据等级"], String(point["建议课时"]),
  ].join("\u0000")));
  if (modulePointKeys.size !== masterPointKeys.size
    || [...modulePointKeys].some((key) => !masterPointKeys.has(key))) {
    throw new Error("curriculum_module_points_inconsistent");
  }

  for (const period of sample.period_mapping) {
    const ids = splitKnowledgePointIds(period["知识点ID"]);
    if (!ids.length || ids.some((id) => !pointById.has(id))) {
      throw new Error(`curriculum_period_point_reference_invalid:${period["序号"]}`);
    }
  }

  const studentActions = new Set(sample.knowledge_points.map((point) => point["学生动作"].trim()));
  const achievementCriteria = new Set(sample.knowledge_points.map((point) => point["达标判据"].trim()));
  return {
    sample,
    matchedModules,
    pointCount: sample.knowledge_points.length,
    periodCount: sample.period_mapping.length,
    genericFields: {
      studentAction: studentActions.size === 1,
      achievementCriterion: achievementCriteria.size === 1,
    },
  };
}

export function deterministicUuid(namespace: string, value: string) {
  const bytes = Buffer.from(createHash("sha256").update(`${namespace}\u0000${value}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
