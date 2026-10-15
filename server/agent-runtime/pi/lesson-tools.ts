import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { LessonField } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import { lessonFieldLabels } from "../../agent/tool-presentation.js";
import { tryEmbedQuery, type QueryEmbedder } from "../../providers/query-embedding.js";

const lessonFields: LessonField[] = [
  "unit",
  "period",
  "totalPeriods",
  "topic",
  "objectives",
  "knowledgePoints",
  "continuity",
  "focus",
  "preparation",
  "process",
  "assessment",
  "homework",
  "board",
  "reflection",
];

const lessonFieldType = Type.Union(lessonFields.map((field) => Type.Literal(field)));
const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: null,
});

export type PiLessonToolScope = {
  ownerId: string;
  notebookId: string;
  lessonFileId: string;
  runId: string;
  allowedKnowledgeScopes: string[];
  attachmentSourceIds?: string[];
};

/** Read-only MVP tools. Every resource identifier is server-bound in a closure. */
function createPiLessonTools(
  repository: LessonRepository,
  scope: PiLessonToolScope,
  options: { requireCompleteDocument?: boolean; embedQuery?: QueryEmbedder } = {},
): AgentTool<any>[] {
  const readDocument: AgentTool<any> = {
    name: "read_document",
    label: "读取当前教案",
    description: "一次读取当前教案的全部栏目或指定栏目。只能读取服务端绑定的当前教案。",
    parameters: Type.Object({
      fields: Type.Optional(Type.Array(lessonFieldType, { minItems: 1, maxItems: 14 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const parameters = input as { fields?: LessonField[] };
      const [file, notebook] = await Promise.all([
        repository.getLessonFile(scope.ownerId, scope.lessonFileId),
        repository.getNotebook(scope.ownerId, scope.notebookId),
      ]);
      if (!file || !notebook || file.notebookId !== scope.notebookId) throw new Error("pi_lesson_scope_invalid");
      const fields = options.requireCompleteDocument
        ? lessonFields
        : parameters.fields
        ? [...new Set(parameters.fields)]
        : lessonFields;
      return textResult({
        sections: Object.fromEntries(fields.map((field) => [
          lessonFieldLabels[field],
          file.document[field],
        ])),
        metadata: {
          title: file.title,
          subject: notebook.subject,
          className: notebook.className,
          year: notebook.year,
          contextProfile: file.contextProfile,
        },
        documentVersion: file.documentVersion,
      });
    },
  };

  const readSection: AgentTool<any> = {
    name: "read_section",
    label: "读取教案栏目",
    description: "读取当前教案的一个指定栏目。",
    parameters: Type.Object({ field: lessonFieldType }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const { field } = input as { field: LessonField };
      const file = await repository.getLessonFile(scope.ownerId, scope.lessonFileId);
      if (!file || file.notebookId !== scope.notebookId) throw new Error("pi_lesson_scope_invalid");
      return textResult({
        field,
        label: lessonFieldLabels[field],
        content: file.document[field],
        documentVersion: file.documentVersion,
      });
    },
  };

  const readOutline: AgentTool<any> = {
    name: "read_document_outline",
    label: "检查教案结构",
    description: "读取当前教案各栏目的标题、字符数和是否为空，不返回正文。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const file = await repository.getLessonFile(scope.ownerId, scope.lessonFileId);
      if (!file || file.notebookId !== scope.notebookId) throw new Error("pi_lesson_scope_invalid");
      return textResult({
        sections: lessonFields.map((field) => ({
          field,
          label: lessonFieldLabels[field],
          characters: file.document[field].length,
          empty: file.document[field].trim().length === 0,
        })),
        documentVersion: file.documentVersion,
      });
    },
  };

  const searchKnowledge: AgentTool<any> = {
    name: "search_knowledge",
    label: "检索当前项目资料",
    description: "在服务端绑定的公共、账号、备课本和当前教案资料范围内检索。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 6 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input, signal) => {
      const parameters = input as { query: string; limit?: number };
      const { vector } = await tryEmbedQuery(options.embedQuery, parameters.query, signal);
      const results = await repository.searchKnowledge(
        scope.ownerId,
        scope.allowedKnowledgeScopes,
        parameters.query,
        parameters.limit ?? 6,
        vector,
      );
      await repository.recordRunEvidence(scope.ownerId, scope.runId, "knowledge_search", results);
      return textResult(results);
    },
  };

  const readAttachedSource: AgentTool<any> = {
    name: "read_attached_source",
    label: "读取本轮附件",
    description: "读取本轮用户消息已经绑定的附件正文片段。",
    parameters: Type.Object({
      sourceId: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, default: 8 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const parameters = input as { sourceId: string; limit?: number };
      if (!(scope.attachmentSourceIds ?? []).includes(parameters.sourceId)) {
        throw new Error("attachment_not_bound_to_run");
      }
      const results = await repository.getKnowledgeSourcePassages(
        scope.ownerId,
        scope.allowedKnowledgeScopes,
        parameters.sourceId,
        parameters.limit ?? 8,
      );
      await repository.recordRunEvidence(scope.ownerId, scope.runId, "attachment_read", results);
      return textResult(results);
    },
  };

  const getPassage: AgentTool<any> = {
    name: "get_passage",
    label: "读取资料片段",
    description: "按检索结果中的 chunkId 读取当前授权资料片段。",
    parameters: Type.Object({ chunkId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const { chunkId } = input as { chunkId: string };
      const result = await repository.getKnowledgePassage(
        scope.ownerId,
        scope.allowedKnowledgeScopes,
        chunkId,
      );
      if (!result) throw new Error("knowledge_passage_not_found");
      await repository.recordRunEvidence(scope.ownerId, scope.runId, "knowledge_passage", [result]);
      return textResult(result);
    },
  };

  const listSources: AgentTool<any> = {
    name: "list_project_sources",
    label: "读取项目资料",
    description: "列出当前账号、备课本与教案授权范围内的资料来源。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => textResult(await repository.listProjectSources(
      scope.ownerId,
      scope.allowedKnowledgeScopes,
    )),
  };

  const getSource: AgentTool<any> = {
    name: "get_source",
    label: "核对资料来源",
    description: "核对当前授权范围内一个来源的元数据和可用片段，不扩大资源范围。",
    parameters: Type.Object({ sourceId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const { sourceId } = input as { sourceId: string };
      const passages = await repository.getKnowledgeSourcePassages(
        scope.ownerId,
        scope.allowedKnowledgeScopes,
        sourceId,
        1,
      );
      const source = passages[0];
      if (!source) throw new Error("knowledge_source_not_found");
      await repository.recordRunEvidence(scope.ownerId, scope.runId, "source_metadata", [source]);
      return textResult({
        id: source.id,
        title: source.title,
        kind: source.kind,
        url: source.url,
        page: source.page,
      });
    },
  };

  return [
    readDocument,
    readSection,
    readOutline,
    searchKnowledge,
    readAttachedSource,
    getPassage,
    getSource,
    listSources,
  ];
}

export function createPiLessonReadTools(
  repository: LessonRepository,
  scope: PiLessonToolScope,
  options: { requireCompleteDocument?: boolean } = {},
): AgentTool<any>[] {
  return createPiLessonTools(repository, scope, options).filter((tool) => [
    "read_document",
    "read_section",
    "read_document_outline",
  ].includes(tool.name));
}

export function createPiLessonKnowledgeTools(
  repository: LessonRepository,
  scope: PiLessonToolScope,
  embedQuery?: QueryEmbedder,
): AgentTool<any>[] {
  const tools = createPiLessonTools(repository, scope, { embedQuery });
  return tools.filter((tool) => [
    "search_knowledge",
    "read_attached_source",
    "get_passage",
    "get_source",
    "list_project_sources",
  ].includes(tool.name));
}
