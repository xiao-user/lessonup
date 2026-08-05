import type {
  CurriculumKnowledgeContinuityRecord,
  CurriculumKnowledgeSearchResult,
  CurriculumNodeRecord,
  CurriculumNodeKnowledgeRecord,
  CurriculumNodeSemanticsRecord,
  CurriculumSemanticEntityRecord,
  CurriculumSemanticPathStep,
  CurriculumTextbookRecord,
} from "../domain.js";

export const curriculumFixtureTextbooks: CurriculumTextbookRecord[] = [
  {
    id: "textbook-it-3d",
    title: "普通高中教科书·信息技术选择性必修5 三维设计与创意",
    stage: "高中",
    subject: "信息技术",
    edition: "教科版",
    grade: "高中年级",
    volume: "选择性必修5 三维设计与创意",
    publisherId: "example-publisher",
    ebookId: "ebook-it-3d",
    detailUrl: "https://basic.smartedu.cn/tchMaterial/detail?contentType=assets_document&contentId=textbook-it-3d",
    treeUrl: "https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/textbook-it-3d/tree.json",
    sourcePdfUrl: null,
    sourceListUrl: null,
    nodeCount: 5,
    sourceUpdatedAt: "2026-01-22T02:04:05.569+08:00",
  },
  {
    id: "textbook-math-bnu",
    title: "普通高中教科书·数学必修 第二册",
    stage: "高中",
    subject: "数学",
    edition: "北师大版",
    grade: "高中年级",
    volume: "必修 第二册",
    publisherId: "example-publisher",
    ebookId: "ebook-math-bnu",
    detailUrl: "https://basic.smartedu.cn/tchMaterial/detail?contentType=assets_document&contentId=textbook-math-bnu",
    treeUrl: "https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/textbook-math-bnu/tree.json",
    sourcePdfUrl: null,
    sourceListUrl: null,
    nodeCount: 4,
    sourceUpdatedAt: "2026-01-22T02:04:05.569+08:00",
  },
];

export const curriculumFixtureNodes: CurriculumNodeRecord[] = [
  {
    textbookId: "textbook-it-3d",
    nodeId: "u1",
    parentId: null,
    level: 1,
    sortNo: 1,
    title: "第1单元 三维设计概述",
    pageNumber: 8,
  },
  {
    textbookId: "textbook-it-3d",
    nodeId: "u1-1",
    parentId: "u1",
    level: 2,
    sortNo: 1,
    title: "1.1 认识三维设计",
    pageNumber: 9,
  },
  {
    textbookId: "textbook-it-3d",
    nodeId: "u2",
    parentId: null,
    level: 1,
    sortNo: 2,
    title: "第2单元 三维设计过程",
    pageNumber: 27,
  },
  {
    textbookId: "textbook-math-bnu",
    nodeId: "ch1",
    parentId: null,
    level: 1,
    sortNo: 1,
    title: "第一章 三角函数",
    pageNumber: 2,
  },
  {
    textbookId: "textbook-math-bnu",
    nodeId: "ch1-1",
    parentId: "ch1",
    level: 2,
    sortNo: 1,
    title: "1 周期变化",
    pageNumber: 3,
  },
  {
    textbookId: "textbook-math-bnu",
    nodeId: "ch1-1-1",
    parentId: "ch1-1",
    level: 3,
    sortNo: 1,
    title: "习题1-1",
    pageNumber: 8,
  },
  {
    textbookId: "textbook-math-bnu",
    nodeId: "ch2",
    parentId: null,
    level: 1,
    sortNo: 2,
    title: "第二章 平面向量及其应用",
    pageNumber: 40,
  },
];

const periodicChangeSource = {
  id: "curriculum-semantic-source:periodic-change",
  title: "测试课程依据：周期变化",
  url: "https://example.com/curriculum/periodic-change",
  kind: "public" as const,
  authority: "LessonUp 测试数据",
  locator: "测试章节 1",
};

const trigonometricFunctionSource = {
  id: "curriculum-semantic-source:trigonometric-function",
  title: "测试课程依据：三角函数",
  url: "https://example.com/curriculum/trigonometric-function",
  kind: "public" as const,
  authority: "LessonUp 测试数据",
  locator: "测试章节 2",
};

export const curriculumFixtureSemanticEntities: CurriculumSemanticEntityRecord[] = [
  {
    id: "00000000-0000-4000-8000-000000000401",
    externalId: "TEST-KP-001",
    kind: "knowledge_point",
    canonicalName: "周期变化",
    definition: "识别现象随时间重复出现的变化规律。",
    payload: {},
    confidence: 1,
    sources: [periodicChangeSource],
  },
  {
    id: "00000000-0000-4000-8000-000000000402",
    externalId: "TEST-KP-002",
    kind: "knowledge_point",
    canonicalName: "三角函数",
    definition: "使用三角函数描述具有周期性的数量关系。",
    payload: {},
    confidence: 1,
    sources: [trigonometricFunctionSource],
  },
];

