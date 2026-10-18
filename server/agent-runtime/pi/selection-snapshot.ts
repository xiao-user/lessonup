import { Marked } from "marked";
import type { LessonAgentSelection, LessonPlan } from "../../domain.js";
const markdown = new Marked();

function tokenText(token: Record<string, unknown>): string {
  if (Array.isArray(token.tokens)) return token.tokens.map(item => tokenText(item)).join("");
  if (Array.isArray(token.items)) return token.items.map(item => tokenText(item)).join("\n");
  if (token.type === "table") return [token.header, ...(Array.isArray(token.rows) ? token.rows : [])]
    .flat().filter(Boolean).map(item => tokenText(item as Record<string, unknown>)).join("\n");
  if (token.type === "html") return "";
  return typeof token.text === "string" ? token.text : "\n";
}
const normalize = (value: string) => value.replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g, entity => ({
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
}[entity] ?? entity)).replace(/\s+/g, "").trim();

/** Return only verified quote data, not the potentially large client snapshot. */
export function prepareCurrentSelection(
  selection: LessonAgentSelection | undefined,
  document: LessonPlan,
  documentVersion: number,
): (LessonAgentSelection & { documentVersion: number }) | undefined {
  if (!selection) return undefined;
  const input = selection as LessonAgentSelection & {
    fieldSnapshot?: string; baseDocumentVersion?: number; documentVersion?: number;
  };
  const field = document[input.field];
  if (input.documentVersion !== documentVersion
    || !Number.isInteger(input.baseDocumentVersion)
    || input.baseDocumentVersion! < 0 || input.baseDocumentVersion! > documentVersion
    || input.fieldSnapshot !== field || !normalize(input.text)) throw new Error("selection_context_stale");
  const source = field.replace(/==(?:\{(?:yellow|pink|green|blue|red)\})?([^=\n]+)==/g, "$1");
  const plain = markdown.lexer(source).map(token => tokenText(token as unknown as Record<string, unknown>)).join("\n");
  if (!normalize(plain).includes(normalize(input.text))) throw new Error("selection_context_stale");
  return { field: input.field, start: input.start, end: input.end, text: input.text, documentVersion };
}
