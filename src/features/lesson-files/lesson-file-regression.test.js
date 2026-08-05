import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createLessonPlanDraft } from "./data.js";
import { normalizeEditableText } from "./editable-text.js";
import {
  createLessonHistory,
  recordLessonChange,
  redoLessonChange,
  undoLessonChange,
} from "./history.js";
import { paginateLessonPlan } from "./pagination.js";
import { pickActiveLessonSection } from "./scroll-state.js";

test("content-driven rows keep the default lesson on one A4 page", () => {
  const plan = createLessonPlanDraft({ subject: "数学" }, { title: "轴对称" });
  assert.equal(paginateLessonPlan(plan).length, 1);
});

test("overflowing content creates a continuation page", () => {
  const plan = createLessonPlanDraft({ subject: "数学" }, { title: "轴对称" });
  const pages = paginateLessonPlan({ ...plan, process: "观察、比较、解释并形成证据记录。\n".repeat(100) });
  assert.ok(pages.length > 1);
  assert.ok(pages.flat().some((entry) => entry.continued));
});

test("editable text preserves deliberate leading and trailing blank lines", () => {
  const value = "\n教学过程\n\n\n";
  assert.equal(normalizeEditableText(value), value);
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
  assert.match(styles, /\.lesson-editable\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*0;/s);
  assert.match(styles, /\.lesson-sheet-content\s*\{[^}]*visibility:\s*visible;[^}]*opacity:\s*1;/s);
});
