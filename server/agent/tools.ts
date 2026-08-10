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

  const readLessonClassFeedback = tool({
    name: "read_lesson_class_feedback",
    description: "读取本课及同单元前序课时已记录的课堂反馈（观察、练习缺口、错因、衔接效果）。生成或修订后续教案时用于承接真实学情；不得把课堂反馈表述为平台已核验的教材先修关系。",
    parameters: z.object({}),
    execute: async (_input, runContext) => {
      const context = requireContext(runContext);
      const [currentRecords, designBasis] = await Promise.all([
        repository.listLessonClassFeedback(context.userId, {
          lessonFileId: context.lessonFileId,
        }),
        repository.getLessonDesignBasis(context.userId, context.lessonFileId),
      ]);
      const present = (record: {
        kind: "observation" | "practice_gap" | "error_cause" | "continuity_outcome";
        statement: string;
        continuityOutcome: "worked" | "weak" | "skipped" | null;
      }, scope: string) => ({
        "类型": ({
          observation: "课堂观察",
          practice_gap: "练习缺口",
          error_cause: "错因",
          continuity_outcome: "衔接效果",
        })[record.kind],
        "说明": record.statement,
        "所属": scope,
        "衔接结果": record.continuityOutcome === "worked"
          ? "有效"
          : record.continuityOutcome === "weak"
            ? "偏弱"
            : record.continuityOutcome === "skipped"
              ? "未落实"
              : null,
      });
      const current = currentRecords.map((record) => present(record, "本课"));
      let prior: ReturnType<typeof present>[] = [];
      const frameworkId = designBasis?.basis.frameworkId;
      const currentBlueprintId = designBasis?.basis.lessonBlueprintId;
      if (frameworkId) {
        const framework = await repository.getSemesterFramework(context.userId, frameworkId);
        const currentBlueprint = framework?.blueprints.find((item) => item.id === currentBlueprintId);
        const priorBlueprintIds = new Set(
          (framework?.blueprints ?? [])
            .filter((item) => (
              currentBlueprint
              && item.semesterUnitId === currentBlueprint.semesterUnitId
              && item.plannedPeriod < currentBlueprint.plannedPeriod
            ))
            .map((item) => item.id),
        );
        if (priorBlueprintIds.size) {
          const frameworkFeedback = await repository.listLessonClassFeedback(context.userId, {
            semesterFrameworkId: frameworkId,
          });
          prior = frameworkFeedback
            .filter((record) => (
              record.lessonFileId !== context.lessonFileId
              && priorBlueprintIds.has(record.lessonBlueprintId ?? "")
            ))
            .slice(0, 20)
            .map((record) => present(record, "同单元前序课时"));
        }
      }
      if (!current.length && !prior.length) {
        return JSON.stringify({
          "结论": "本课及同单元前序课时还没有课堂反馈记录。",
          "本课记录": [],
          "同单元前序记录": [],
        });
      }
      return JSON.stringify({
        "结论": prior.length
          ? "以下包含本课与同单元前序课时的课堂事实，生成后续教案时应优先承接前序薄弱点与未落实衔接。"
          : "以下是本课已记录的课堂事实与判断，可用于修订难点、评价或后续课时衔接。",
        "本课记录": current,
        "同单元前序记录": prior,
        "使用边界": "课堂反馈只代表本班学情，不得表述为平台已核验先修关系。",
      });
    },
  });

  const tools = [
    readDocumentMetadata,
    readDocument,
    readSection,
    readOutline,
    readLessonClassFeedback,
  ];
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
