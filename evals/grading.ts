import OpenAI from "openai";
import { z } from "zod";

export type BusinessRubric = {
  criteria: string[];
  minimumScore: number;
  requireDocumentGrounding?: boolean;
  rejectGeneric?: boolean;
  rejectUnsupportedPrecision?: boolean;
};

const graderResultSchema = z.object({
  criteria: z.array(z.object({
    index: z.number().int().nonnegative(),
    score: z.number().int().min(0).max(2),
    evidence: z.string().min(1),
  })),
  generic: z.boolean(),
  unsupportedPrecision: z.boolean(),
  documentGrounded: z.boolean(),
  summary: z.string().min(1),
});

export type BusinessGrade = z.infer<typeof graderResultSchema> & {
  normalizedScore: number;
  passed: boolean;
  failures: string[];
};

export function finalizeBusinessGrade(
  input: z.infer<typeof graderResultSchema>,
  rubric: BusinessRubric,
): BusinessGrade {
  const byIndex = new Map(input.criteria.map((criterion) => [criterion.index, criterion]));
  const ordered = rubric.criteria.map((_, index) => byIndex.get(index));
  const failures: string[] = [];
  if (ordered.some((criterion) => !criterion)) failures.push("grader_missing_criterion");
  for (let index = 0; index < ordered.length; index += 1) {
    if ((ordered[index]?.score ?? 0) < 1) failures.push(`rubric_failed:${index}`);
  }
  const normalizedScore = rubric.criteria.length
    ? ordered.reduce((total, criterion) => total + (criterion?.score ?? 0), 0)
      / (rubric.criteria.length * 2)
    : 1;
  if (normalizedScore < rubric.minimumScore) {
    failures.push(`rubric_score_below_threshold:${normalizedScore.toFixed(3)}`);
  }
  if (rubric.rejectGeneric !== false && input.generic) failures.push("generic_response");
  if (rubric.rejectUnsupportedPrecision !== false && input.unsupportedPrecision) {
    failures.push("unsupported_precision");
  }
  if (rubric.requireDocumentGrounding && !input.documentGrounded) {
    failures.push("document_not_grounded");
  }
  return {
    ...input,
    normalizedScore,
    passed: failures.length === 0,
    failures,
  };
}

export async function gradeBusinessResponse(args: {
  client: OpenAI;
  model: string;
  prompt: string;
  response: string;
  document: unknown;
  rubric: BusinessRubric;
  observed: unknown;
}) {
  if (!args.response.trim()) {
    return finalizeBusinessGrade({
      criteria: args.rubric.criteria.map((_, index) => ({
        index,
        score: 0,
        evidence: "没有可评估的助手输出",
      })),
      generic: true,
      unsupportedPrecision: false,
      documentGrounded: false,
      summary: "助手没有产生业务回答或可审查的修改建议。",
    }, args.rubric);
  }

  const response = await args.client.chat.completions.create({
    model: args.model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "你是独立的中文教案 Agent 评测员，不参与被测回答生成。",
          "逐项按 0/1/2 评分：0=未满足或相反，1=部分满足，2=有具体证据充分满足。",
          "generic=true 表示回答换一份教案仍大体成立、缺少对当前原文的具体对应。",
          "unsupportedPrecision=true 表示在缺少课时分钟、语速、学情、教学方式等前提时给出伪精确时间、概率或确定性结论。",
          "documentGrounded=true 仅当关键判断能对应给定教案的具体字段或原文。",
          "不得因为工具调用正确就提高业务质量分。只输出 JSON。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          teacherPrompt: args.prompt,
          lessonDocument: args.document,
          assistantResponse: args.response,
          observedExecution: args.observed,
          rubric: args.rubric.criteria.map((criterion, index) => ({ index, criterion })),
          outputSchema: {
            criteria: [{ index: 0, score: 0, evidence: "简短证据" }],
            generic: false,
            unsupportedPrecision: false,
            documentGrounded: true,
            summary: "总体说明",
          },
        }),
      },
    ],
  });

  const parsed = graderResultSchema.parse(
    JSON.parse(response.choices[0]?.message?.content ?? "{}"),
  );
  return finalizeBusinessGrade(parsed, args.rubric);
}
