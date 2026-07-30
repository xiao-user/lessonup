import { tool } from "@openai/agents";
import { z } from "zod";
import { documentPatchSchema, documentPatchToolSchema, lessonFieldSchema, type LessonAgentContext } from "../domain.js";
import type { LessonRepository } from "../repository.js";

const requireContext = (context?: { context: unknown }) => {
  if (!context?.context) throw new Error("agent_context_missing");
  return context.context as LessonAgentContext;
};

export function createDocumentTools(repository: LessonRepository, allowWrite: boolean) {
  const readDocumentMetadata = tool({
    name: "read_document_metadata",
    description: "读取当前教案的标题、备课本、科目、班级和版本；不能读取其他项目。",
    parameters: z.object({}),
    execute: async (_input, runContext) => {
      const context = requireContext(runContext);
      const [notebook, file] = await Promise.all([
        repository.getNotebook(context.userId, context.notebookId),
        repository.getLessonFile(context.userId, context.lessonFileId),
      ]);
      if (!notebook || !file || file.notebookId !== notebook.id) throw new Error("lesson_scope_invalid");
      return JSON.stringify({
        title: file.title, type: file.type, subject: notebook.subject,
        className: notebook.className, year: notebook.year,
        documentVersion: file.documentVersion,
      });
    },
  });

  const readSection = tool({
    name: "read_section",
    description: "只读取当前教案的一个明确栏目。需要比较多个栏目或审查整份教案时改用 read_document，禁止机械地逐栏重复调用本工具。",
    parameters: z.object({ field: lessonFieldSchema }),
    execute: async ({ field }, runContext) => {
      const context = requireContext(runContext);
      const file = await repository.getLessonFile(context.userId, context.lessonFileId);
      if (!file) throw new Error("lesson_file_not_found");
      return JSON.stringify({ field, value: file.document[field], documentVersion: file.documentVersion });
    },
  });

  const readDocument = tool({
    name: "read_document",
    description: "一次读取当前整份教案或指定的多个栏目。全局审查、完整性检查或需要四个及以上栏目时省略 fields 直接读取整份教案；比较少量栏目时传入去重后的 fields。",
    parameters: z.object({
      fields: z.array(lessonFieldSchema).min(1).max(12).optional(),
    }),
    execute: async ({ fields }, runContext) => {
      const context = requireContext(runContext);
      const file = await repository.getLessonFile(context.userId, context.lessonFileId);
      if (!file) throw new Error("lesson_file_not_found");
      const requestedFields = fields ? [...new Set(fields)] : Object.keys(file.document) as Array<keyof typeof file.document>;
      return JSON.stringify({
        sections: Object.fromEntries(requestedFields.map((field) => [field, file.document[field]])),
        documentVersion: file.documentVersion,
      });
    },
  });

  const readOutline = tool({
    name: "read_document_outline",
    description: "读取当前教案栏目结构、非空状态和字符数，不返回全部正文。",
    parameters: z.object({}),
    execute: async (_input, runContext) => {
      const context = requireContext(runContext);
      const file = await repository.getLessonFile(context.userId, context.lessonFileId);
      if (!file) throw new Error("lesson_file_not_found");
      return JSON.stringify(Object.entries(file.document).map(([field, value]) => ({
        field, hasContent: Boolean(value), characters: value.length,
      })));
    },
  });

  const getVersion = tool({
    name: "get_document_version",
    description: "读取当前文档版本。提出修改前必须核对版本。",
    parameters: z.object({}),
    execute: async (_input, runContext) => {
      const context = requireContext(runContext);
      const file = await repository.getLessonFile(context.userId, context.lessonFileId);
      if (!file) throw new Error("lesson_file_not_found");
      return JSON.stringify({ documentVersion: file.documentVersion });
    },
  });

  const tools = [readDocumentMetadata, readDocument, readSection, readOutline, getVersion];
  if (!allowWrite) return tools;

  tools.push(tool({
    name: "propose_document_patch",
    description: "提出对当前教案的最小文本修改。该工具始终暂停并要求用户预览批准，未经批准不得写入。",
    parameters: documentPatchToolSchema,
    needsApproval: true,
    execute: async (patchInput, runContext) => {
      const context = requireContext(runContext);
      const patch = documentPatchSchema.parse({ ...patchInput, fileId: context.lessonFileId });
      return JSON.stringify({ status: "approved_document_patch_applied", summary: patch.summary });
    },
  }));
  return tools;
}
