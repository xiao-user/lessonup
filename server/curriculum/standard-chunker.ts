import { createHash } from "node:crypto";
import { z } from "zod";

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const paddleBlockSchema = z.object({
  block_label: z.string(),
  block_content: z.string().default(""),
  block_bbox: bboxSchema,
  block_id: z.number().int(),
  block_order: z.number().int().nullable().optional(),
}).passthrough();

const layoutBoxSchema = z.object({
  label: z.string(),
  score: z.number().min(0).max(1).optional(),
  coordinate: bboxSchema,
  order: z.number().int().nullable().optional(),
}).passthrough();

const paddlePageSchema = z.object({
  prunedResult: z.object({
    model_settings: z.record(z.string(), z.unknown()).optional(),
    layout_det_res: z.object({ boxes: z.array(layoutBoxSchema).default([]) }).optional(),
    parsing_res_list: z.array(paddleBlockSchema).default([]),
  }),
  markdown: z.object({
    text: z.string().default(""),
    images: z.record(z.string(), z.unknown()).nullable().optional(),
  }).optional(),
}).passthrough();

export const paddleDocumentSchema = z.array(paddlePageSchema).min(1);
export type PaddleDocument = z.infer<typeof paddleDocumentSchema>;

type NormalizedBlock = {
  page: number;
  blockId: number;
  order: number;
  label: string;
  text: string;
  bbox: [number, number, number, number];
  confidence?: number;
};

export type CurriculumStandardChunk = {
  stableChunkId: string;
  ordinal: number;
  passage: string;
  embeddingText: string;
  section: string;
  headingPath: string[];
  pageStart: number;
  pageEnd: number;
  blockRefs: Array<{ page: number; blockId: number }>;
  labels: string[];
  averageConfidence?: number;
  contentSha256: string;
};

export type CurriculumStandardNormalization = {
  schemaVersion: 1;
  parser: {
    engine: "PaddleOCR-VL-1.6";
    modelSettings: Record<string, unknown>;
  };
  document: {
    id: string;
    title: string;
    kind: "curriculum_standard" | "curriculum_plan";
    subject: string | null;
    sourceFilename: string;
    parsedSha256: string;
    pageCount: number;
  };
  quality: {
    pageCount: number;
    blockCount: number;
    contentCharacters: number;
    emptyContentPages: number[];
    labelCounts: Record<string, number>;
    lowConfidenceBlocks: number;
    warnings: string[];
  };
  chunks: CurriculumStandardChunk[];
};

const ignoredLabels = new Set([
  "header", "header_image", "footer", "footer_image", "number",
]);
const headingLabels = new Set(["doc_title", "paragraph_title"]);
const contentLabels = new Set([
  "text", "content", "table", "display_formula", "formula_number", "chart",
  "figure_title", "footnote", "vision_footnote", "image",
]);

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function cleanText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

export function tableHtmlToText(value: string) {
  if (!/<table\b/i.test(value)) return cleanText(value);
  const rows = [...value.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => {
    const cells = [...match[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => decodeHtml(cell[1]!.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " ")))
      .map(cleanText);
    return cells.join(" | ");
  });
  return cleanText(rows.join("\n"));
}

