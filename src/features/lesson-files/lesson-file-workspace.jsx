import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowLeft, Check, PanelLeft, Redo2, Sparkles, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  createLessonPlanDraft,
  lessonPlanSections,
} from "@/features/lesson-files/data";
import { normalizeEditableText } from "@/features/lesson-files/editable-text";
import {
  createLessonHistory,
  recordLessonChange,
  redoLessonChange,
  undoLessonChange,
} from "@/features/lesson-files/history";
import { paginateLessonPlan } from "@/features/lesson-files/pagination";
import { pickActiveLessonSection } from "@/features/lesson-files/scroll-state";

gsap.registerPlugin(useGSAP);

const LessonAgentPanel = lazy(() => import("@/features/assistant/lesson-agent-panel").then((module) => ({
  default: module.LessonAgentPanel,
})));

const paginationInputDelay = 150;

function classifyInput(field, inputType) {
  return {
    field,
    kind: inputType === "insertFromPaste" || inputType === "insertFromDrop"
      ? "paste"
      : "typing",
  };
}

function insertPlainText(element, text) {
  if (element instanceof HTMLTextAreaElement) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    element.setRangeText(normalizeEditableText(text), start, end, "end");
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertFromPaste",
      data: text,
    }));
    return;
  }

  const selection = window.getSelection();
  if (!selection) return;
  let range = selection.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !element.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
  }

  range.deleteContents();
  const textNode = document.createTextNode(normalizeEditableText(text));
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  element.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertFromPaste",
    data: text,
  }));
}

function LessonTableColumns() {
  return (
    <colgroup>
      <col className="lesson-col-label" />
      <col className="lesson-col-content" />
      <col className="lesson-col-meta-label" />
      <col className="lesson-col-meta" />
      <col className="lesson-col-meta-label" />
      <col className="lesson-col-meta" />
    </colgroup>
  );
}

