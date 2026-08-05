import { describe, expect, it } from "vitest";
import type { CurriculumNodeRecord, CurriculumTextbookRecord } from "../domain.js";
import {
  deterministicUuid,
  splitKnowledgePointIds,
  validateCurriculumKnowledgeSample,
} from "./knowledge-sample.js";

const textbook: CurriculumTextbookRecord = {
  id: "book-cn-7a",
  title: "义务教育教科书·语文七年级上册",
  stage: "初中",
  subject: "语文",
  edition: "统编版",
  grade: "七年级",
  volume: "上册",
  publisherId: "pep",
  ebookId: null,
  detailUrl: null,
  treeUrl: null,
  sourcePdfUrl: "https://example.com/book.pdf",
  sourceListUrl: null,
  nodeCount: 3,
  sourceUpdatedAt: null,
};

const nodes: CurriculumNodeRecord[] = [
  {
    textbookId: textbook.id, nodeId: "unit-1", parentId: null,
    level: 1, sortNo: 1, title: "第一单元", pageNumber: 8,
  },
  {
    textbookId: textbook.id, nodeId: "reading", parentId: "unit-1",
    level: 2, sortNo: 1, title: "阅读", pageNumber: 9,
  },
  {
    textbookId: textbook.id, nodeId: "spring", parentId: "reading",
    level: 3, sortNo: 1, title: "1 春", pageNumber: 9,
  },
];

const sample = {
  dataset_name: "测试样本",
  book: {
    title: textbook.title,
    publisher: "人民教育出版社",
    revision_year: 2024,
    official_ebook_entry: "https://example.com/ebook",
    revision_note: "https://example.com/revision",
    moe_catalog: "https://example.com/catalog.pdf",
    curriculum_standard: "https://example.com/standard.pdf",
  },
  modules: [{
    unit: "第一单元", module: "阅读", no: "1", title: "春", author: "朱自清", pages: "2—5",
    points: [{
      name: "春日图景", detail: "概括主要画面。", anchor: "思考一", grade: "A1", period: 1,
    }],
  }],
  knowledge_points: [{
    "序号": 1,
    "知识点ID": "CN7A-KP-0001",
    "单元": "第一单元",
    "板块": "阅读",
    "课号": "1",
    "课文/活动": "春",
    "作者/出处": "朱自清",
    "教材页码": "2—5",
    "标准知识点名称": "春日图景",
    "具体掌握内容": "概括主要画面。",
    "学生动作": "通用占位",
    "达标判据": "通用占位",
    "教材证据定位": "思考一",
    "证据等级": "A1",
    "建议课时": 1,
    "官方课时": "否",
    "核验状态": "已核验",
    "教材入口": "https://example.com/ebook",
    "备注": "",
  }],
  period_mapping: [{
    "序号": 1,
    "单元": "第一单元",
    "板块": "阅读",
    "课号": "1",
    "课文/活动": "春",
    "课时": "第1课时",
    "本课时知识点": "春日图景",
    "知识点ID": "CN7A-KP-0001",
    "具体掌握内容": "概括主要画面。",
    "映射类型": "教研建议映射",
    "官方课时": "否",
    "说明": "根据学情调整。",
  }],
  generated_at: "2026-08-01T00:00:00Z",
};

describe("curriculum knowledge sample", () => {
  it("validates exact catalog matching without page-offset assumptions", () => {
    const result = validateCurriculumKnowledgeSample({ value: sample, textbook, nodes });
    expect(result.matchedModules[0]?.node.nodeId).toBe("spring");
    expect(result.pointCount).toBe(1);
    expect(result.genericFields).toEqual({
      studentAction: true,
      achievementCriterion: true,
    });
  });

  it("splits grouped period references and creates stable ids", () => {
    expect(splitKnowledgePointIds("KP-1、KP-2，KP-3")).toEqual(["KP-1", "KP-2", "KP-3"]);
    expect(deterministicUuid("book", "KP-1")).toBe(deterministicUuid("book", "KP-1"));
    expect(deterministicUuid("book", "KP-1")).not.toBe(deterministicUuid("book", "KP-2"));
  });

  it("rejects a knowledge point that cannot be bound to the matched module", () => {
    const invalid = structuredClone(sample);
    invalid.knowledge_points[0]!["课文/活动"] = "不存在的课文";
    expect(() => validateCurriculumKnowledgeSample({ value: invalid, textbook, nodes }))
      .toThrow("curriculum_module_points_inconsistent");
  });
});
