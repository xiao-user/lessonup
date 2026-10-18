import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "../../lib/lesson-drafts.test.js";
import { resolveExtensions } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

import { createLessonPlanDraft } from "./data.js";
import { normalizeEditableText } from "./editable-text.js";
import {
  createLessonHistory,
  recordLessonChange,
  redoLessonChange,
  undoLessonChange,
} from "./history.js";
import { paginateLessonPlan } from "./pagination.js";
import {
  applyLessonFieldEdit,
} from "./lesson-plan-tiptap-bridge.js";
import {
  parseLessonMarkdown,
  projectLessonMarkdownDocument,
  serializeLessonMarkdown,
} from "./lesson-markdown.js";
import { pickActiveLessonSection } from "./scroll-state.js";

test("content-driven rows keep the default lesson on one A4 page", () => {
  const plan = createLessonPlanDraft({ subject: "数学" }, { title: "轴对称" });
  assert.equal(paginateLessonPlan(plan).length, 1);
});

test("presentation material is always the final paginated A4 row", () => {
  const plan = createLessonPlanDraft({ subject: "数学" }, { title: "轴对称" });
  const pages = paginateLessonPlan(plan);
  assert.equal(pages.at(-1).at(-1).kind, "presentation");
});

test("overflowing content creates a continuation page", () => {
  const plan = createLessonPlanDraft({ subject: "数学" }, { title: "轴对称" });
  const pages = paginateLessonPlan({ ...plan, process: "观察、比较、解释并形成证据记录。\n".repeat(100) });
  assert.ok(pages.length > 1);
  assert.ok(pages.flat().some((entry) => entry.continued));
});

test("Markdown pagination prefers complete lines over splitting a structural marker", () => {
  const plan = createLessonPlanDraft({ subject: "数学" }, { title: "轴对称" });
  const markdown = [
    "## 环节一：问题聚焦",
    "- 学生圈出对称轴。",
    "- 说明判断依据。",
    "> 达成证据：能够完成折叠记录。",
  ].join("\n").repeat(8);
  const pages = paginateLessonPlan({ ...plan, process: markdown }, {
    pageHeight: 120,
    measureBasics: () => 12,
    measureTopic: () => 12,
    measureSection: (_section, value) => 12 + String(value).length * 1.1,
  });
  const fragments = pages.flat().filter((entry) => entry.sectionId === "process");

  assert.ok(fragments.length > 1);
  assert.ok(fragments.slice(0, -1).every((entry) => entry.value.endsWith("\n")));
});

test("A4 pagination does not cut a short inline marker across two pages", () => {
  const plan = createLessonPlanDraft({ subject: "语文" }, { title: "春" });
  const marked = `=={pink}关键证据==`;
  const pages = paginateLessonPlan({ ...plan, process: `${"前".repeat(80)}${marked}${"后".repeat(80)}` }, {
    pageHeight: 120,
    measureBasics: () => 12,
    measureTopic: () => 12,
    measureSection: (_section, value) => 12 + String(value).length,
  });
  const fragments = pages.flat().filter((entry) => entry.sectionId === "process");
  assert.ok(fragments.length > 1);
  assert.ok(fragments.some((entry) => entry.value.includes(marked)));
  assert.ok(fragments.every((entry) => !entry.value.includes("==") || entry.value.includes(marked)));
});

test("editable text preserves deliberate leading and trailing blank lines", () => {
  const value = "\n教学过程\n\n\n";
  assert.equal(normalizeEditableText(value), value);
});