function PaginationMeasure({ plan, measureRef }) {
  return (
    <div className="lesson-pagination-measure" ref={measureRef} aria-hidden="true">
      <div className="lesson-pagination-page-box" />

      <table className="lesson-plan-table lesson-pagination-full-table">
        <LessonTableColumns />
        <tbody>
          <tr className="lesson-row-basics" data-measure-kind="basics">
            <th scope="row">单元</th>
            <td><div className="lesson-editable">{plan.unit}</div></td>
            <th scope="row">课时</th>
            <td><div className="lesson-editable">{plan.period}</div></td>
            <th scope="row">总课时</th>
            <td><div className="lesson-editable">{plan.totalPeriods}</div></td>
          </tr>
          <tr className="lesson-row-topic" data-measure-kind="topic">
            <th scope="row">课题</th>
            <td colSpan={5}><div className="lesson-editable">{plan.topic}</div></td>
          </tr>
          {lessonPlanSections.filter((section) => section.id !== "basics").map((section) => (
            <tr
              className={`lesson-row-${section.id}`}
              data-measure-section={section.id}
              key={section.id}
            >
              <th scope="row"><span>{section.label}</span></th>
              <td colSpan={5}><div className="lesson-editable">{plan[section.id]}</div></td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="lesson-plan-table lesson-pagination-probe-table">
        <LessonTableColumns />
        <tbody>
          <tr data-measure-probe>
            <th scope="row"><span data-measure-probe-label /></th>
            <td colSpan={5}><div className="lesson-editable" data-measure-probe-content /></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function createDomMeasurements(measureRoot, plan) {
  const pageBox = measureRoot.querySelector(".lesson-pagination-page-box");
  const basicsRow = measureRoot.querySelector('[data-measure-kind="basics"]');
  const topicRow = measureRoot.querySelector('[data-measure-kind="topic"]');
  const probeRow = measureRoot.querySelector("[data-measure-probe]");
  const probeLabel = measureRoot.querySelector("[data-measure-probe-label]");
  const probeContent = measureRoot.querySelector("[data-measure-probe-content]");
  if (!pageBox || !basicsRow || !topicRow || !probeRow || !probeLabel || !probeContent) {
    return null;
  }

  const cache = new Map();
  measureRoot.querySelectorAll("[data-measure-section]").forEach((row) => {
    const sectionId = row.dataset.measureSection;
    cache.set(`${sectionId}:0:${String(plan[sectionId] ?? "")}`, row.getBoundingClientRect().height);
  });

  return {
    pageHeight: pageBox.getBoundingClientRect().height,
    measureBasics: () => basicsRow.getBoundingClientRect().height,
    measureTopic: () => topicRow.getBoundingClientRect().height,
    measureSection: (section, value, continued) => {
      const text = String(value ?? "");
      const cacheKey = `${section.id}:${continued ? 1 : 0}:${text}`;
      const cachedHeight = cache.get(cacheKey);
      if (cachedHeight != null) return cachedHeight;

      probeRow.className = `lesson-row-${section.id}${continued ? " is-continuation" : ""}`;
      probeLabel.textContent = `${section.label}${continued ? "（续）" : ""}`;
      probeContent.textContent = text;
      const height = probeRow.getBoundingClientRect().height;
      cache.set(cacheKey, height);
      return height;
    },
  };
}

function pageLayoutSignature(pages) {
  return pages.map((page) => page.map((entry) => (
    `${entry.key}:${entry.start ?? ""}:${entry.end ?? ""}:${entry.value ?? ""}`
  )).join("|")).join("||");
}

function readCaretOffset(element) {
  if (element instanceof HTMLTextAreaElement) {
    return element.selectionStart ?? element.value.length;
  }

  const selection = window.getSelection();
  if (!selection?.rangeCount || !element.contains(selection.focusNode)) {
    return normalizeEditableText(element.innerText).length;
  }

  const marker = document.createTextNode("\uE000");
  const markerRange = selection.getRangeAt(0).cloneRange();
  markerRange.collapse(false);
  try {
    markerRange.insertNode(marker);
    const textWithMarker = normalizeEditableText(element.innerText);
    const offset = textWithMarker.indexOf(marker.textContent);
    const restoredRange = document.createRange();
    restoredRange.setStartBefore(marker);
    restoredRange.collapse(true);
    marker.remove();
    selection.removeAllRanges();
    selection.addRange(restoredRange);
    return offset >= 0 ? offset : normalizeEditableText(element.innerText).length;
  } catch {
    marker.remove();
    return normalizeEditableText(element.innerText).length;
  }
}

function restoreCaret(element, offset) {
  if (element instanceof HTMLTextAreaElement) {
    const nextOffset = Math.min(Math.max(0, offset), element.value.length);
    element.focus({ preventScroll: true });
    element.setSelectionRange(nextOffset, nextOffset);
    return;
  }

  const selection = window.getSelection();
  if (!selection) return;

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode();
  while (node) {
    if (remaining <= node.textContent.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      element.focus({ preventScroll: true });
      return;
    }
    remaining -= node.textContent.length;
    node = walker.nextNode();
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  element.focus({ preventScroll: true });
}

function captureActiveCaret(root) {
  const editor = document.activeElement;
  if (!editor?.classList.contains("lesson-editable") || !root?.contains(editor)) return null;
  return {
    field: editor.dataset.field,
    offset: Number(editor.dataset.start ?? 0) + readCaretOffset(editor),
  };
}

function readSelectionOffset(editor, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setEnd(container, offset);
  return normalizeEditableText(range.toString()).length;
}

function captureLessonSelection(scrollRoot) {
  const activeEditor = document.activeElement;
  if (activeEditor instanceof HTMLTextAreaElement
    && activeEditor.classList.contains("lesson-editable")
    && scrollRoot.contains(activeEditor)) {
    const start = activeEditor.selectionStart ?? 0;
    const end = activeEditor.selectionEnd ?? start;
    if (start === end) return null;
    const fragmentStart = Number(activeEditor.dataset.start ?? 0);
    return {
      field: activeEditor.dataset.field,
      start: fragmentStart + start,
      end: fragmentStart + end,
      text: activeEditor.value.slice(start, end),
    };
  }

  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer
    : range.startContainer.parentElement;
  const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
    ? range.endContainer
    : range.endContainer.parentElement;
  const startEditor = startElement?.closest?.(".lesson-editable");
  const endEditor = endElement?.closest?.(".lesson-editable");
  if (!startEditor || startEditor !== endEditor || !scrollRoot.contains(startEditor)) return null;
  const text = normalizeEditableText(selection.toString());
  if (!text) return null;
  const fragmentStart = Number(startEditor.dataset.start ?? 0);
  return {
    field: startEditor.dataset.field,
    start: fragmentStart + readSelectionOffset(startEditor, range.startContainer, range.startOffset),
    end: fragmentStart + readSelectionOffset(startEditor, range.endContainer, range.endOffset),
    text,
  };
}

function EditableCell({
  value,
  onChange,
  label,
  multiline = false,
  onFocus,
  field,
  start,
  end,
  syncVersion,
  onHistoryAction,
}) {
  const editorRef = useRef(null);
  const composingRef = useRef(false);
  const inputTimerRef = useRef(null);
  const latestElementRef = useRef(null);
  const latestTransactionRef = useRef(classifyInput(field, "insertText"));
  const lastSyncVersionRef = useRef(syncVersion);
  const publishedValueRef = useRef(normalizeEditableText(value));
  const readValue = (element) => normalizeEditableText(element.value);
  const publishChange = (element, transaction = latestTransactionRef.current) => {
    const nextValue = readValue(element);
    const previousValue = publishedValueRef.current;
    if (nextValue === previousValue) return;
    publishedValueRef.current = nextValue;
    onChange(nextValue, readCaretOffset(element), previousValue, transaction);
  };
  const flushChange = (element = latestElementRef.current) => {
    window.clearTimeout(inputTimerRef.current);
    inputTimerRef.current = null;
    if (element) publishChange(element);
  };
  const scheduleChange = (element, transaction) => {
    latestElementRef.current = element;
    latestTransactionRef.current = transaction;
    window.clearTimeout(inputTimerRef.current);
    inputTimerRef.current = window.setTimeout(() => flushChange(element), paginationInputDelay);
  };

  useLayoutEffect(() => {
    const nextValue = normalizeEditableText(value);
    const editor = editorRef.current;
    const forceSync = lastSyncVersionRef.current !== syncVersion;
    lastSyncVersionRef.current = syncVersion;
    publishedValueRef.current = nextValue;
    if (
      editor
      && (forceSync || document.activeElement !== editor)
      && normalizeEditableText(editor.value) !== nextValue
    ) {
      editor.value = nextValue;
    }
  }, [syncVersion, value]);

  useEffect(() => () => window.clearTimeout(inputTimerRef.current), []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return undefined;
    const flushPendingInput = () => flushChange(editor);
    editor.addEventListener("lessonup:flush-edit", flushPendingInput);
    return () => editor.removeEventListener("lessonup:flush-edit", flushPendingInput);
  });

  return (
    <textarea
      className="lesson-editable"
      ref={editorRef}
      aria-label={label}
      aria-multiline={multiline}
      rows={1}
      data-field={field}
      data-start={start}
      data-end={end}
      onBlur={(event) => {
        composingRef.current = false;
        flushChange(event.currentTarget);
      }}
      onCompositionStart={() => {
        composingRef.current = true;
        window.clearTimeout(inputTimerRef.current);
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        latestTransactionRef.current = classifyInput(field, "insertCompositionText");
        flushChange(event.currentTarget);
      }}
      onFocus={onFocus}
      onBeforeInput={(event) => {
        const inputType = event.nativeEvent.inputType;
        if (inputType !== "historyUndo" && inputType !== "historyRedo") return;
        event.preventDefault();
        flushChange(event.currentTarget);
        onHistoryAction(inputType === "historyUndo" ? "undo" : "redo");
      }}
      onInput={(event) => {
        if (!composingRef.current) {
          scheduleChange(
            event.currentTarget,
            classifyInput(field, event.nativeEvent.inputType),
          );
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        insertPlainText(event.currentTarget, event.clipboardData.getData("text/plain"));
      }}
    />
  );
}

function BasicsRow({ plan, onChange, onFocus, syncVersion, onHistoryAction }) {
  return (
    <tr
      id="lesson-section-basics"
      data-lesson-section="basics"
      className="lesson-row-basics"
    >
      <th scope="row">单元</th>
      <td>
        <EditableCell
          value={plan.unit}
          onChange={(...change) => onChange("unit", ...change)}
          onFocus={onFocus}
          field="unit"
          syncVersion={syncVersion}
          onHistoryAction={onHistoryAction}
          label="单元"
        />
      </td>
      <th scope="row">课时</th>
      <td>
        <EditableCell
          value={plan.period}
          onChange={(...change) => onChange("period", ...change)}
          onFocus={onFocus}
          field="period"
          syncVersion={syncVersion}
          onHistoryAction={onHistoryAction}
          label="课时"
        />
      </td>
      <th scope="row">总课时</th>
      <td>
        <EditableCell
          value={plan.totalPeriods}
          onChange={(...change) => onChange("totalPeriods", ...change)}
          onFocus={onFocus}
          field="totalPeriods"
          syncVersion={syncVersion}
          onHistoryAction={onHistoryAction}
          label="总课时"
        />
      </td>
    </tr>
  );
}

function SectionRow({ entry, onChange, onFocus, syncVersion, onHistoryAction }) {
  const sectionId = entry.sectionId;
  return (
    <tr
      id={entry.continued ? undefined : `lesson-section-${sectionId}`}
      data-lesson-section={sectionId}
      className={`lesson-row-${sectionId} ${entry.continued ? "is-continuation" : ""}`}
    >
      <th scope="row">
        <span>{entry.label}{entry.continued ? "（续）" : ""}</span>
      </th>
      <td colSpan={5}>
        <EditableCell
          value={entry.value}
          onChange={(value, caretOffset, previousValue, transaction) => (
            onChange(entry, value, caretOffset, previousValue, transaction)
          )}
          onFocus={() => onFocus(sectionId)}
          field={entry.field}
          start={entry.start}
          end={entry.end}
          syncVersion={syncVersion}
          onHistoryAction={onHistoryAction}
          multiline
          label={`${entry.label}${entry.continued ? "续页" : ""}`}
        />
      </td>
    </tr>
  );
}

export function LessonFileWorkspace({ notebook, file, originRect, onSave, onAgentVersionCommitted, onClose }) {
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const firstSheetRef = useRef(null);
  const closingRef = useRef(false);
  const openingTimelineRef = useRef(null);
  const sectionScrollRef = useRef(null);
  const anchorScrollActiveRef = useRef(false);
  const syncActiveSectionRef = useRef(() => {});
  const saveTimerRef = useRef(null);
  const measureRef = useRef(null);
  const onSaveRef = useRef(onSave);
  const onAgentVersionCommittedRef = useRef(onAgentVersionCommitted);
  const planRef = useRef(null);
  const dirtyPlanRef = useRef(null);
  const pendingSaveSourceRef = useRef("manual");
  const pendingSaveDataRef = useRef(null);
  const pendingAgentCommitRef = useRef(null);
  const saveInFlightRef = useRef(Promise.resolve());
  const persistPendingSaveRef = useRef(() => Promise.resolve());
  const pendingCaretRef = useRef(null);
  const undoActionRef = useRef(() => {});
  const redoActionRef = useRef(() => {});
  const initialPlan = useMemo(
    () => file.lessonPlan ?? createLessonPlanDraft(notebook, file),
    [file, notebook],
  );
  const [plan, setPlan] = useState(initialPlan);
  const historyRef = useRef(createLessonHistory(initialPlan));
  const [historyAvailability, setHistoryAvailability] = useState({
    canUndo: false,
    canRedo: false,
  });
  const [editorSyncVersion, setEditorSyncVersion] = useState(0);
  const [activeSection, setActiveSection] = useState("basics");
  const [saveStatus, setSaveStatus] = useState("已自动保存");
  const [selectionContext, setSelectionContext] = useState(null);
  const [documentVersion, setDocumentVersion] = useState(file.documentVersion ?? 0);
  const documentVersionRef = useRef(file.documentVersion ?? 0);
  const [mobileRail, setMobileRail] = useState(null);
  const [pages, setPages] = useState(() => paginateLessonPlan(initialPlan));
  onSaveRef.current = onSave;
  onAgentVersionCommittedRef.current = onAgentVersionCommitted;
  planRef.current = plan;
  documentVersionRef.current = documentVersion;

  useLayoutEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const activeSectionData = lessonPlanSections.find((section) => section.id === activeSection)
    ?? lessonPlanSections[0];

  const persistPendingSave = useCallback(() => {
    const pendingSave = pendingSaveDataRef.current;
    if (!pendingSave) return saveInFlightRef.current;
    pendingSaveDataRef.current = null;
    dirtyPlanRef.current = null;

    const save = saveInFlightRef.current.catch(() => null).then(async () => {
      if (pendingSave.source === "agent-local") {
        setSaveStatus("已自动保存");
        return null;
      }
      try {
        const saved = await onSaveRef.current(
          pendingSave.plan,
          pendingSave.pageCount,
          pendingSave.source,
          documentVersionRef.current,
        );
        if (saved?.documentVersion !== undefined) {
          documentVersionRef.current = saved.documentVersion;
          setDocumentVersion(saved.documentVersion);
        }
        setSaveStatus("已自动保存");
        return saved;
      } catch (error) {
        setSaveStatus("保存失败");
        throw error;
      }
    });
    saveInFlightRef.current = save;
    return save;
  }, []);
  persistPendingSaveRef.current = persistPendingSave;

  const measureAndPaginateRef = useRef(() => {});
  measureAndPaginateRef.current = () => {
    const measureRoot = measureRef.current;
    const currentPlan = planRef.current;
    if (!measureRoot || !currentPlan) return;
    const measurements = createDomMeasurements(measureRoot, currentPlan);
    if (!measurements) return;

    const measuredPages = paginateLessonPlan(currentPlan, measurements);
    setPages((currentPages) => (
      pageLayoutSignature(currentPages) === pageLayoutSignature(measuredPages)
        ? currentPages
        : measuredPages
    ));

    setEditorSyncVersion((version) => version + 1);

    const agentCommit = pendingAgentCommitRef.current;
    if (agentCommit?.plan === currentPlan) {
      pendingAgentCommitRef.current = null;
      Promise.resolve(onAgentVersionCommittedRef.current(
        currentPlan,
        agentCommit.documentVersion,
        measuredPages.length,
      )).catch(() => setSaveStatus("页数同步失败"));
    }

    if (dirtyPlanRef.current === currentPlan) {
      pendingSaveDataRef.current = {
        plan: currentPlan,
        pageCount: measuredPages.length,
        source: pendingSaveSourceRef.current,
      };
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        persistPendingSaveRef.current().catch(() => null);
      }, 320);
    }
  };

  const flushDocumentBeforeAgentRun = useCallback(async () => {
    const activeElement = document.activeElement;
    if (activeElement?.classList.contains("lesson-editable")) {
      activeElement.dispatchEvent(new CustomEvent("lessonup:flush-edit"));
    }
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    measureAndPaginateRef.current();
    window.clearTimeout(saveTimerRef.current);
    await persistPendingSaveRef.current();
    await saveInFlightRef.current;
    return { documentVersion: documentVersionRef.current };
  }, []);

  useLayoutEffect(() => {
    measureAndPaginateRef.current();
  }, [plan]);

  useLayoutEffect(() => {
    const pendingCaret = pendingCaretRef.current;
    if (!pendingCaret || !rootRef.current) return;
    const activeElement = document.activeElement;
    if (activeElement && activeElement !== document.body && !activeElement.classList.contains("lesson-editable")) {
      pendingCaretRef.current = null;
      return;
    }
    const editors = [...rootRef.current.querySelectorAll(
      `.lesson-sheet .lesson-editable[data-field="${pendingCaret.field}"]`,
    )];
    const target = editors.find((editor) => {
      const entryStart = Number(editor.dataset.start ?? 0);
      const entryEnd = Number(editor.dataset.end ?? Number.POSITIVE_INFINITY);
      return pendingCaret.offset >= entryStart && pendingCaret.offset <= entryEnd;
    }) ?? editors.at(-1);
    if (!target) return;

    const entryStart = Number(target.dataset.start ?? 0);
    restoreCaret(target, pendingCaret.offset - entryStart);
    pendingCaretRef.current = null;
  }, [editorSyncVersion, pages]);

  useEffect(() => {
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) measureAndPaginateRef.current();
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const scrollRoot = scrollRef.current;
    const root = rootRef.current;
    if (!scrollRoot || !root) return undefined;

    let frame = null;
    const updateActiveSection = () => {
      frame = null;
      if (anchorScrollActiveRef.current) return;
      const scrollRect = scrollRoot.getBoundingClientRect();
      const anchorTop = scrollRect.top + Math.min(140, scrollRect.height * 0.2);
      const sections = [...root.querySelectorAll("[data-lesson-section]")].map((section) => {
        const rect = section.getBoundingClientRect();
        return {
          id: section.dataset.lessonSection,
          top: rect.top,
          bottom: rect.bottom,
        };
      });
      const activeId = pickActiveLessonSection({
        sections,
        anchorTop,
        atStart: scrollRoot.scrollTop <= 1,
        atEnd: scrollRoot.scrollHeight - scrollRoot.clientHeight - scrollRoot.scrollTop <= 2,
      });
      if (activeId) setActiveSection(activeId);
    };

    const scheduleUpdate = () => {
      if (anchorScrollActiveRef.current || frame != null) return;
      frame = window.requestAnimationFrame(updateActiveSection);
    };

    const interruptAnchorScroll = () => {
      if (!sectionScrollRef.current) return;
      anchorScrollActiveRef.current = false;
      sectionScrollRef.current.kill();
      sectionScrollRef.current = null;
      scheduleUpdate();
    };

    syncActiveSectionRef.current = scheduleUpdate;
    scrollRoot.addEventListener("scroll", scheduleUpdate, { passive: true });
    scrollRoot.addEventListener("wheel", interruptAnchorScroll, { passive: true });
    scrollRoot.addEventListener("touchstart", interruptAnchorScroll, { passive: true });
    updateActiveSection();

    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      scrollRoot.removeEventListener("scroll", scheduleUpdate);
      scrollRoot.removeEventListener("wheel", interruptAnchorScroll);
      scrollRoot.removeEventListener("touchstart", interruptAnchorScroll);
      syncActiveSectionRef.current = () => {};
    };
  }, [pages]);

  useEffect(() => () => {
    window.clearTimeout(saveTimerRef.current);
    persistPendingSaveRef.current().catch(() => null);
  }, []);

  const { contextSafe } = useGSAP(() => {
    const root = rootRef.current;
    const firstSheet = firstSheetRef.current;
    const rails = root.querySelectorAll(".lesson-side-rail");
    const pageContent = root.querySelectorAll(".lesson-sheet-content");
    const secondarySheets = [...root.querySelectorAll(".lesson-sheet")].slice(1);
    const preview = root.querySelector(".lesson-sheet-preview");
    const finalRect = firstSheet.getBoundingClientRect();
    const sourceRect = originRect ?? finalRect;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduceMotion ? 0 : 0.72;
    const styles = getComputedStyle(document.documentElement);
    const background = styles.getPropertyValue("--app-background").trim();
    const clearBackground = styles.getPropertyValue("--app-background-clear").trim();

    if (rails.length) gsap.set(rails, { autoAlpha: 0 });
    if (pageContent.length) gsap.set(pageContent, { autoAlpha: 0 });
    if (secondarySheets.length) gsap.set(secondarySheets, { autoAlpha: 0, y: 24 });
    if (preview) gsap.set(preview, { autoAlpha: 1 });

    const timeline = gsap.timeline({
      defaults: { ease: "power3.inOut" },
      onComplete: () => { openingTimelineRef.current = null; },
    });
    openingTimelineRef.current = timeline;
    timeline
      .addLabel("open", 0)
      .fromTo(root, { backgroundColor: clearBackground }, {
        backgroundColor: background,
        duration: reduceMotion ? 0 : 0.34,
      }, "open")
      .fromTo(firstSheet, {
        position: "fixed",
        top: sourceRect.top,
        left: sourceRect.left,
        width: sourceRect.width,
        height: sourceRect.height,
        zIndex: 6,
      }, {
        top: finalRect.top,
        left: finalRect.left,
        width: finalRect.width,
        height: finalRect.height,
        duration,
        clearProps: "position,top,left,width,height,zIndex",
      }, "open");
    if (preview) timeline.to(preview, { autoAlpha: 0, duration: reduceMotion ? 0 : 0.2 }, duration * 0.46);
    if (pageContent.length) timeline.to(pageContent, { autoAlpha: 1, duration: reduceMotion ? 0 : 0.28 }, duration * 0.5);
    if (secondarySheets.length) timeline.to(secondarySheets, {
        y: 0,
        autoAlpha: 1,
        stagger: reduceMotion ? 0 : 0.05,
        duration: reduceMotion ? 0 : 0.34,
      }, duration * 0.56);
    if (rails.length) timeline.fromTo(rails, {
        x: (index) => index === 0 ? -16 : 16,
        autoAlpha: 0,
      }, {
        x: 0,
        autoAlpha: 1,
        stagger: reduceMotion ? 0 : 0.05,
        duration: reduceMotion ? 0 : 0.34,
      }, duration * 0.62);
  }, { scope: rootRef });

  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add("(max-width: 680px)", () => {
      const outline = rootRef.current.querySelector(".lesson-outline-rail");
      const assistant = rootRef.current.querySelector(".lesson-assistant-rail");
      if (outline) gsap.to(outline, {
        xPercent: mobileRail === "outline" ? 0 : -100,
        autoAlpha: mobileRail === "outline" ? 1 : 0,
        pointerEvents: mobileRail === "outline" ? "auto" : "none",
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.3,
        ease: "power3.inOut",
        overwrite: "auto",
      });
      if (assistant) gsap.to(assistant, {
        xPercent: mobileRail === "assistant" ? 0 : 100,
        autoAlpha: mobileRail === "assistant" ? 1 : 0,
        pointerEvents: mobileRail === "assistant" ? "auto" : "none",
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.3,
        ease: "power3.inOut",
        overwrite: "auto",
      });
    });
    return () => media.revert();
  }, { dependencies: [mobileRail], scope: rootRef, revertOnUpdate: true });

  const updateHistoryAvailability = (history) => {
    setHistoryAvailability({
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    });
  };

  const persistPlan = (nextPlan, pendingCaret = null, transaction = null) => {
    const nextHistory = recordLessonChange(
      historyRef.current,
      nextPlan,
      transaction ?? { field: "document", kind: "typing" },
    );
    historyRef.current = nextHistory;
    updateHistoryAvailability(nextHistory);
    planRef.current = nextPlan;
    dirtyPlanRef.current = nextPlan;
    pendingSaveSourceRef.current = transaction?.kind === "agent" ? "agent-local" : "manual";
    pendingCaretRef.current = pendingCaret;
    setSaveStatus("正在保存…");
    setPlan(nextPlan);
  };

  const commitField = (field, value, _caretOffset, _previousValue, transaction) => {
    const currentPlan = planRef.current;
    if (String(currentPlan[field] ?? "") === value) return;
    persistPlan(
      { ...currentPlan, [field]: value },
      null,
      transaction ?? { field, kind: "typing" },
    );
  };

  const commitSegment = (entry, value, caretOffset, previousValue, transaction) => {
    const currentPlan = planRef.current;
    const source = String(currentPlan[entry.field] ?? "");
    const replacedEnd = entry.start + previousValue.length;
    const nextValue = `${source.slice(0, entry.start)}${value}${source.slice(replacedEnd)}`;
    if (source === nextValue) return;
    persistPlan(
      { ...currentPlan, [entry.field]: nextValue },
      { field: entry.field, offset: entry.start + caretOffset },
      transaction ?? { field: entry.field, kind: "typing" },
    );
  };

  const applyHistory = (direction) => {
    const currentHistory = historyRef.current;
    const nextHistory = direction === "undo"
      ? undoLessonChange(currentHistory)
      : redoLessonChange(currentHistory);
    if (nextHistory === currentHistory) return;

    const activeCaret = captureActiveCaret(rootRef.current);
    historyRef.current = nextHistory;
    updateHistoryAvailability(nextHistory);
    planRef.current = nextHistory.present;
    dirtyPlanRef.current = nextHistory.present;
    pendingSaveSourceRef.current = "undo";
    pendingCaretRef.current = activeCaret;
    setSaveStatus("正在保存…");
    setPlan(nextHistory.present);
  };

  undoActionRef.current = () => applyHistory("undo");
  redoActionRef.current = () => applyHistory("redo");

  const handleHistoryAction = (direction) => {
    if (direction === "undo") undoActionRef.current();
    else redoActionRef.current();
  };

  useEffect(() => {
    const handleHistoryShortcut = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const activeElement = document.activeElement;
      const isOtherEditable = activeElement?.matches("input, textarea, [contenteditable='true']")
        && !activeElement.classList.contains("lesson-editable");
      if (isOtherEditable) return;
      const key = event.key.toLowerCase();
      const wantsUndo = key === "z" && !event.shiftKey;
      const wantsRedo = (key === "z" && event.shiftKey) || key === "y";
      if (!wantsUndo && !wantsRedo) return;

      event.preventDefault();
      activeElement?.dispatchEvent(new CustomEvent("lessonup:flush-edit"));
      if (wantsUndo) undoActionRef.current();
      else redoActionRef.current();
    };
    document.addEventListener("keydown", handleHistoryShortcut, true);
    return () => document.removeEventListener("keydown", handleHistoryShortcut, true);
  }, []);

  const scrollToSection = contextSafe((sectionId) => {
    const scrollRoot = scrollRef.current;
    const target = rootRef.current.querySelector(`#lesson-section-${sectionId}`);
    if (!scrollRoot || !target) return;
    const targetTop = target.getBoundingClientRect().top
      - scrollRoot.getBoundingClientRect().top
      + scrollRoot.scrollTop
      - 48;
    sectionScrollRef.current?.kill();
    anchorScrollActiveRef.current = true;
    setActiveSection(sectionId);
    setMobileRail(null);
    sectionScrollRef.current = gsap.to(scrollRoot, {
      scrollTop: Math.max(0, targetTop),
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.48,
      ease: "power3.out",
      overwrite: "auto",
      onComplete: () => {
        sectionScrollRef.current = null;
        anchorScrollActiveRef.current = false;
        setActiveSection(sectionId);
      },
      onInterrupt: () => {
        sectionScrollRef.current = null;
        anchorScrollActiveRef.current = false;
        syncActiveSectionRef.current();
      },
    });
  });

  const captureSelection = () => {
    const selection = window.getSelection();
    const anchorNode = selection?.anchorNode;
    if (!anchorNode || !scrollRef.current?.contains(anchorNode)) return;
    const section = anchorNode.parentElement?.closest("[data-lesson-section]");
    if (section) setActiveSection(section.dataset.lessonSection);
    const context = captureLessonSelection(scrollRef.current);
    if (context) setSelectionContext(context);
  };

  const applyCanonicalAgentDocument = useCallback((canonicalFile) => {
    if (canonicalFile.id !== file.id) return;
    if (canonicalFile.documentVersion < documentVersionRef.current) return;
    if (
      canonicalFile.documentVersion === documentVersionRef.current
      && canonicalFile.document === planRef.current
    ) return;
    documentVersionRef.current = canonicalFile.documentVersion;
    setDocumentVersion(canonicalFile.documentVersion);
    pendingAgentCommitRef.current = {
      plan: canonicalFile.document,
      documentVersion: canonicalFile.documentVersion,
    };
    persistPlan(
      canonicalFile.document,
      null,
      { field: "document", kind: "agent" },
    );
  }, [file.id]);

  const closeWorkspace = contextSafe(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    openingTimelineRef.current?.kill();
    openingTimelineRef.current = null;
    const scrollRoot = scrollRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const finishClose = () => {
      const root = rootRef.current;
      const firstSheet = firstSheetRef.current;
      const rails = root.querySelectorAll(".lesson-side-rail");
      const pageContent = root.querySelectorAll(".lesson-sheet-content");
      const secondarySheets = [...root.querySelectorAll(".lesson-sheet")].slice(1);
      const preview = root.querySelector(".lesson-sheet-preview");
      const currentRect = firstSheet.getBoundingClientRect();
      const source = document.querySelector(`.folder-paper[data-file-id="${file.id}"]`);
      const targetRect = source?.getBoundingClientRect() ?? originRect ?? currentRect;
      const duration = reduceMotion ? 0 : 0.62;
      const clearBackground = getComputedStyle(document.documentElement)
        .getPropertyValue("--app-background-clear")
        .trim();

      gsap.set(firstSheet, {
        position: "fixed",
        top: currentRect.top,
        left: currentRect.left,
        width: currentRect.width,
        height: currentRect.height,
        zIndex: 6,
      });

      const timeline = gsap.timeline({ defaults: { ease: "power3.inOut" }, onComplete: onClose })
        .addLabel("close", 0);
      if (rails.length) timeline.to(rails, {
          autoAlpha: 0,
          x: (index) => index === 0 ? -12 : 12,
          duration: reduceMotion ? 0 : 0.22,
        }, "close");
      if (secondarySheets.length) timeline.to(secondarySheets, {
          autoAlpha: 0,
          y: 20,
          duration: reduceMotion ? 0 : 0.22,
        }, "close");
      if (pageContent.length) timeline.to(pageContent, { autoAlpha: 0, duration: reduceMotion ? 0 : 0.18 }, "close");
      if (preview) timeline.to(preview, { autoAlpha: 1, duration: reduceMotion ? 0 : 0.2 }, "close+=0.08");
      timeline.to(firstSheet, {
          top: targetRect.top,
          left: targetRect.left,
          width: targetRect.width,
          height: targetRect.height,
          duration,
        }, "close+=0.08")
        .to(root, {
          backgroundColor: clearBackground,
          duration: reduceMotion ? 0 : 0.28,
        }, `close+=${duration * 0.62}`);
    };

    if (!scrollRoot.scrollTop || reduceMotion) {
      scrollRoot.scrollTop = 0;
      finishClose();
      return;
    }

    gsap.to(scrollRoot, {
      scrollTop: 0,
      duration: 0.34,
      ease: "power3.inOut",
      onComplete: finishClose,
    });
  });

  return (
    <section
      className="lesson-file-workspace"
      ref={rootRef}
      aria-label={`${file.title}备课文件`}
      tabIndex={-1}
    >
      <PaginationMeasure plan={plan} measureRef={measureRef} />
      <div className="lesson-mobile-switcher" aria-label="详情页工具">
        <Button
          variant="outline"
          size="icon-sm"
          type="button"
          aria-label="显示教案目录"
          aria-pressed={mobileRail === "outline"}
          aria-controls="lesson-outline-panel"
          onClick={() => setMobileRail((current) => current === "outline" ? null : "outline")}
        >
          <PanelLeft />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          type="button"
          aria-label="显示备课助手"
          aria-pressed={mobileRail === "assistant"}
          aria-controls="lesson-assistant-panel"
          onClick={() => setMobileRail((current) => current === "assistant" ? null : "assistant")}
        >
          <Sparkles />
        </Button>
      </div>

      <aside id="lesson-outline-panel" className={`lesson-side-rail lesson-outline-rail ${mobileRail === "outline" ? "is-mobile-open" : ""}`}>
        <div className="lesson-outline-header">
          <Button variant="ghost" size="sm" type="button" onClick={closeWorkspace}>
            <ArrowLeft data-icon="inline-start" /> 返回备课本
          </Button>
          <div className="lesson-file-identity">
            <span>{notebook.subject} · {notebook.className}</span>
            <h1>{file.title}</h1>
            <p><Check aria-hidden="true" /> {saveStatus}</p>
            <div className="lesson-history-actions" aria-label="编辑历史">
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label="撤销"
                aria-keyshortcuts="Meta+Z Control+Z"
                title="撤销"
                disabled={!historyAvailability.canUndo}
                onClick={() => handleHistoryAction("undo")}
              >
                <Undo2 />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label="重做"
                aria-keyshortcuts="Meta+Shift+Z Control+Y"
                title="重做"
                disabled={!historyAvailability.canRedo}
                onClick={() => handleHistoryAction("redo")}
              >
                <Redo2 />
              </Button>
            </div>
          </div>
        </div>

        <nav className="lesson-anchor-nav" aria-label="教案章节">
          {lessonPlanSections.map((section) => (
            <Button
              className={`lesson-anchor ${activeSection === section.id ? "is-active" : ""}`}
              variant="ghost"
              size="sm"
              data-tone={section.tone}
              type="button"
              aria-current={activeSection === section.id ? "location" : undefined}
              onClick={() => scrollToSection(section.id)}
              key={section.id}
            >
              <span aria-hidden="true" />
              {section.label}
            </Button>
          ))}
        </nav>
      </aside>

      <main
        className="lesson-document-scroll"
        ref={scrollRef}
        aria-label="A4教案编辑区"
        onPointerUp={captureSelection}
        onKeyUp={captureSelection}
      >
        <p className="lesson-mobile-document-hint">左右滑动查看完整教案</p>
        <div className="lesson-document-pages">
          {pages.map((pageEntries, pageIndex) => (
            <article
              className="lesson-sheet"
              data-page-index={pageIndex}
              ref={pageIndex === 0 ? firstSheetRef : undefined}
              key={`page-${pageIndex}`}
            >
              {pageIndex === 0 && (
                <div className="lesson-sheet-preview" aria-hidden="true">
                  <div className="lesson-sheet-preview-image">
                    <img src={file.image} alt="" />
                    <span>{file.type}</span>
                  </div>
                  <div className="lesson-sheet-preview-copy">
                    <h2>{file.title}</h2>
                    <p>{pages.length} 页 · 更新于 {file.updated}</p>
                  </div>
                </div>
              )}

              <div className="lesson-sheet-content">
                <table className="lesson-plan-table">
                  <LessonTableColumns />
                  <tbody>
                    {pageEntries.map((entry) => {
                      if (entry.kind === "basics") {
                        return (
                          <BasicsRow
                            plan={plan}
                            onChange={commitField}
                            onFocus={() => setActiveSection("basics")}
                            syncVersion={editorSyncVersion}
                            onHistoryAction={handleHistoryAction}
                            key={entry.key}
                          />
                        );
                      }

                      if (entry.kind === "topic") {
                        return (
                          <tr className="lesson-row-topic" key={entry.key}>
                            <th scope="row">课题</th>
                            <td colSpan={5}>
                              <EditableCell
                                value={plan.topic}
                                onChange={(...change) => commitField("topic", ...change)}
                                onFocus={() => setActiveSection("basics")}
                                field="topic"
                                syncVersion={editorSyncVersion}
                                onHistoryAction={handleHistoryAction}
                                label="课题"
                              />
                            </td>
                          </tr>
                        );
                      }

                      return (
                        <SectionRow
                          entry={entry}
                          onChange={commitSegment}
                          onFocus={setActiveSection}
                          syncVersion={editorSyncVersion}
                          onHistoryAction={handleHistoryAction}
                          key={entry.key}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <span className="lesson-page-number" aria-label={`第${pageIndex + 1}页，共${pages.length}页`}>
                {pageIndex + 1} / {pages.length}
              </span>
            </article>
          ))}
        </div>
      </main>

      <aside id="lesson-assistant-panel" className={`lesson-side-rail lesson-assistant-rail ${mobileRail === "assistant" ? "is-mobile-open" : ""}`}>
        <Suspense fallback={<p className="lesson-agent-status">正在加载备课助手…</p>}>
          <LessonAgentPanel
            notebook={notebook}
            file={{ ...file, documentVersion }}
            activeSection={activeSection}
            activeSectionData={activeSectionData}
            selection={selectionContext}
            onClearSelection={() => setSelectionContext(null)}
            onCanonicalDocument={applyCanonicalAgentDocument}
            onBeforeRun={flushDocumentBeforeAgentRun}
            onNavigateToSection={scrollToSection}
          />
        </Suspense>
      </aside>
    </section>
  );
}
