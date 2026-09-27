export function formatTextbookEditionLabel(book) {
  if (!book) return "";
  return [book.edition, book.grade, book.volume].filter(Boolean).join(" · ");
}

export function formatTextbookOptionLabel(book) {
  if (!book) return "";
  const edition = formatTextbookEditionLabel(book);
  if (!edition) return book.title;
  return book.title ? `${edition}｜${book.title}` : edition;
}

export function formatTextbookSelectionLabel(book) {
  if (!book) return "";
  const schoolSystem = /五[•·・]?四/.test(`${book.stage ?? ""}${book.title ?? ""}`)
    ? "五四学制"
    : "";
  return [book.edition, book.grade, book.volume, schoolSystem].filter(Boolean).join(" · ");
}

export function formatTextbookVolumeLabel(book) {
  if (!book) return "";
  const schoolSystem = /五[•·・]?四/.test(`${book.stage ?? ""}${book.title ?? ""}`)
    ? "五四学制"
    : "";
  return [book.grade, book.volume, schoolSystem].filter(Boolean).join(" · ");
}

export function formatCurriculumNodeTitle(title = "") {
  return title
    .trim()
    .replace(/^\s*(?:第?\s*\d+\s*[*＊]?\s*[课、.．:：-]?|\d+(?:\.\d+)*\s*[*＊]?\s*|[一二三四五六七八九十]+\s*[、.．])\s*/, "")
    .trim() || title.trim();
}

export function buildCurriculumNodeOptions(nodes, rootNodeId) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const byParent = new Map();
  for (const node of nodes) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => (
      (a.sortNo ?? 0) - (b.sortNo ?? 0)
      || a.title.localeCompare(b.title, "zh-CN")
    ));
  }
  const genericGroup = /^(?:阅读|写作|口语交际|综合性学习|名著导读|课外古诗词诵读)$/;
  const result = [];
  const visited = new Set();
  const append = (node) => {
    if (visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    const path = [];
    let current = node;
    const pathVisited = new Set();
    while (current && current.nodeId !== rootNodeId && !pathVisited.has(current.nodeId)) {
      pathVisited.add(current.nodeId);
      path.unshift(current.title);
      current = current.parentId ? byId.get(current.parentId) : null;
    }
    const children = byParent.get(node.nodeId) ?? [];
    if (!(children.length && genericGroup.test(node.title.trim()))) {
      result.push({
        ...node,
        path,
        label: path.join(" / ") || node.title,
      });
    }
    children.forEach(append);
  };
  (byParent.get(rootNodeId) ?? []).forEach(append);
  nodes.forEach(append);
  return result;
}

export function buildContextProfileFromTextbook(book, unitNodeId, lessonNodeId) {
  if (!book) {
    return {
      gradeLevel: undefined,
      textbookEdition: undefined,
      textbookId: undefined,
      unitNodeId: undefined,
      lessonNodeId: undefined,
    };
  }
  return {
    gradeLevel: book.grade || undefined,
    textbookEdition: formatTextbookEditionLabel(book) || book.title,
    textbookId: book.id,
    unitNodeId: unitNodeId || undefined,
    lessonNodeId: lessonNodeId || undefined,
  };
}