function heading(value: string, label: string, currentPath: string[]) {
  const normalized = cleanText(value);
  const matched = normalized.match(/^(#{1,6})\s*(.+)$/s);
  const text = matched ? cleanText(matched[2]!) : normalized;
  const markupLevel = matched?.[1]?.length ?? (label === "doc_title" ? 1 : 2);
  if (/^中华人民共和国教育部(?:制定)?$/.test(text)) return null;
  // PaddleOCR occasionally labels a page-opening stage title as doc_title.
  // Prefer the document's semantic numbering over the model's visual label so
  // a new page cannot accidentally reset the entire hierarchy.
  const isDocumentTitle = !text.includes("关于")
    && /^(?:义务教育\s*)?.{0,24}?课程(?:标准|方案)(?:（\d{4}年版）)?$/.test(text);
  if (isDocumentTitle) {
    return { level: 1, text };
  }
  if (/^(?:前言|目录|附录)$/.test(text) || /^[一二三四五六七八九十]+、/.test(text)) {
    return { level: 2, text };
  }
  if (/^（[一二三四五六七八九十]+）/.test(text) || /^附录\s*\d+/.test(text)) {
    return { level: 3, text };
  }
  if (/^第[一二三四五六七八九十]+学段/.test(text)) return { level: 4, text };
  const stageActive = Boolean(currentPath[3]);
  if (stageActive && /^【.+】$/.test(text)) return { level: 5, text };
  if (stageActive && /^\d+[.．、]\s*/.test(text)) return { level: 6, text };
  if (stageActive && /^（\d+）/.test(text)) return { level: 7, text };
  if (label === "doc_title") return { level: 1, text };
  return { level: markupLevel, text };
}

function scoreKey(label: string, bbox: readonly number[]) {
  return `${label}\u0000${bbox.join(",")}`;
}

function normalizeBlocks(pages: PaddleDocument) {
  const blocks: NormalizedBlock[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    const scores = new Map((page.prunedResult.layout_det_res?.boxes ?? []).map((box) => (
      [scoreKey(box.label, box.coordinate), box.score] as const
    )));
    const pageBlocks = page.prunedResult.parsing_res_list
      .map((block) => ({
        page: pageIndex + 1,
        blockId: block.block_id,
        order: block.block_order ?? Number.MAX_SAFE_INTEGER,
        label: block.block_label,
        text: block.block_label === "table" ? tableHtmlToText(block.block_content) : cleanText(block.block_content),
        bbox: block.block_bbox,
        confidence: scores.get(scoreKey(block.block_label, block.block_bbox)),
      }))
      .sort((left, right) => left.order - right.order
        || left.bbox[1] - right.bbox[1]
        || left.bbox[0] - right.bbox[0]);
    blocks.push(...pageBlocks);
  }
  return blocks;
}

function splitLongText(text: string, maximum = 1_200, overlap = 100) {
  if (text.length <= maximum) return [text];
  const parts = text.split(/(?<=[。！？；!?])|\n+/).map(cleanText).filter(Boolean);
  const result: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current && current.length + part.length + 1 > maximum) {
      result.push(current);
      const tail = current.slice(-overlap);
      current = `${tail}\n${part}`;
    } else {
      current = current ? `${current}\n${part}` : part;
    }
  }
  if (current) result.push(current);
  if (result.length === 1 && result[0]!.length > maximum) {
    const hard: string[] = [];
    for (let index = 0; index < text.length; index += maximum - overlap) {
      hard.push(text.slice(index, index + maximum));
      if (index + maximum >= text.length) break;
    }
    return hard;
  }
  return result;
}