test("A4 uses isolated field rich editors without a mode switch", async () => {
  const workspace = await readFile(new URL("./lesson-file-workspace.jsx", import.meta.url), "utf8");
  const editor = await readFile(new URL("./lesson-plan-tiptap.jsx", import.meta.url), "utf8");

  assert.match(workspace, /<LessonPlanTiptapEditor/);
  assert.doesNotMatch(workspace, /<textarea/);
  assert.doesNotMatch(workspace, /documentEditMode|toggleDocumentEditMode|编辑内容|完成编辑|lesson-content-display/);
  assert.match(editor, /useEditor\(/);
  assert.match(editor, /function LessonFieldEditor/);
  assert.match(editor, /React owns A4 pages and the lesson table/);
  assert.match(editor, /!transaction\.docChanged/);
  assert.match(editor, /setEditable\(!readOnly, false\)/);
  assert.doesNotMatch(editor, /lessonPlanFromTiptapDocument/);
});

test("the editor bridge flushes every mounted field before an agent command", async () => {
  const source = await readFile(new URL("./lesson-plan-tiptap.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /flush\(\) \{\}/);
  assert.match(source, /for \(const registration of editorsRef\.current\.values\(\)\) registration\.flush\(\)/);
});

test("presentation material is the final A4 row and starts the confirmation flow after flushing", async () => {
  const workspace = await readFile(new URL("./lesson-file-workspace.jsx", import.meta.url), "utf8");
  const editor = await readFile(new URL("./lesson-plan-tiptap.jsx", import.meta.url), "utf8");

  assert.match(editor, /演示材料/);
  assert.match(editor, /在对话中设计/);
  assert.match(editor, /重新设计/);
  assert.match(editor, /预览/);
  assert.match(editor, /确认删除/);
  assert.match(workspace, /await flushDocumentBeforeAgentRun\(\)/);
  assert.match(workspace, /lessonup:request-dashi-presentation/);
  assert.match(workspace, /生成可直接渲染的完整逐页内容与版式供我确认/);
  assert.match(workspace, /我确认后直接渲染，不再改写/);
  assert.match(workspace, /deleteClassroomPresentation/);
  assert.doesNotMatch(workspace, /PresentationStudio|presentationStudioOpen|lesson-presentation-entry/);
});

test("pagination keeps every sheet in a stable layout slot", async () => {
  const editor = await readFile(new URL("./lesson-plan-tiptap.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../styles.css", import.meta.url), "utf8");

  assert.match(editor, /className="lesson-sheet-slot"/);
  assert.match(editor, /className="lesson-sheet-frame"/);
  assert.match(editor, /if \(!instance\.isFocused\) return;/);
  assert.match(styles, /\.lesson-sheet-slot\s*\{[^}]*width:\s*min\(100%, var\(--lesson-paper-display-width\)\);[^}]*height:\s*var\(--lesson-paper-display-height\);/s);
  assert.match(styles, /\.lesson-sheet-frame\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
});

test("single-notebook chrome animation skips absent GSAP targets", async () => {
  const carousel = await readFile(new URL("../notebooks/book-carousel.jsx", import.meta.url), "utf8");

  assert.match(carousel, /if \(metaLeft\) timeline\.to\(metaLeft/);
  assert.match(carousel, /if \(metaRight\) timeline\.to\(metaRight/);
  assert.match(carousel, /if \(names\.length\) timeline\.to\(names/);
  assert.match(carousel, /if \(scrollbar\) timeline\.to\(scrollbar/);
  assert.match(carousel, /if \(otherBooks\.length\) timeline\.to\(otherBooks/);
});

test("pagination renders every Markdown candidate with the same Tiptap schema", async () => {
  const workspace = await readFile(new URL("./lesson-file-workspace.jsx", import.meta.url), "utf8");
  const markdown = await readFile(new URL("./lesson-markdown.js", import.meta.url), "utf8");

  assert.match(workspace, /probeContent\.innerHTML = renderLessonMarkdownHtml\(text\)/);
  assert.doesNotMatch(workspace, /richTextScale|rawFullHeight/);
  assert.match(markdown, /projectionSchema\.nodeFromJSON\(projectLessonMarkdownDocument\(value\)\)/);
  assert.match(markdown, /getHTMLFromFragment\(node\.content, projectionSchema\)/);
  assert.match(markdown, /lessonFieldExtensions/);
  assert.match(markdown, /content\.at\(-1\)\?\.type === "paragraph"/);
});

test("plain single newlines become measurable line breaks", () => {
  const parsed = parseLessonMarkdown("第一行普通文本\n第二行普通文本");
  const paragraph = parsed.content?.[0];

  assert.equal(paragraph?.type, "paragraph");
  assert.equal(paragraph?.content?.[1]?.type, "hardBreak");
});

test("real Enter-created blank paragraphs survive save and reparse", () => {
  const editorDocument = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "第一行" }] },
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "第二行" }] },
    ],
  };
  const serialized = serializeLessonMarkdown(editorDocument);
  const reparsed = parseLessonMarkdown(serialized);

  assert.equal(serialized.includes("&nbsp;"), false);
  assert.equal(reparsed.content?.length, 3);
  assert.equal(reparsed.content?.[1]?.type, "paragraph");
  assert.equal(reparsed.content?.[1]?.content?.length ?? 0, 0);
  assert.equal(
    projectLessonMarkdownDocument(serialized).content?.[1]?.content?.[0]?.type,
    "hardBreak",
  );
});

