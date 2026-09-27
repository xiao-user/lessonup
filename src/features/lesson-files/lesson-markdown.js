import { generateHTML } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { MarkdownManager } from "@tiptap/markdown";
import Highlight from "@tiptap/extension-highlight";
import { TableKit } from "@tiptap/extension-table";
import { Marked } from "marked";

export const lessonFieldExtensions = [
  StarterKit.configure({ undoRedo: false }),
  Highlight,
  TableKit.configure({ table: { resizable: false, renderWrapper: false } }),
];

const createLessonMarkdownParser = () => new Marked({ breaks: true });
const emptyParagraphMarker = "\u2063";
const lessonMarkdownManager = new MarkdownManager({
  // In an editable lesson plan a teacher's Enter is a real visual line break.
  // Use an isolated Marked instance so this choice cannot leak into chat Markdown.
  marked: createLessonMarkdownParser(),
  extensions: lessonFieldExtensions,
});

export function parseLessonMarkdown(value) {
  const source = String(value ?? "")
    .split("\n")
    .map((line) => line === "&nbsp;" ? emptyParagraphMarker : line)
    .join("\n");
  const document = lessonMarkdownManager.parse(source);
  return {
    ...document,
    content: (document.content ?? []).map((node) => (
      node.type === "paragraph"
      && node.content?.length === 1
      && node.content[0]?.type === "text"
      && node.content[0]?.text === emptyParagraphMarker
        ? { ...node, content: [] }
        : node
    )),
  };
}

export function serializeLessonMarkdown(document) {
  return lessonMarkdownManager.serialize(normalizeEditableListDocument(document))
    .split("\n")
    // Tiptap uses an HTML entity to keep otherwise unrepresentable empty
    // paragraphs. A one-code-point invisible marker remains atomic when the
    // canonical Markdown is divided between A4 pages.
    .map((line) => line === "&nbsp;" ? emptyParagraphMarker : line)
    .join("\n");
}

function normalizeEditableListDocument(document) {
  const normalized = structuredClone(document);
  const visit = (node) => {
    if (node?.type === "orderedList" || node?.type === "bulletList") {
      for (let index = 0; index < (node.content?.length ?? 0); index += 1) {
        const firstText = node.content?.[index]?.content?.[0]?.content?.[0];
        if (firstText?.type !== "text") continue;
        const marker = node.type === "orderedList"
          ? new RegExp(`^${Number(node.attrs?.start ?? 1) + index}\\.\\s+`)
          : /^[-*+]\s+/;
        firstText.text = firstText.text.replace(marker, "");
      }
    }
    for (const child of node?.content ?? []) visit(child);
  };
  visit(normalized);

  // Tiptap keeps one empty paragraph after a terminal list as a gap-cursor
  // target. It is editor scaffolding, not a teacher-authored trailing line.
  // Remove only that one paragraph; additional empty paragraphs remain data.
  const content = normalized?.content;
  if (
    Array.isArray(content)
    && content.length >= 2
    && content.at(-1)?.type === "paragraph"
    && !(content.at(-1)?.content?.length)
    && ["orderedList", "bulletList"].includes(content.at(-2)?.type)
  ) content.pop();
  return normalized;
}

export function projectLessonMarkdownDocument(value) {
  const document = parseLessonMarkdown(value);
  const content = (document.content ?? []).map((node) => (
    node.type === "paragraph" && !node.content?.length
      ? { ...node, content: [{ type: "hardBreak" }] }
      : node
  ));
  return {
    ...document,
    // ProseMirror gives an empty paragraph a trailing <br>, while static HTML
    // normally emits <p></p>. Preserve that line box in the hidden pagination
    // projection so real Enter-created blank lines consume the same height.
    content: content.at(-1)?.type === "paragraph"
      ? content
      : [...content, { type: "paragraph", content: [{ type: "hardBreak" }] }],
  };
}

export function renderLessonMarkdownHtml(value) {
  return generateHTML(projectLessonMarkdownDocument(value), lessonFieldExtensions);
}