function splitTableText(text: string, maximum = 1_200) {
  if (text.length <= maximum) return [text];
  const lines = text.split("\n").map(cleanText).filter(Boolean);
  if (lines.length < 2) return splitLongText(text, maximum, 0);
  const header = lines[0]!;
  const chunks: string[] = [];
  let current = header;
  for (const row of lines.slice(1)) {
    if (current.length > header.length && current.length + row.length + 1 > maximum) {
      chunks.push(current);
      current = `${header}\n${row}`;
    } else {
      current = `${current}\n${row}`;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function parseSourceFilename(filename: string) {
  const sourceFilename = filename.replace(/_by_PaddleOCR-VL-1\.6\.json$/i, "");
  const title = sourceFilename.replace(/\.pdf$/i, "");
  if (title.includes("课程方案")) {
    return { sourceFilename, title, kind: "curriculum_plan" as const, subject: null };
  }
  const subject = title.match(/^义务教育(.+?)课程标准（2022年版）$/)?.[1] ?? null;
  return { sourceFilename, title, kind: "curriculum_standard" as const, subject };
}

export function normalizeCurriculumStandard(args: {
  filename: string;
  rawText: string;
  targetCharacters?: number;
  maximumCharacters?: number;
}): CurriculumStandardNormalization {
  const pages = paddleDocumentSchema.parse(JSON.parse(args.rawText) as unknown);
  const parsedSha256 = sha256(args.rawText);
  const source = parseSourceFilename(args.filename);
  const documentId = sha256(`${source.sourceFilename}\u0000${parsedSha256}`).slice(0, 32);
  const blocks = normalizeBlocks(pages);
  const target = args.targetCharacters ?? 800;
  const maximum = args.maximumCharacters ?? 1_300;
  const headingPath: string[] = [];
  const chunks: CurriculumStandardChunk[] = [];
  let pending: NormalizedBlock[] = [];
  let pendingPath: string[] = [];

  const emit = (items: NormalizedBlock[], path: string[]) => {
    if (!items.length) return;
    const combined = cleanText(items.map((item) => item.text).filter(Boolean).join("\n\n"));
    if (!combined) return;
    const refs = items.map((item) => ({ page: item.page, blockId: item.blockId }));
    const pageStart = Math.min(...items.map((item) => item.page));
    const pageEnd = Math.max(...items.map((item) => item.page));
    const split = items.length === 1 && items[0]?.label === "table"
      ? splitTableText(combined, maximum)
      : splitLongText(combined, maximum);
    for (const passage of split) {
      if (/^(?:续表|附表)$/.test(passage)) continue;
      const meaningfulCharacters = passage.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
      if (meaningfulCharacters < 2) continue;
      if (
        pageEnd <= 2
        && !path.some(Boolean)
        && /课程(?:标准|方案)/.test(passage)
        && /教育部/.test(passage)
      ) continue;
      if (pageEnd <= 2 && passage.length < 30 && path.filter(Boolean).length <= 1) continue;
      const confidences = items.flatMap((item) => item.confidence == null ? [] : [item.confidence]);
      const contentSha256 = sha256(passage);
      const cleanPath = path.filter(Boolean);
      const section = cleanPath.join(" > ");
      chunks.push({
        stableChunkId: `${documentId}:${pageStart}-${pageEnd}:${sha256(`${refs[0]?.blockId}:${refs.at(-1)?.blockId}:${contentSha256}`).slice(0, 24)}`,
        ordinal: chunks.length + 1,
        passage,
        embeddingText: section ? `${section}\n${passage}` : passage,
        section,
        headingPath: cleanPath,
        pageStart,
        pageEnd,
        blockRefs: refs,
        labels: [...new Set(items.map((item) => item.label))],
        averageConfidence: confidences.length
          ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
          : undefined,
        contentSha256,
      });
    }
  };

  const flush = () => {
    emit(pending, pendingPath);
    pending = [];
  };

  for (const block of blocks) {
    if (!block.text || ignoredLabels.has(block.label)) continue;
    if (headingLabels.has(block.label)) {
      flush();
      const parsed = heading(block.text, block.label, headingPath);
      if (!parsed) continue;
      headingPath.length = parsed.level - 1;
      headingPath[parsed.level - 1] = parsed.text;
      continue;
    }
    if (!contentLabels.has(block.label)) continue;
    if (!pending.length) pendingPath = [...headingPath];
    const pendingLength = pending.reduce((sum, item) => sum + item.text.length, 0);
    const isAtomic = block.label === "table" || block.label === "chart";
    if (isAtomic) {
      flush();
      emit([block], [...headingPath]);
      continue;
    }
    if (pending.length && pendingLength + block.text.length > target) {
      flush();
      pendingPath = [...headingPath];
    }
    pending.push(block);
  }
  flush();

  const labelCounts: Record<string, number> = {};
  for (const block of blocks) labelCounts[block.label] = (labelCounts[block.label] ?? 0) + 1;
  const emptyContentPages = pages.flatMap((page, index) => {
    const hasContent = page.prunedResult.parsing_res_list.some((block) => (
      !ignoredLabels.has(block.block_label) && cleanText(block.block_content).length > 0
    ));
    return hasContent ? [] : [index + 1];
  });
  const warnings = ["page_index_absent_array_order_used"];
  if (!source.subject && source.kind === "curriculum_standard") warnings.push("subject_not_inferred");
  if (emptyContentPages.length) warnings.push("empty_content_pages_present");

  return {
    schemaVersion: 1,
    parser: {
      engine: "PaddleOCR-VL-1.6",
      modelSettings: pages[0]?.prunedResult.model_settings ?? {},
    },
    document: {
      id: documentId,
      ...source,
      parsedSha256,
      pageCount: pages.length,
    },
    quality: {
      pageCount: pages.length,
      blockCount: blocks.length,
      contentCharacters: chunks.reduce((sum, chunk) => sum + chunk.passage.length, 0),
      emptyContentPages,
      labelCounts,
      lowConfidenceBlocks: blocks.filter((block) => block.confidence != null && block.confidence < 0.65).length,
      warnings,
    },
    chunks,
  };
}
