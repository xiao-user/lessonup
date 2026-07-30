import { lessonPlanSections } from "./data.js";

const pxPerMillimeter = 96 / 25.4;
const contentHeight = 257 * pxPerMillimeter;
const bodyColumnWidth = 154 * pxPerMillimeter;
const lineHeight = 18;
const cellVerticalPadding = 22;

const characterWidth = (character) => {
  if (character === "\t") return 28;
  if (/\s/.test(character)) return 4;
  if (/[。，；：！？、（）“”《》]/.test(character)) return 7;
  if (character.codePointAt(0) <= 255) return 7;
  return 13;
};

const estimateLineCount = (value) => {
  const text = String(value ?? "");
  if (!text) return 1;

  let lines = 1;
  let lineWidth = 0;
  for (const character of text) {
    if (character === "\n") {
      lines += 1;
      lineWidth = 0;
      continue;
    }

    const width = characterWidth(character);
    if (lineWidth + width > bodyColumnWidth) {
      lines += 1;
      lineWidth = width;
    } else {
      lineWidth += width;
    }
  }
  return lines;
};

const estimateTextHeight = (value) => (
  estimateLineCount(value) * lineHeight + cellVerticalPadding
);

const findNaturalBreak = (text, start, rawEnd) => {
  if (rawEnd >= text.length) return text.length;
  const lowerBound = start + Math.floor((rawEnd - start) * 0.72);
  const preferredBreak = /[\n。！？；，]/;
  for (let index = rawEnd; index > lowerBound; index -= 1) {
    if (preferredBreak.test(text[index - 1])) return index;
  }
  return rawEnd;
};

const takeTextForHeight = (text, start, availableHeight, measureText) => {
  let low = start + 1;
  let high = text.length;
  let best = start;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const fits = measureText(text.slice(start, middle)) <= availableHeight;
    if (fits) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return findNaturalBreak(text, start, best);
};

export function paginateLessonPlan(plan, measurements = {}) {
  const pageHeight = measurements.pageHeight ?? contentHeight;
  const measureBasics = measurements.measureBasics ?? (() => Math.max(
    estimateTextHeight(plan.unit),
    estimateTextHeight(plan.period),
    estimateTextHeight(plan.totalPeriods),
  ));
  const measureTopic = measurements.measureTopic ?? (() => estimateTextHeight(plan.topic));
  const measureSection = measurements.measureSection
    ?? ((section, value) => estimateTextHeight(value));
  const pages = [[]];
  let currentPage = pages[0];
  let remainingHeight = pageHeight;

  const startPage = () => {
    currentPage = [];
    pages.push(currentPage);
    remainingHeight = pageHeight;
  };

  const place = (entry, height) => {
    currentPage.push(entry);
    remainingHeight = Math.max(0, remainingHeight - height);
  };

  const placeMeasuredRow = (entry, rowHeight) => {
    if (rowHeight > remainingHeight + 0.5 && currentPage.length) startPage();
    place(entry, rowHeight);
  };

  placeMeasuredRow({
    key: "basics",
    kind: "basics",
    sectionId: "basics",
  }, measureBasics(plan));

  placeMeasuredRow({
    key: "topic",
    kind: "topic",
    sectionId: "basics",
    field: "topic",
    value: String(plan.topic ?? ""),
    start: 0,
    end: String(plan.topic ?? "").length,
  }, measureTopic(plan.topic));

  lessonPlanSections.filter((section) => section.id !== "basics").forEach((section) => {
    const text = String(plan[section.id] ?? "");
    const naturalHeight = measureSection(section, text, false);

    if (naturalHeight <= remainingHeight + 0.5) {
      place({
        key: section.id,
        kind: "section",
        sectionId: section.id,
        label: section.label,
        tone: section.tone,
        field: section.id,
        value: text,
        start: 0,
        end: text.length,
        continued: false,
      }, naturalHeight);
      return;
    }

    const minimumFragmentHeight = measureSection(section, "字", true);
    const canContinueOnCurrentPage = naturalHeight > remainingHeight
      && remainingHeight >= minimumFragmentHeight;

    if (naturalHeight <= pageHeight && !canContinueOnCurrentPage) {
      startPage();
      place({
        key: section.id,
        kind: "section",
        sectionId: section.id,
        label: section.label,
        tone: section.tone,
        field: section.id,
        value: text,
        start: 0,
        end: text.length,
        continued: false,
      }, naturalHeight);
      return;
    }

    let start = 0;
    let segmentIndex = 0;
    while (start < text.length || (text.length === 0 && segmentIndex === 0)) {
      const isContinuation = segmentIndex > 0;
      const fragmentFloor = measureSection(section, "字", isContinuation);
      if (remainingHeight < fragmentFloor && currentPage.length) startPage();

      const availableHeight = remainingHeight;
      let end = text.length === 0
        ? 0
        : takeTextForHeight(
            text,
            start,
            availableHeight,
            (candidate) => measureSection(section, candidate, isContinuation),
          );
      if (end === start && currentPage.length) {
        startPage();
        continue;
      }
      if (end === start) end = Math.min(text.length, start + 1);
      const value = text.slice(start, end);
      const segmentHeight = measureSection(section, value, isContinuation);

      place({
        key: `${section.id}-${segmentIndex}`,
        kind: "section",
        sectionId: section.id,
        label: section.label,
        tone: section.tone,
        field: section.id,
        value,
        start,
        end,
        continued: segmentIndex > 0,
      }, segmentHeight);

      if (end >= text.length) break;
      start = end;
      segmentIndex += 1;
      startPage();
    }
  });

  return pages.filter((page) => page.length);
}
