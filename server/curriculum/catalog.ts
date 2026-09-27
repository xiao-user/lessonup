import type {
  CurriculumNodeMatch,
  CurriculumNodeRecord,
  CurriculumTextbookRecord,
} from "../domain.js";

export type CurriculumTextbookFilter = {
  stage?: string;
  subject?: string;
  edition?: string;
  grade?: string;
  query?: string;
  limit?: number;
};

export type CurriculumFacets = {
  stages: string[];
  subjects: string[];
  editions: string[];
  grades: string[];
  gradesByStage: Record<string, string[]>;
};

const uniqueSorted = (values: Iterable<string>) => (
  [...new Set([...values].map((value) => value.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
);

export function buildCurriculumFacets(textbooks: CurriculumTextbookRecord[]): CurriculumFacets {
  const validGrade = (grade: string) => (
    /^(?:[一二三四五六七八九十]+年级|高中年级)$/.test(grade.trim())
  );
  const stages = uniqueSorted(textbooks.map((book) => book.stage));
  const gradesByStage = Object.fromEntries(stages.map((stage) => [
    stage,
    uniqueSorted(
      textbooks
        .filter((book) => book.stage === stage && validGrade(book.grade))
        .map((book) => book.grade),
    ),
  ]));
  return {
    stages,
    subjects: uniqueSorted(textbooks.map((book) => book.subject)),
    editions: uniqueSorted(textbooks.map((book) => book.edition)),
    grades: uniqueSorted(textbooks.map((book) => book.grade).filter(validGrade)),
    gradesByStage,
  };
}

export function formatTextbookEditionLabel(book: Pick<
  CurriculumTextbookRecord,
  "edition" | "grade" | "volume"
>) {
  return [book.edition, book.grade, book.volume].filter(Boolean).join(" · ");
}

const normalize = (value?: string | null) => (value ?? "").trim().toLowerCase();
export const normalizeCurriculumNodeQuery = (value: string) => (
  normalize(value)
    .replace(/[《》〈〉“”"'‘’【】[\]（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
);

const normalizeCurriculumNodeTitle = (value: string) => (
  normalizeCurriculumNodeQuery(value)
    .replace(/^\s*(?:第?\s*\d+\s*[课章节篇、.．:：-]?|[一二三四五六七八九十]+\s*[、.．])\s*/, "")
    .trim()
);

const includesNormalized = (haystack: string, needle: string) => (
  !needle || normalize(haystack).includes(needle)
);
const equalsNormalized = (value: string, expected: string) => (
  !expected || normalize(value) === expected
);

export function filterCurriculumTextbooks(
  textbooks: CurriculumTextbookRecord[],
  filter: CurriculumTextbookFilter = {},
): CurriculumTextbookRecord[] {
  const stage = normalize(filter.stage);
  const subject = normalize(filter.subject);
  const edition = normalize(filter.edition);
  const grade = normalize(filter.grade);
  const query = normalize(filter.query);
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200);

  return textbooks
    .filter((book) => (
      equalsNormalized(book.stage, stage)
      && equalsNormalized(book.subject, subject)
      && equalsNormalized(book.edition, edition)
      && equalsNormalized(book.grade, grade)
      && (
        !query
        || includesNormalized(book.title, query)
        || includesNormalized(book.volume, query)
        || includesNormalized(book.edition, query)
        || includesNormalized(book.subject, query)
      )
    ))
    .slice(0, limit);
}

export function buildCurriculumOutline(
  nodes: CurriculumNodeRecord[],
  options: { maxLevel?: number; parentId?: string | null } = {},
): CurriculumNodeRecord[] {
  const maxLevel = options.maxLevel ?? 3;
  const parentId = options.parentId === undefined ? undefined : (options.parentId || null);
  const descendants = parentId === undefined
    ? null
    : collectCurriculumDescendantIds(nodes, parentId);

  return nodes
    .filter((node) => (
      node.level <= maxLevel
      && (descendants === null || descendants.has(node.nodeId))
    ))
    .sort((a, b) => (
      a.level - b.level
      || a.sortNo - b.sortNo
      || a.title.localeCompare(b.title, "zh-CN")
    ));
}

function collectCurriculumDescendantIds(
  nodes: CurriculumNodeRecord[],
  parentId: string | null,
) {
  const children = new Map<string, CurriculumNodeRecord[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId ?? "") ?? [];
    list.push(node);
    children.set(node.parentId ?? "", list);
  }
  const ids = new Set<string>();
  const queue = [...(children.get(parentId ?? "") ?? [])];
  while (queue.length) {
    const node = queue.shift()!;
    if (ids.has(node.nodeId)) continue;
    ids.add(node.nodeId);
    queue.push(...(children.get(node.nodeId) ?? []));
  }
  return ids;
}

export function formatCurriculumOutlineTree(
  nodes: CurriculumNodeRecord[],
  options: { rootParentId?: string | null } = {},
) {
  const byParent = new Map<string, CurriculumNodeRecord[]>();
  for (const node of nodes) {
    const key = node.parentId || "";
    const list = byParent.get(key) ?? [];
    list.push(node);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sortNo - b.sortNo || a.title.localeCompare(b.title, "zh-CN"));
  }

  const lines: Array<{
    nodeId: string;
    parentId: string | null;
    level: number;
    title: string;
    pageNumber: number | null;
  }> = [];

  const walk = (parentKey: string, depth: number) => {
    for (const node of byParent.get(parentKey) ?? []) {
      lines.push({
        nodeId: node.nodeId,
        parentId: node.parentId,
        level: node.level,
        title: `${"  ".repeat(Math.max(depth, 0))}${node.title}`,
        pageNumber: node.pageNumber,
      });
      walk(node.nodeId, depth + 1);
    }
  };
  walk(options.rootParentId ?? "", 0);
  return lines;
}

export function searchCurriculumNodeRecords(args: {
  textbooks: CurriculumTextbookRecord[];
  nodes: CurriculumNodeRecord[];
  query: string;
  textbookId?: string;
  subject?: string;
  stage?: string;
  limit?: number;
}): CurriculumNodeMatch[] {
  const query = normalizeCurriculumNodeQuery(args.query);
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  if (!query) return [];
  const books = new Map(args.textbooks
    .filter((book) => (
      (!args.textbookId || book.id === args.textbookId)
      && (!args.subject || normalize(book.subject) === normalize(args.subject))
      && (!args.stage || normalize(book.stage) === normalize(args.stage))
    ))
    .map((book) => [book.id, book]));
  const byBook = new Map<string, Map<string, CurriculumNodeRecord>>();
  for (const node of args.nodes) {
    if (!books.has(node.textbookId)) continue;
    const map = byBook.get(node.textbookId) ?? new Map();
    map.set(node.nodeId, node);
    byBook.set(node.textbookId, map);
  }
  return args.nodes
    .filter((node) => (
      books.has(node.textbookId)
      && normalizeCurriculumNodeTitle(node.title).includes(query)
    ))
    .sort((a, b) => (
      Number(normalizeCurriculumNodeTitle(a.title) !== query)
      - Number(normalizeCurriculumNodeTitle(b.title) !== query)
      || a.title.localeCompare(b.title, "zh-CN")
      || a.textbookId.localeCompare(b.textbookId)
      || a.sortNo - b.sortNo
    ))
    .slice(0, limit)
    .map((node) => {
      const path: CurriculumNodeRecord[] = [];
      const nodeMap = byBook.get(node.textbookId)!;
      let current: CurriculumNodeRecord | undefined = node;
      const seen = new Set<string>();
      while (current && !seen.has(current.nodeId)) {
        path.unshift(current);
        seen.add(current.nodeId);
        current = current.parentId ? nodeMap.get(current.parentId) : undefined;
      }
      return { textbook: books.get(node.textbookId)!, node, path };
    });
}
