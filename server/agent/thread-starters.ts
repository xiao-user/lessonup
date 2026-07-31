import { z } from "zod";

import type { LessonFileRecord, NotebookRecord } from "../domain.js";
import { requestDeepSeekFlashText } from "./deepseek-provider.js";

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

export async function generateThreadStarters(args: {
  notebook: NotebookRecord;
  file: LessonFileRecord;
}) {
  const request = (repair?: string) => requestDeepSeekFlashText({
    temperature: 0.2,
    maxOutputTokens: 512,
    json: true,
    instructions: [
      "你为教师的新备课会话生成 3 个可直接发送的问题。",
      "问题必须来自当前真实教案内容，覆盖最值得继续完善的不同方向。",
      "每项 6 至 24 个汉字，不使用占位词，不声称已经读取外部资料。",
      "只输出 JSON：{\"suggestions\":[\"…\",\"…\",\"…\"]}。",
    ].join("\n"),
    input: repair
      ? `将下面内容修复为规定的 JSON，不新增解释：\n${repair.slice(0, 1_000)}`
      : JSON.stringify({
          notebook: {
            title: args.notebook.title,
            subject: args.notebook.subject,
            year: args.notebook.year,
            className: args.notebook.className,
          },
          lessonFile: {
            title: args.file.title,
            documentVersion: args.file.documentVersion,
            document: args.file.document,
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
