const previewFields = ["objectives", "knowledgePoints", "focus", "process", "assessment", "topic"] as const;

type PreviewDocument = Partial<Record<(typeof previewFields)[number], string>>;

const normalizePreviewParagraph = (value: string) => value
  .replace(/\r\n?/g, "\n")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{2,}/g, "\n")
  .trim();

export function createLessonPlanPreview(document: PreviewDocument | null | undefined) {
  if (!document) return [];
  const paragraphs: string[] = [];
  let remainingCharacters = 720;

  for (const field of previewFields) {
    const normalized = normalizePreviewParagraph(document[field] ?? "");
    if (!normalized || paragraphs.includes(normalized)) continue;
    const paragraph = normalized.slice(0, Math.min(240, remainingCharacters)).trim();
    if (!paragraph) continue;
    paragraphs.push(paragraph);
    remainingCharacters -= paragraph.length;
    if (paragraphs.length === 4 || remainingCharacters <= 0) break;
  }

  return paragraphs;
}