test("Enter-created blank paragraphs remain invisible across pagination fragments", () => {
  const content = [
    { type: "paragraph", content: [{ type: "text", text: "起点" }] },
    ...Array.from({ length: 28 }, () => ({ type: "paragraph" })),
    { type: "paragraph", content: [{ type: "text", text: "终点" }] },
  ];
  const reflection = serializeLessonMarkdown({ type: "doc", content });
  const plan = {
    ...createLessonPlanDraft({ subject: "语文" }, { title: "回车分页" }),
    reflection,
  };
  const pages = paginateLessonPlan(plan, {
    pageHeight: 200,
    measureBasics: () => 1,
    measureTopic: () => 1,
    measureSection: (section, value) => (
      section.id === "reflection"
        ? 20 + (parseLessonMarkdown(value).content?.length ?? 0) * 18
        : 1
    ),
  });
  const fragments = pages.flat().filter((entry) => entry.field === "reflection");

  assert.ok(fragments.length > 1);
  assert.equal(fragments.some((entry) => entry.value.includes("&nbsp;")), false);
  assert.equal(
    fragments.flatMap((entry) => parseLessonMarkdown(entry.value).content ?? [])
      .some((node) => node.type === "paragraph" && node.content?.[0]?.text === "&nbsp;"),
    false,
  );
});

test("Markdown headings and lists become rich document nodes before A4 projection", () => {
  const markdown = new MarkdownManager({
    extensions: resolveExtensions([StarterKit.configure({ document: false, undoRedo: false })]),
  });
  const parsed = markdown.parse("## 学习目标\n\n- 梳理景物描写。\n- 说明表达效果。");

  assert.equal(parsed.content[0]?.type, "heading");
  assert.equal(parsed.content[1]?.type, "bulletList");
});

test("double-equals highlight survives A4 parse, edit serialization, and reparse", () => {
  const source = "学生能够圈画==春景特征词==，并说明表达效果。";
  const parsed = parseLessonMarkdown(source);
  const highlightedText = parsed.content?.[0]?.content?.find((node) => (
    node.type === "text" && node.marks?.some((mark) => mark.type === "highlight")
  ));

  assert.equal(highlightedText?.text, "春景特征词");
  assert.equal(serializeLessonMarkdown(parsed), source);

  const reparsed = parseLessonMarkdown(serializeLessonMarkdown(parsed));
  assert.equal(
    reparsed.content?.[0]?.content?.some((node) => (
      node.marks?.some((mark) => mark.type === "highlight")
    )),
    true,
  );
});

