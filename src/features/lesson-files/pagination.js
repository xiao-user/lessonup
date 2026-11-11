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
  // Keep Markdown lines intact whenever possible. This prevents a heading,
  // list marker or callout prefix from being separated from its content.
  for (let index = rawEnd; index > start; index -= 1) {
    if (text[index - 1] === "\n") return index;
  }
  const lowerBound = start + Math.floor((rawEnd - start) * 0.72);
  const preferredBreak = /[\n。！？；，]/;
  for (let index = rawEnd; index > lowerBound; index -= 1) {
    if (preferredBreak.test(text[index - 1])) return avoidSplitMarker(text, start, index);
  }
  return avoidSplitMarker(text, start, rawEnd);
};

function avoidSplitMarker(text, start, end) {
  for (const marker of text.slice(start).matchAll(/==(?:\{(?:yellow|pink|green|blue|red)\})?(?:(?!==)[^\n])+==/g)) {
    const opener = start + marker.index;
    if (opener >= end) break;
    if (opener < end && end < opener + marker[0].length) {
      // A short marked phrase travels intact to the next page. If it is
      // longer than a whole page, still make progress with the normal split.
      return opener > start ? opener : end;
    }
  }
  return end;
}

const takeTextForHeight = (text, start, availableHeight, measureText) => {
  // Prefer semantic Markdown line boundaries directly. Searching arbitrary
  // character prefixes first repeatedly parses broken headings/lists and
  // forces almost twice as many synchronous browser layouts on long fields.
  const lineEnds = [];
  for (let index = text.indexOf("\n", start); index >= 0; index = text.indexOf("\n", index + 1)) lineEnds.push(index + 1);
  if (lineEnds.at(-1) !== text.length) lineEnds.push(text.length);
  if (lineEnds.length > 1) {
    let lowLine = 0;
    let highLine = lineEnds.length - 1;
    let bestLine = -1;
    while (lowLine <= highLine) {
      const middle = Math.floor((lowLine + highLine) / 2);
      if (measureText(text.slice(start, lineEnds[middle])) <= availableHeight) {
        bestLine = middle; lowLine = middle + 1;
      } else highLine = middle - 1;
    }
    if (bestLine >= 0) return lineEnds[bestLine];
  }
  let low = start + 1;
  // A single line may exceed a page. Fall back within that line so pagination
  // always makes progress without splitting unrelated following structures.
  let high = lineEnds[0] ?? text.length;
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

export function paginateLessonPlan(plan, measurements = {}, presentationMaterial = {}) {
  const pageHeight = measurements.pageHeight ?? contentHeight;
  const measureBasics = measurements.measureBasics ?? (() => Math.max(
    estimateTextHeight(plan.unit),
    estimateTextHeight(plan.period),
    estimateTextHeight(plan.totalPeriods),
  ));
  const measureTopic = measurements.measureTopic ?? (() => estimateTextHeight(plan.topic));
  const measureSection = measurements.measureSection
    ?? ((section, value) => estimateTextHeight(value));
  const measurePresentation = measurements.measurePresentation ?? (() => 58);
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

  placeMeasuredRow({
    key: "presentation-material",
    kind: "presentation",
    sectionId: "presentation",
    presentation: presentationMaterial.presentation ?? null,
    state: presentationMaterial.state ?? "idle",
  }, measurePresentation(presentationMaterial));

  return pages.filter((page) => page.length);
}