const semanticRelease = {
  id: "00000000-0000-4000-8000-000000000101",
  scopeKey: "test:高中:数学:北师大版:必修第二册",
  catalogGenerationId: "test-generation",
  subject: "数学",
  stage: "高中",
  edition: "北师大版",
  grade: "高中年级",
  volume: "必修 第二册",
  schemaVersion: 1,
  publishedAt: "2026-08-01T00:00:00.000Z",
};

export const curriculumFixtureNodeSemantics: Array<
  CurriculumNodeSemanticsRecord & { textbookId: string; nodeId: string }
> = [
  {
    textbookId: "textbook-math-bnu",
    nodeId: "ch1-1",
    release: semanticRelease,
    mappings: [{
      id: "00000000-0000-4000-8000-000000000201",
      instructionalRole: "introduces",
      expectedDepth: 1,
      priority: 1,
      confidence: 1,
      rationale: "为后续使用函数刻画周期现象建立直观基础。",
      entity: curriculumFixtureSemanticEntities[0]!,
      sources: [periodicChangeSource],
    }],
  },
  {
    textbookId: "textbook-math-bnu",
    nodeId: "ch1",
    release: semanticRelease,
    mappings: [{
      id: "00000000-0000-4000-8000-000000000202",
      instructionalRole: "develops",
      expectedDepth: 2,
      priority: 1,
      confidence: 1,
      rationale: "从周期变化的直观认识发展到三角函数表达。",
      entity: curriculumFixtureSemanticEntities[1]!,
      sources: [trigonometricFunctionSource],
    }],
  },
];

export const curriculumFixtureSemanticPaths: CurriculumSemanticPathStep[] = [{
  relationId: "00000000-0000-4000-8000-000000000301",
  relationType: "prerequisite",
  depth: 1,
  strength: 1,
  confidence: 1,
  rationale: "先识别周期变化，再学习用三角函数表达这种变化。",
  fromEntity: curriculumFixtureSemanticEntities[0]!,
  toEntity: curriculumFixtureSemanticEntities[1]!,
  reachedEntity: curriculumFixtureSemanticEntities[1]!,
  locations: [{
    textbook: curriculumFixtureTextbooks[1]!,
    node: curriculumFixtureNodes.find((node) => node.nodeId === "ch1")!,
    instructionalRole: "develops",
    expectedDepth: 2,
  }],
  sources: [periodicChangeSource, trigonometricFunctionSource],
}];

export const curriculumFixtureNodeKnowledge: Array<
  CurriculumNodeKnowledgeRecord & { textbookId: string; nodeId: string }
> = [
  {
    textbookId: "textbook-math-bnu",
    nodeId: "ch1-1",
    release: semanticRelease,
    points: [{
      mappingId: "00000000-0000-4000-8000-000000000501",
      sequenceNo: 1,
      printedPages: "3—7",
      recommendedPeriod: 1,
      mappingPayload: {},
      point: curriculumFixtureSemanticEntities[0]!,
    }],
    periodRecommendations: [{
      id: "00000000-0000-4000-8000-000000000601",
      periodNo: 1,
      title: "第1课时",
      mappingType: "测试建议",
      isOfficial: false,
      note: "根据学情调整。",
      pointIds: [curriculumFixtureSemanticEntities[0]!.id],
    }],
  },
  {
    textbookId: "textbook-math-bnu",
    nodeId: "ch1",
    release: semanticRelease,
    points: [{
      mappingId: "00000000-0000-4000-8000-000000000502",
      sequenceNo: 2,
      printedPages: "2—39",
      recommendedPeriod: 2,
      mappingPayload: {},
      point: curriculumFixtureSemanticEntities[1]!,
    }],
    periodRecommendations: [],
  },
];

export const curriculumFixtureKnowledgeSearch: CurriculumKnowledgeSearchResult[] = [
  {
    point: curriculumFixtureSemanticEntities[0]!,
    score: 1,
    retrievalMethod: "lexical",
    occurrences: [{
      mappingId: "00000000-0000-4000-8000-000000000501",
      nodeId: "ch1-1",
      nodeTitle: "1 周期变化",
      pageNumber: 3,
      sequenceNo: 1,
      printedPages: "3—7",
      recommendedPeriod: 1,
    }],
  },
  {
    point: curriculumFixtureSemanticEntities[1]!,
    score: 0.5,
    retrievalMethod: "lexical",
    occurrences: [{
      mappingId: "00000000-0000-4000-8000-000000000502",
      nodeId: "ch1",
      nodeTitle: "第一章 三角函数",
      pageNumber: 2,
      sequenceNo: 2,
      printedPages: "2—39",
      recommendedPeriod: 2,
    }],
  },
];

export const curriculumFixtureKnowledgeContinuity: CurriculumKnowledgeContinuityRecord = {
  status: "available",
  currentSequenceNo: 2,
  target: curriculumFixtureSemanticEntities[1]!,
  candidates: [{
    ...curriculumFixtureKnowledgeSearch[0]!,
    score: 0.72,
    occurrences: curriculumFixtureKnowledgeSearch[0]!.occurrences.map((occurrence) => ({
      ...occurrence,
      position: "before" as const,
    })),
  }],
};