test("colored marker strokes preserve their tone through A4 edits and pagination fragments", () => {
  const source = "## 探究环节\n\n- 圈画=={pink}关键证据==，再用=={blue}自己的话解释==。\n- 比较=={green}两种解法==与=={red}常见误区==。";
  const parsed = parseLessonMarkdown(source);
  const list = parsed.content?.[1];
  const marked = list.content.flatMap((item) => item.content?.[0]?.content ?? [])
    .filter((node) => node.marks?.some((mark) => mark.type === "highlight"));

  assert.equal(parsed.content?.[0]?.type, "heading");
  assert.deepEqual(marked.map((node) => node.marks.find((mark) => mark.type === "highlight")?.attrs?.tone), ["pink", "blue", "green", "red"]);
  assert.equal(serializeLessonMarkdown(parsed), source);
  assert.deepEqual(parseLessonMarkdown(serializeLessonMarkdown(parsed)), parsed);
  assert.equal(projectLessonMarkdownDocument(source).content?.[1]?.type, "bulletList");
});

test("editing a list does not persist a second visible marker or the gap cursor", () => {
  const editorDocument = parseLessonMarkdown("1. 原始目标");
  editorDocument.content[0].content[0].content[0].content[0].text = "1. 更新后的目标";
  editorDocument.content.push({ type: "paragraph" });

  assert.equal(serializeLessonMarkdown(editorDocument), "1. 更新后的目标");
});

test("a Tiptap field edit cannot clear unrelated lesson-plan modules", () => {
  const plan = {
    ...createLessonPlanDraft({ subject: "语文" }, { title: "春" }),
    objectives: "## 教学目标\n\n- 感受春景。",
    process: "## 导入\n\n朗读课文。",
    assessment: "观察学生朗读表现。",
  };
  const nextPlan = applyLessonFieldEdit(plan, {
    field: "process",
    start: 0,
    previousValue: plan.process,
    value: `${plan.process}\n\n- 圈画关键词。`,
  });

  assert.equal(nextPlan.objectives, plan.objectives);
  assert.equal(nextPlan.assessment, plan.assessment);
  assert.equal(nextPlan.process, `${plan.process}\n\n- 圈画关键词。`);
});

test("successive edits replace only the current paginated fragment", () => {
  const plan = { process: "第一段。第二段。第三段。", objectives: "保持不变" };
  const first = applyLessonFieldEdit(plan, {
    field: "process",
    start: 4,
    previousValue: "第二段。",
    value: "第二段已修改。",
  });
  const second = applyLessonFieldEdit(first, {
    field: "process",
    start: 4,
    previousValue: "第二段已修改。",
    value: "第二段已再次修改。",
  });

  assert.equal(second.process, "第一段。第二段已再次修改。第三段。");
  assert.equal(second.objectives, "保持不变");
});

test("typing is grouped while paste and later edits create distinct undo steps", () => {
  const initial = { process: "原文" };
  let history = createLessonHistory(initial);
  history = recordLessonChange(history, { process: "原文一" }, {
    field: "process",
    kind: "typing",
  }, 1000);
  history = recordLessonChange(history, { process: "原文一二" }, {
    field: "process",
    kind: "typing",
  }, 1400);
  history = recordLessonChange(history, { process: "原文一二粘贴" }, {
    field: "process",
    kind: "paste",
  }, 1500);

  assert.equal(history.past.length, 2);
  history = undoLessonChange(history);
  assert.equal(history.present.process, "原文一二");
  history = undoLessonChange(history);
  assert.equal(history.present.process, "原文");
  history = redoLessonChange(history);
  assert.equal(history.present.process, "原文一二");
  history = recordLessonChange(history, { process: "新的分支" }, {
    field: "process",
    kind: "typing",
  }, 3000);
  assert.equal(history.future.length, 0);
});

test("measured table rows determine the final page boundary", () => {
  const plan = createLessonPlanDraft({ subject: "数学" }, { title: "轴对称" });
  const pages = paginateLessonPlan(
    { ...plan, process: "教学步骤".repeat(32) },
    {
      pageHeight: 120,
      measureBasics: () => 12,
      measureTopic: () => 12,
      measureSection: (section, value, continued) => {
        if (section.id !== "process") return 12;
        return 12 + String(value).length * 2 + (continued ? 2 : 0);
      },
    },
  );

  const processEntries = pages.flat().filter((entry) => entry.sectionId === "process");
  assert.ok(processEntries.length > 1);
  assert.ok(processEntries.some((entry) => entry.continued));
  assert.equal(processEntries.map((entry) => entry.value).join(""), "教学步骤".repeat(32));
});

