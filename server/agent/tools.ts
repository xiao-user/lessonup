import { tool } from "@openai/agents";
import { z } from "zod";
import { documentPatchToolSchema, lessonFieldSchema, type LessonAgentContext } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import { lessonFieldLabels } from "./tool-presentation.js";
import { createDocumentPatchPreflight } from "./write-preflight.js";

const requireContext = (context?: { context: unknown }) => {
  if (!context?.context) throw new Error("agent_context_missing");
  return context.context as LessonAgentContext;
};

export function createDocumentTools(
  repository: LessonRepository,
  allowWrite: boolean,
  options: { maxPatchOperations?: number } = {},
) {
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
        "课题": file.title,
        "课型": file.type,
        "学科": notebook.subject,
        "班级": notebook.className,
        "学年": notebook.year,
        "教学情境": {
          "年级": file.contextProfile.gradeLevel ?? null,
          "教材版本": file.contextProfile.textbookEdition ?? null,
          "课时分钟": file.contextProfile.lessonDurationMinutes ?? null,
          "学生情况": file.contextProfile.learnerProfile ?? null,
          "设备条件": file.contextProfile.equipmentConditions ?? null,
          "已绑定平台教材": Boolean(file.contextProfile.textbookId),
          "已绑定当前章节": Boolean(
            file.contextProfile.lessonNodeId || file.contextProfile.unitNodeId
          ),
        },
        "尚缺信息": [
          !file.contextProfile.gradeLevel ? "年级" : null,
          !file.contextProfile.textbookEdition && !file.contextProfile.textbookId ? "教材版本" : null,
          !file.contextProfile.lessonDurationMinutes ? "课时分钟" : null,
          !file.contextProfile.learnerProfile ? "学生情况" : null,
          !file.contextProfile.equipmentConditions ? "设备条件" : null,
        ].filter(Boolean),
        "教案版本": file.documentVersion,
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
      return JSON.stringify({
        section: lessonFieldLabels[field],
        content: file.document[field],
        documentVersion: file.documentVersion,
      });
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
        sections: Object.fromEntries(requestedFields.map((field) => [
          lessonFieldLabels[field],
          file.document[field],
        ])),
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
        section: lessonFieldLabels[field as keyof typeof lessonFieldLabels],
        hasContent: Boolean(value),
        characters: value.length,
      })));
    },
  });

  const tools = [readDocumentMetadata, readDocument, readSection, readOutline];
  if (!allowWrite) return tools;

  tools.push(tool({
    name: "propose_document_patch",
    description: "提出当前 A4 教案修改。整栏重写只提交栏目和新内容，由服务端绑定当前整栏；仅局部修改时才附带需唯一定位的原文。一次可修改多个合适栏目。该工具始终暂停并要求用户预览批准，未经批准不得写入。",
    parameters: documentPatchToolSchema,
    needsApproval: true,
    inputGuardrails: [createDocumentPatchPreflight(repository, {
      maxOperations: options.maxPatchOperations,
    })],
    execute: async (patchInput, runContext) => {
      requireContext(runContext);
      return JSON.stringify({
        status: "approved_document_patch_applied",
        summary: patchInput.summary,
      });
    },
  }));
  return tools;
}
