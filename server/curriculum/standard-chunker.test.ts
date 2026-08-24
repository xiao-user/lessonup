import { describe, expect, it } from "vitest";
import { normalizeCurriculumStandard, tableHtmlToText } from "./standard-chunker.js";

const page = (blocks: unknown[]) => ({
  prunedResult: {
    model_settings: { use_layout_detection: true },
    layout_det_res: { boxes: blocks.map((block: any) => ({
      label: block.block_label, score: 0.9, coordinate: block.block_bbox,
    })) },
    parsing_res_list: blocks,
  },
  markdown: { text: "", images: null },
});

describe("curriculum standard PaddleOCR normalizer", () => {
  it("keeps heading paths and excludes repeated page chrome", () => {
    const result = normalizeCurriculumStandard({
      filename: "义务教育数学课程标准（2022年版）.pdf_by_PaddleOCR-VL-1.6.json",
      rawText: JSON.stringify([
        page([
          { block_label: "header", block_content: "重复页眉", block_bbox: [0, 0, 10, 10], block_id: 1 },
          { block_label: "paragraph_title", block_content: "## 四、课程内容", block_bbox: [0, 10, 10, 20], block_id: 2, block_order: 1 },
          { block_label: "paragraph_title", block_content: "### 1. 数与运算", block_bbox: [0, 20, 10, 30], block_id: 3, block_order: 2 },
          { block_label: "text", block_content: "学生应理解数的意义。", block_bbox: [0, 30, 10, 40], block_id: 4, block_order: 3 },
        ]),
      ]),
    });
    expect(result.document.subject).toBe("数学");
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.section).toBe("四、课程内容 > 1. 数与运算");
    expect(result.chunks[0]?.passage).not.toContain("重复页眉");
    expect(result.chunks[0]?.pageStart).toBe(1);
  });

  it("turns HTML tables into embedding-friendly rows", () => {
    expect(tableHtmlToText("<table><tr><th>表现</th><th>阶段</th></tr><tr><td>数感</td><td>小学</td></tr></table>"))
      .toBe("表现 | 阶段\n数感 | 小学");
  });

  it("keeps stage and requirement headings above numbered topics", () => {
    const result = normalizeCurriculumStandard({
      filename: "义务教育数学课程标准（2022年版）.pdf_by_PaddleOCR-VL-1.6.json",
      rawText: JSON.stringify([page([
        { block_label: "paragraph_title", block_content: "## 四、课程内容", block_bbox: [0, 0, 10, 10], block_id: 1, block_order: 1 },
        { block_label: "paragraph_title", block_content: "## （一）数与代数", block_bbox: [0, 10, 10, 20], block_id: 2, block_order: 2 },
        // PaddleOCR-VL sometimes promotes a page-opening stage heading to doc_title.
        { block_label: "doc_title", block_content: "# 第四学段（7～9年级）", block_bbox: [0, 20, 10, 30], block_id: 3, block_order: 3 },
        { block_label: "paragraph_title", block_content: "#### 【内容要求】", block_bbox: [0, 30, 10, 40], block_id: 4, block_order: 4 },
        { block_label: "paragraph_title", block_content: "### 1. 数与式", block_bbox: [0, 40, 10, 50], block_id: 5, block_order: 5 },
        { block_label: "paragraph_title", block_content: "##### （1）有理数", block_bbox: [0, 50, 10, 60], block_id: 6, block_order: 6 },
        { block_label: "text", block_content: "理解有理数的意义。", block_bbox: [0, 60, 10, 70], block_id: 7, block_order: 7 },
      ])]),
    });
    expect(result.chunks[0]?.section).toBe(
      "四、课程内容 > （一）数与代数 > 第四学段（7～9年级） > 【内容要求】 > 1. 数与式 > （1）有理数",
    );
  });

  it("does not treat a preface subsection ending in 课程标准 as the document title", () => {
    const result = normalizeCurriculumStandard({
      filename: "义务教育数学课程标准（2022年版）.pdf_by_PaddleOCR-VL-1.6.json",
      rawText: JSON.stringify([page([
        { block_label: "doc_title", block_content: "# 数学课程标准", block_bbox: [0, 0, 10, 10], block_id: 1, block_order: 1 },
        { block_label: "paragraph_title", block_content: "### （二）关于课程标准", block_bbox: [0, 10, 10, 20], block_id: 2, block_order: 2 },
        { block_label: "paragraph_title", block_content: "## 四、课程内容", block_bbox: [0, 20, 10, 30], block_id: 3, block_order: 3 },
        { block_label: "text", block_content: "学生应理解数的意义。", block_bbox: [0, 30, 10, 40], block_id: 4, block_order: 4 },
      ])]),
    });
    expect(result.chunks[0]?.section).toBe("数学课程标准 > 四、课程内容");
  });

  it("drops cover-only content and punctuation artifacts", () => {
    const result = normalizeCurriculumStandard({
      filename: "义务教育课程方案（2022年版）.pdf_by_PaddleOCR-VL-1.6.json",
      rawText: JSON.stringify([page([
        { block_label: "text", block_content: "义务教育\n课程方案\n（2022年版）\n中华人民共和国教育部制定", block_bbox: [0, 0, 10, 10], block_id: 1, block_order: 1 },
        { block_label: "text", block_content: ".....", block_bbox: [0, 10, 10, 20], block_id: 2, block_order: 2 },
      ])]),
    });
    expect(result.chunks).toHaveLength(0);
  });

  it("treats the curriculum plan as shared cross-subject material", () => {
    const result = normalizeCurriculumStandard({
      filename: "义务教育课程方案（2022年版）.pdf_by_PaddleOCR-VL-1.6.json",
      rawText: JSON.stringify([page([
        { block_label: "text", block_content: "培养目标", block_bbox: [0, 0, 10, 10], block_id: 1, block_order: 1 },
      ])]),
    });
    expect(result.document.kind).toBe("curriculum_plan");
    expect(result.document.subject).toBeNull();
  });
});