test("long Markdown pagination searches whole lines and preserves every source character", () => {
  const plan = createLessonPlanDraft({ subject: "语文" }, { title: "文本证据" });
  plan.process = Array.from({ length: 300 }, (_, index) => `- 第${index + 1}项：用证据解释判断。`).join("\n");
  let probes = 0;
  const pages = paginateLessonPlan(plan, {
    pageHeight: 200, measureBasics: () => 10, measureTopic: () => 10, measurePresentation: () => 20,
    measureSection: (section, value) => {
      if (section.id !== "process") return 10;
      probes += 1;
      return Math.max(1, String(value).split("\n").length) * 10;
    },
  });
  const fragments = pages.flat().filter((item) => item.field === "process");
  assert.equal(fragments.map((item) => item.value).join(""), plan.process);
  assert.ok(fragments.slice(0, -1).every((item) => item.value.endsWith("\n")));
  assert.ok(probes < 200, `Expected bounded line probes, got ${probes}`);
});

test("pagination tracks content separately from structural layout", async () => {
  const source = await readFile(new URL("./lesson-file-workspace.jsx", import.meta.url), "utf8");
  assert.match(source, /pageContentSignatureRef/);
  assert.match(source, /layoutChanged \|\| pageContentSignatureRef\.current !== measuredContentSignature/);
  assert.match(source, /if \(layoutChanged\) setPageLayoutRevision/);
});

test("repagination greedily pulls later content back onto earlier pages", () => {
  const plan = createLessonPlanDraft({ subject: "数学" }, { title: "轴对称" });
  const measurements = {
    pageHeight: 150,
    measureBasics: () => 12,
    measureTopic: () => 12,
    measureSection: (section, value, continued) => (
      12 + String(value).length * (section.id === "process" ? 1.5 : 0.08) + (continued ? 2 : 0)
    ),
  };
  const expandedPages = paginateLessonPlan(
    { ...plan, process: "课堂活动与学习证据。".repeat(80) },
    measurements,
  );
  const compactPages = paginateLessonPlan(
    { ...plan, process: "课堂活动与学习证据。" },
    measurements,
  );

  assert.ok(expandedPages.length > compactPages.length);
  assert.equal(
    compactPages.flat().filter((entry) => entry.sectionId === "process")
      .map((entry) => entry.value).join(""),
    "课堂活动与学习证据。",
  );
});

test("the section containing the scroll anchor wins over an earlier section", () => {
  const active = pickActiveLessonSection({
    anchorTop: 140,
    atStart: false,
    atEnd: false,
    sections: [
      { id: "basics", top: -280, bottom: -230 },
      { id: "objectives", top: -80, bottom: 20 },
      { id: "process", top: 96, bottom: 420 },
      { id: "assessment", top: 421, bottom: 510 },
    ],
  });
  assert.equal(active, "process");
});

test("the final section is active when the document reaches its scroll boundary", () => {
  const active = pickActiveLessonSection({
    anchorTop: 140,
    atStart: false,
    atEnd: true,
    sections: [
      { id: "basics", top: -400, bottom: -350 },
      { id: "process", top: -80, bottom: 180 },
      { id: "reflection", top: 500, bottom: 560 },
    ],
  });
  assert.equal(active, "reflection");
});

test("lesson rows and editable cells do not impose section heights", async () => {
  const styles = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(styles, /\.lesson-row-(?:basics|topic|objectives|knowledgePoints|continuity|focus|preparation|process|assessment|homework|board|reflection)\s*\{[^}]*height:/s);
  assert.match(styles, /\.lesson-tiptap-field\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*0;[^}]*padding:\s*12px 14px;/s);
  assert.doesNotMatch(styles, /\.lesson-row-knowledgePoints\s+(?:th|td)/);
  assert.match(styles, /\.lesson-sheet-content\s*\{[^}]*visibility:\s*visible;[^}]*opacity:\s*1;/s);
});
