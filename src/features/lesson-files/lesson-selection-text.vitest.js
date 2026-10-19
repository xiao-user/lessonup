import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { lessonFieldExtensions, parseLessonMarkdown } from "./lesson-markdown.js";
import { getLessonHighlightSpans, lessonSelectionMatches, lessonSelectionPlainText, normalizeLessonSelectionText } from "./lesson-selection-text.js";

const schema = getSchema(lessonFieldExtensions);
describe("selection text agrees with the actual editable document", () => {
  it.each([
    "1. 能借助注释疏通《咏雪》文意，用\"谁+做了什么+结果\"格式复述故事。\n2. 把\"读—查—接—说\"接回句子。",
    "1. =={pink}目标一==\n2. =={blue}目标二==",
    "=={green}一 **二** 三==与=={red}四==",
    "讨论 &amp;lt;原句&amp;gt; 的作用",
    "`&amp;lt;代码原文&amp;gt;`",
    "文字 &copy; &amp; &quot; &#39; &#x4e2d;",
    "**独立**解释[表达效果](https://example.test)",
    "![天平示意图](https://example.test/image.png)",
    "a  \nb\n\nc\nd",
    "```html\n<b>保留代码原文</b>\n```",
    "|甲|乙|\n|-|-|\n|一|二|",
    "前段\n\n&nbsp;\n\n后段",
    "前段\n\n\u2063\n\n后段",
    "==未闭合和=={pink}   ==标记",
  ])("matches editor text for %s", source => {
    const document = schema.nodeFromJSON(parseLessonMarkdown(source));
    const editorText = document.textBetween(0, document.content.size, "\n");
    expect(normalizeLessonSelectionText(lessonSelectionPlainText(source))).toBe(normalizeLessonSelectionText(editorText));
  });
  it("extracts only actual rendered highlights across lists and tables", () => {
    expect(getLessonHighlightSpans("- =={pink}一 **二** 三==\n\n|甲|乙|\n|-|-|\n|=={blue}四==|五|\n\n`==代码示例==`\n\n\\==转义示例==\n\n```md\n==代码块==\n```"))
      .toEqual([{ text: "一 二 三", tone: "pink" }, { text: "四", tone: "blue" }]);
  });
  it("does not treat hidden link destinations, markers or blank placeholders as visible quotes", () => {
    expect(lessonSelectionMatches("[原句](https://example.test)", "https://example.test")).toBe(false);
    expect(lessonSelectionMatches("=={pink}原句==", "{pink}")).toBe(false);
    expect(lessonSelectionMatches("&nbsp;", "&nbsp;")).toBe(false);
    expect(lessonSelectionMatches("\u2063", "\u2063")).toBe(false);
    expect(lessonSelectionMatches("原句", " ")).toBe(false);
  });
});
