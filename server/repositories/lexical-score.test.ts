import { describe, expect, it } from "vitest";
import { lexicalScore } from "./lexical-score.js";

const passage = "理解负数的意义，能用数轴表示和比较有理数，能进行有理数的加减运算。";

describe("lexicalScore", () => {
  it("keeps whole-term matching for space-separated keyword queries", () => {
    expect(lexicalScore("负数 数轴", passage)).toBe(1);
    expect(lexicalScore("负数 三角形", passage)).toBe(0.5);
    expect(lexicalScore("三角形", passage)).toBe(0);
  });

  it("finds a passage from an unspaced Chinese sentence that never appears verbatim", () => {
    // The old whole-string test scored this 0: the sentence is one "term".
    expect(lexicalScore("怎样用数轴比较负数和有理数的大小", passage)).toBeGreaterThan(0.4);
    expect(lexicalScore("怎样用数轴比较负数和有理数的大小", passage))
      .toBeGreaterThan(lexicalScore("怎样用数轴比较负数和有理数的大小", "光合作用是绿色植物制造有机物的过程。"));
  });

  it("scores a term that occurs as written at full strength", () => {
    expect(lexicalScore("有理数的加减运算", passage)).toBe(1);
  });

  it("drops weak partial matches so an unrelated query returns nothing", () => {
    expect(lexicalScore("怎样制作红烧肉", passage)).toBe(0);
    expect(lexicalScore("量子力学的基本原理", "本原理由有理数的性质推出。")).toBeLessThan(0.4);
  });

  it("lets a corpus with its own relevance priors accept a lower pair coverage", () => {
    const query = "课标中关于负数引入的教学案例或示例";
    // Covers 6 of the query's 16 character pairs: enough for a curated corpus,
    // not enough for open-ended uploads.
    const text = "例64 负数的引入：教学案例，通过温度计示例说明负数";
    expect(lexicalScore(query, text)).toBe(0);
    expect(lexicalScore(query, text, 0.15)).toBeGreaterThan(0.3);
  });

  it("is neutral for an empty query and normalizes width and case", () => {
    expect(lexicalScore("", passage)).toBe(0.01);
    expect(lexicalScore("，；", passage)).toBe(0.01);
    expect(lexicalScore("ＰＰＴ", "使用 ppt 展示")).toBe(1);
  });
});
