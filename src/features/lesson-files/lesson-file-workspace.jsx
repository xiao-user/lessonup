import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowLeft, Check, PanelLeft, Redo2, Sparkles, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  createLessonPlanDraft,
  lessonPlanSections,
} from "@/features/lesson-files/data";
import {
  createLessonHistory,
  recordLessonChange,
  redoLessonChange,
  undoLessonChange,
} from "@/features/lesson-files/history";
import { paginateLessonPlan } from "@/features/lesson-files/pagination";
import { pickActiveLessonSection } from "@/features/lesson-files/scroll-state";
import { LessonPlanTiptapEditor, PresentationMaterialRow } from "@/features/lesson-files/lesson-plan-tiptap";
import { applyLessonFieldEdit } from "@/features/lesson-files/lesson-plan-tiptap-bridge";
import { renderLessonMarkdownHtml } from "@/features/lesson-files/lesson-markdown";
import { agentApi } from "@/lib/agent-api";

gsap.registerPlugin(useGSAP);

const LessonAgentPanel = lazy(() => import("@/features/assistant/lesson-agent-panel").then((module) => ({
  default: module.LessonAgentPanel,
})));

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

function MeasuredMarkdown({ value }) {
  return (
    <div
      className="lesson-tiptap-field"
      // This HTML is generated locally from the same trusted Markdown parser
      // and extension set as the field editor; no remote HTML enters here.
      dangerouslySetInnerHTML={{ __html: renderLessonMarkdownHtml(value) }}
    />
  );
}

function PaginationMeasure({ plan, presentationMaterial, measureRef }) {
  return (
    <div className="lesson-pagination-measure" ref={measureRef} aria-hidden="true">
      <div className="lesson-pagination-page-box" />

      <table className="lesson-plan-table lesson-pagination-full-table">
        <LessonTableColumns />
        <tbody>
          <tr className="lesson-row-basics" data-measure-kind="basics">
            <th scope="row">单元</th>
            <td><MeasuredMarkdown value={plan.unit} /></td>
            <th scope="row">课时</th>
            <td><MeasuredMarkdown value={plan.period} /></td>
            <th scope="row">总课时</th>
            <td><MeasuredMarkdown value={plan.totalPeriods} /></td>
          </tr>
          <tr className="lesson-row-topic" data-measure-kind="topic">
            <th scope="row">课题</th>
            <td colSpan={5}><MeasuredMarkdown value={plan.topic} /></td>
          </tr>
          {lessonPlanSections.filter((section) => section.id !== "basics").map((section) => (
            <tr
              className={`lesson-row-${section.id}`}
              data-measure-section={section.id}
              key={section.id}
            >
              <th scope="row"><span>{section.label}</span></th>
              <td colSpan={5}>
                <MeasuredMarkdown value={plan[section.id]} />
              </td>
            </tr>
          ))}
          <PresentationMaterialRow
            presentation={presentationMaterial.presentation}
            state={presentationMaterial.state}
            measure
          />
        </tbody>
      </table>

      <table className="lesson-plan-table lesson-pagination-probe-table">
        <LessonTableColumns />
        <tbody>
          <tr data-measure-probe>
            <th scope="row"><span data-measure-probe-label /></th>
            <td colSpan={5}><div className="lesson-tiptap-field" data-measure-probe-content /></td>
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
  const presentationRow = measureRoot.querySelector('[data-measure-kind="presentation"]');
  if (!pageBox || !basicsRow || !topicRow || !probeRow || !probeLabel || !probeContent || !presentationRow) {
    return null;
  }

  const cache = new Map();
  measureRoot.querySelectorAll("[data-measure-section]").forEach((row) => {
    const sectionId = row.dataset.measureSection;
    cache.set(`${sectionId}:0:${String(plan[sectionId] ?? "")}`, row.getBoundingClientRect().height);
  });

  return {
    // Collapsed table borders can accumulate a sub-pixel at the page edge.
    pageHeight: pageBox.getBoundingClientRect().height - 1,
    measureBasics: () => basicsRow.getBoundingClientRect().height,
    measureTopic: () => topicRow.getBoundingClientRect().height,
    measureSection: (section, value, continued) => {
      const text = String(value ?? "");
      const cacheKey = `${section.id}:${continued ? 1 : 0}:${text}`;
      const cachedHeight = cache.get(cacheKey);
      if (cachedHeight != null) return cachedHeight;

      probeRow.className = `lesson-row-${section.id}${continued ? " is-continuation" : ""}`;
      probeLabel.textContent = `${section.label}${continued ? "（续）" : ""}`;
      probeContent.innerHTML = renderLessonMarkdownHtml(text);
      const height = probeRow.getBoundingClientRect().height;
      cache.set(cacheKey, height);
      return height;
    },
    measurePresentation: () => presentationRow.getBoundingClientRect().height,
  };
}

function pageLayoutSignature(pages) {
  const fieldOccurrences = new Map();
  pages.flat().forEach((entry) => {
    if (!entry.field) return;
    fieldOccurrences.set(entry.field, (fieldOccurrences.get(entry.field) ?? 0) + 1);
  });
  return pages.map((page, pageIndex) => page.map((entry) => {
    const fieldIsFragmented = (fieldOccurrences.get(entry.field) ?? 0) > 1;
    const range = fieldIsFragmented ? `:${entry.start ?? ""}:${entry.end ?? ""}` : "";
    return `${pageIndex}:${entry.kind}:${entry.key}:${entry.sectionId}:${entry.continued ? 1 : 0}${range}`;
  }).join("|")).join("||");
}

function pageContentSignature(pages) {
  return pages.flat().map((entry) => (
    `${entry.key}:${entry.start ?? ""}:${entry.end ?? ""}:${entry.value ?? ""}`
  )).join("\u001e");
}

export function LessonFileWorkspace({ notebook, file, sourceElement, originRect, closeSignal = 0, onSave, onAgentVersionCommitted, onClose }) {
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const documentPagesRef = useRef(null);
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
  const failedSaveDataRef = useRef(null);
  const pendingAgentCommitRef = useRef(null);
  const saveInFlightRef = useRef(Promise.resolve());
  const persistPendingSaveRef = useRef(() => Promise.resolve());
  const tiptapBridgeRef = useRef(null);
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
  const [editorExternalRevision, setEditorExternalRevision] = useState(0);
  const [editorReadyRevision, setEditorReadyRevision] = useState(0);
  const [activeSection, setActiveSection] = useState("basics");
  const [previewSectionIndex, setPreviewSectionIndex] = useState(null);
  const [saveStatus, setSaveStatus] = useState("已自动保存");
  const [selectionContext, setSelectionContext] = useState(null);
  const [documentVersion, setDocumentVersion] = useState(file.documentVersion ?? 0);
  const documentVersionRef = useRef(file.documentVersion ?? 0);
  const [mobileRail, setMobileRail] = useState(null);
  const [presentationMaterial, setPresentationMaterial] = useState({
    presentation: null,
    state: "idle",
    error: "",
    confirmingDelete: false,
  });
  const [pages, setPages] = useState(() => paginateLessonPlan(initialPlan, {}, presentationMaterial));
  const pageLayoutSignatureRef = useRef(pageLayoutSignature(pages));
  const pageContentSignatureRef = useRef(pageContentSignature(pages));
  const [pageLayoutRevision, setPageLayoutRevision] = useState(0);
  const hasSpatialOrigin = Boolean(
    originRect?.width
    && originRect?.height
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [entryPending, setEntryPending] = useState(hasSpatialOrigin);
  onSaveRef.current = onSave;
  onAgentVersionCommittedRef.current = onAgentVersionCommitted;
  planRef.current = plan;
  documentVersionRef.current = documentVersion;

  const handleTiptapEditorReady = useCallback((bridge) => {
    tiptapBridgeRef.current = bridge;
    if (!bridge) return;
    setEditorReadyRevision((version) => version + 1);
  }, []);

  const setDocumentPagesRef = useCallback((element) => {
    documentPagesRef.current = element;
    firstSheetRef.current = element?.querySelector(".lesson-sheet-frame") ?? null;
  }, []);

  useLayoutEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const activeSectionData = lessonPlanSections.find((section) => section.id === activeSection)
    ?? lessonPlanSections[0];
  const activeSectionIndex = Math.max(
    0,
    lessonPlanSections.findIndex((section) => section.id === activeSectionData.id),
  );

  const persistPendingSave = useCallback(() => {
    const save = saveInFlightRef.current.catch(() => null).then(async () => {
      let lastSaved = null;
      while (failedSaveDataRef.current || pendingSaveDataRef.current) {
        const candidate = failedSaveDataRef.current ?? pendingSaveDataRef.current;
        const pendingSave = candidate.idempotencyKey
          ? candidate
          : {
              ...candidate,
              baseDocumentVersion: documentVersionRef.current,
              idempotencyKey: crypto.randomUUID(),
            };
        if (failedSaveDataRef.current === candidate) failedSaveDataRef.current = null;
        if (pendingSaveDataRef.current === candidate) pendingSaveDataRef.current = null;
        if (dirtyPlanRef.current === pendingSave.plan) dirtyPlanRef.current = null;

        if (pendingSave.source === "agent-local") {
          setSaveStatus("已自动保存");
          continue;
        }
        try {
          const saved = await onSaveRef.current(
            pendingSave.plan,
            pendingSave.pageCount,
            pendingSave.source,
            pendingSave.baseDocumentVersion,
            pendingSave.idempotencyKey,
          );
          if (saved?.documentVersion !== undefined) {
            documentVersionRef.current = saved.documentVersion;
            setDocumentVersion(saved.documentVersion);
          }
          setSaveStatus("已自动保存");
          lastSaved = saved;
        } catch (error) {
          failedSaveDataRef.current = pendingSave;
          setSaveStatus("保存失败");
          throw error;
        }
      }
      return lastSaved;
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

    const measuredPages = paginateLessonPlan(currentPlan, measurements, presentationMaterial);
    const measuredSignature = pageLayoutSignature(measuredPages);
    const measuredContentSignature = pageContentSignature(measuredPages);
    const layoutChanged = pageLayoutSignatureRef.current !== measuredSignature;
    if (layoutChanged || pageContentSignatureRef.current !== measuredContentSignature) {
      pageLayoutSignatureRef.current = measuredSignature;
      pageContentSignatureRef.current = measuredContentSignature;
      setPages(measuredPages);
      if (layoutChanged) setPageLayoutRevision((revision) => revision + 1);
    }

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
    tiptapBridgeRef.current?.flush();
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    measureAndPaginateRef.current();
    window.clearTimeout(saveTimerRef.current);
    await persistPendingSaveRef.current();
    await saveInFlightRef.current;
    return { documentVersion: documentVersionRef.current };
  }, []);

  const presentationErrorMessage = useCallback((error, action) => {
    if (error?.message === "stale_document") return "教案刚刚变化，请基于最新内容重新生成。";
    if (error?.message === "presentation_not_found") return "这份演示材料已经不存在，请刷新后重试。";
    if (action === "load") return "暂时无法读取演示材料状态，请刷新后重试。";
    return action === "delete" ? "未能删除演示材料，请重试。" : "未能生成演示材料，请重试。";
  }, []);

  const presentationGenerationErrorMessage = useCallback((generation) => {
    if (!generation || generation.status !== "failed") return "";
    if (generation.errorCode === "stale_document") return "教案已变化，请基于最新内容重新生成。";
    if (generation.errorCode === "presentation_compiling_failed") return "上次渲染未完成；请在对话中重新设计并确认。";
    if (generation.errorCode === "presentation_rendering_failed") return "Dashi 渲染失败，请重试。";
    if (generation.errorCode === "presentation_bundle_export_failed") return "演示已渲染，但导出交付文件时失败；请重试生成。";
    if (generation.errorCode === "presentation_storage_upload_failed") return "演示已渲染，但保存到资料库时失败；请重试生成。";
    if (generation.errorCode === "presentation_metadata_save_failed") return "演示文件已保存，但登记到教案时失败；请重试生成。";
    if (generation.errorCode === "presentation_generation_interrupted") return "生成被服务重启中断，请重新生成。";
    if (generation.errorCode === "presentation_cancelled") return "演示材料生成已取消。";
    return "演示材料生成失败，请重试。";
  }, []);

  const loadPresentationMaterial = useCallback(async () => {
    try {
      const [presentations, generation] = await Promise.all([
        agentApi.listClassroomPresentations(file.id),
        agentApi.getClassroomPresentationGeneration(file.id),
      ]);
      setPresentationMaterial((current) => ({
        ...current,
        presentation: presentations[0] ?? null,
        // The status belongs to the server-side generation, not this React
        // instance. This also lets an Agent-initiated render update A4.
        state: current.state === "deleting"
          ? "deleting"
          : generation?.status === "generating" ? "generating" : "idle",
        error: current.state === "deleting" ? current.error : presentationGenerationErrorMessage(generation),
        confirmingDelete: false,
      }));
    } catch (error) {
      setPresentationMaterial((current) => ({
        ...current,
        error: presentationErrorMessage(error, "load"),
      }));
    }
  }, [file.id, presentationErrorMessage, presentationGenerationErrorMessage]);

  useEffect(() => {
    void loadPresentationMaterial();
  }, [loadPresentationMaterial]);

  useEffect(() => {
    const refresh = window.setInterval(() => { void loadPresentationMaterial(); }, 1_500);
    return () => window.clearInterval(refresh);
  }, [loadPresentationMaterial]);

  const generatePresentationMaterial = useCallback(async () => {
    setPresentationMaterial((current) => ({ ...current, error: "", confirmingDelete: false }));
    try {
      await flushDocumentBeforeAgentRun();
      setMobileRail("assistant");
      window.dispatchEvent(new CustomEvent("lessonup:request-dashi-presentation", {
        detail: {
          prompt: presentationMaterial.presentation
            ? "请基于当前教案与课堂编导原则重新设计课堂演示，使用 Dashi 选择并校验真实版式，生成可直接渲染的完整逐页内容与版式供我确认；我确认后直接渲染，不再改写。"
            : "请基于当前教案与课堂编导原则设计课堂演示，使用 Dashi 选择并校验真实版式，生成可直接渲染的完整逐页内容与版式供我确认；我确认后直接渲染，不再改写。",
        },
      }));
    } catch (error) {
      setPresentationMaterial((current) => ({
        ...current,
        state: "idle",
        error: presentationErrorMessage(error, "generate"),
      }));
    }
  }, [flushDocumentBeforeAgentRun, presentationErrorMessage, presentationMaterial.presentation]);

  const previewPresentationMaterial = useCallback(async () => {
    const presentation = presentationMaterial.presentation;
    if (!presentation) return;
    const windowRef = window.open("about:blank", "_blank");
    if (!windowRef) {
      setPresentationMaterial((current) => ({ ...current, error: "浏览器阻止了预览窗口，请允许后重试。" }));
      return;
    }
    windowRef.opener = null;
    try {
      const access = await agentApi.createPresentationAccess(presentation.id);
      windowRef.location.replace(access.url);
    } catch (error) {
      windowRef.close();
      setPresentationMaterial((current) => ({ ...current, error: presentationErrorMessage(error, "preview") }));
    }
  }, [presentationErrorMessage, presentationMaterial.presentation]);

  const deletePresentationMaterial = useCallback(async () => {
    const presentation = presentationMaterial.presentation;
    if (!presentation) return;
    if (!presentationMaterial.confirmingDelete) {
      setPresentationMaterial((current) => ({ ...current, confirmingDelete: true, error: "" }));
      return;
    }
    setPresentationMaterial((current) => ({ ...current, state: "deleting", error: "" }));
    try {
      await agentApi.deleteClassroomPresentation(presentation.id);
      setPresentationMaterial({ presentation: null, state: "idle", error: "", confirmingDelete: false });
    } catch (error) {
      setPresentationMaterial((current) => ({
        ...current,
        state: "idle",
        error: presentationErrorMessage(error, "delete"),
      }));
    }
  }, [presentationErrorMessage, presentationMaterial.confirmingDelete, presentationMaterial.presentation]);

  useLayoutEffect(() => {
    measureAndPaginateRef.current();
  }, [plan, presentationMaterial]);

  useEffect(() => {
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) measureAndPaginateRef.current();
    });
    return () => { cancelled = true; };
  }, [editorReadyRevision]);

  useLayoutEffect(() => {
    const scrollRoot = scrollRef.current;
    const pagesRoot = documentPagesRef.current;
    if (!scrollRoot || !pagesRoot) return undefined;

    const updateScale = () => {
      const sheet = pagesRoot.querySelector(".lesson-sheet");
      if (!sheet) return;
      const scrollStyle = getComputedStyle(scrollRoot);
      const horizontalPadding = Number.parseFloat(scrollStyle.paddingLeft)
        + Number.parseFloat(scrollStyle.paddingRight);
      const availableWidth = Math.max(0, scrollRoot.clientWidth - horizontalPadding);
      const canonicalWidth = sheet.offsetWidth;
      const scale = canonicalWidth
        ? Math.min(1, Math.max(0.34, availableWidth / canonicalWidth))
        : 1;
      pagesRoot.style.setProperty("--lesson-paper-scale", String(scale));
      pagesRoot.style.setProperty("--lesson-paper-display-width", `${canonicalWidth * scale}px`);
      pagesRoot.style.setProperty("--lesson-paper-display-height", `${sheet.offsetHeight * scale}px`);
    };

    const observer = new ResizeObserver(updateScale);
    observer.observe(scrollRoot);
    updateScale();
    return () => observer.disconnect();
  }, [editorReadyRevision]);

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
  }, [editorReadyRevision, pages]);

  useEffect(() => () => {
    window.clearTimeout(saveTimerRef.current);
    persistPendingSaveRef.current().catch(() => null);
  }, []);

  const { contextSafe } = useGSAP(() => {
    const root = rootRef.current;
    const firstSheet = firstSheetRef.current;
    if (!root || !firstSheet) return undefined;
    const rails = root.querySelectorAll(".lesson-side-rail");
    const pageContent = root.querySelectorAll(".lesson-sheet-content");
    const secondarySheets = [...root.querySelectorAll(".lesson-sheet-frame")].slice(1);
    const finalRect = firstSheet.getBoundingClientRect();
    const currentSource = sourceElement?.isConnected
      ? sourceElement
      : [...document.querySelectorAll(".book-volume-file")]
        .find((element) => element.dataset.fileId === file.id);
    const sourceRect = originRect ?? currentSource?.getBoundingClientRect();
    const canMorph = Boolean(
      sourceRect?.width
      && sourceRect?.height
      && finalRect.width
      && finalRect.height,
    );
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduceMotion ? 0 : 0.82;
    const styles = getComputedStyle(document.documentElement);
    const background = styles.getPropertyValue("--app-background").trim();
    const clearBackground = styles.getPropertyValue("--app-background-clear").trim();
    const finalSheetStyle = getComputedStyle(firstSheet);
    const finalShadow = finalSheetStyle.boxShadow;
    const finalRadius = finalSheetStyle.borderRadius;
    const finalPaper = finalSheetStyle.backgroundColor;
    const sourcePaper = getComputedStyle(currentSource ?? firstSheet).backgroundColor;
    const sourceShadow = styles.getPropertyValue("--book-paper-shadow-clear").trim();

    if (rails.length) gsap.set(rails, { autoAlpha: 0 });
    if (pageContent.length) gsap.set(pageContent, { autoAlpha: 0 });
    if (secondarySheets.length) gsap.set(secondarySheets, { autoAlpha: 0, y: 24 });

    if (!canMorph || reduceMotion) {
      root.classList.remove("is-entering");
      setEntryPending(false);
      gsap.set(root, { clearProps: "backgroundColor" });
      if (pageContent.length) gsap.set(pageContent, { autoAlpha: 1 });
      if (secondarySheets.length) gsap.set(secondarySheets, { autoAlpha: 1, clearProps: "transform" });
      if (rails.length) gsap.set(rails, { autoAlpha: 1, clearProps: "transform" });
      return undefined;
    }

    gsap.set(root, { backgroundColor: clearBackground });
    gsap.set(firstSheet, {
      position: "fixed",
      top: finalRect.top,
      left: finalRect.left,
      width: finalRect.width,
      height: finalRect.height,
      zIndex: 6,
      x: sourceRect.left - finalRect.left,
      y: sourceRect.top - finalRect.top,
      scaleX: sourceRect.width / finalRect.width,
      scaleY: sourceRect.height / finalRect.height,
      transformOrigin: "top left",
      boxShadow: sourceShadow,
      backgroundColor: sourcePaper,
      borderRadius: 3,
      willChange: "transform, box-shadow",
    });
    // useGSAP runs in the layout phase. Revealing here exposes the already
    // transformed start pose in the first paint, never the full workspace.
    root.classList.remove("is-entering");
    setEntryPending(false);

    const timeline = gsap.timeline({
      defaults: { ease: "power2.inOut" },
      onComplete: () => {
        root.classList.remove("is-entering");
        setEntryPending(false);
        openingTimelineRef.current = null;
      },
    });
    openingTimelineRef.current = timeline;
    timeline
      .addLabel("open", 0)
      .to(root, {
        backgroundColor: background,
        duration: 0.58,
      }, "open")
      .to(firstSheet, {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        boxShadow: finalShadow,
        backgroundColor: finalPaper,
        borderRadius: finalRadius,
        duration,
        clearProps: "position,top,left,width,height,zIndex,transform,transformOrigin,boxShadow,backgroundColor,borderRadius,willChange",
      }, "open");
    if (pageContent.length) timeline.to(pageContent, {
      autoAlpha: 1,
      duration: 0.32,
      ease: "sine.inOut",
    }, duration * 0.58);
    if (secondarySheets.length) timeline.to(secondarySheets, {
        y: 0,
        autoAlpha: 1,
        stagger: 0.05,
        duration: 0.34,
      }, duration * 0.66);
    if (rails.length) timeline.fromTo(rails, {
        x: (index) => index === 0 ? -16 : 16,
        autoAlpha: 0,
      }, {
        x: 0,
        autoAlpha: 1,
        stagger: 0.05,
        duration: 0.34,
      }, duration * 0.7);
    return () => timeline.kill();
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

  const persistPlan = (nextPlan, transaction = null) => {
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
    setSaveStatus("正在保存…");
    setPlan(nextPlan);
    if (transaction?.origin !== "tiptap") {
      setEditorExternalRevision((version) => version + 1);
    }
  };

  const commitEditorFragment = (edit, transaction) => {
    const currentPlan = planRef.current;
    const nextPlan = applyLessonFieldEdit(currentPlan, edit);
    if (nextPlan === currentPlan) return;
    persistPlan(
      nextPlan,
      transaction ?? { field: edit.field, kind: "typing", origin: "tiptap" },
    );
  };

  const applyHistory = (direction) => {
    const currentHistory = historyRef.current;
    const nextHistory = direction === "undo"
      ? undoLessonChange(currentHistory)
      : redoLessonChange(currentHistory);
    if (nextHistory === currentHistory) return;

    historyRef.current = nextHistory;
    updateHistoryAvailability(nextHistory);
    planRef.current = nextHistory.present;
    dirtyPlanRef.current = nextHistory.present;
    pendingSaveSourceRef.current = "undo";
    setSaveStatus("正在保存…");
    setPlan(nextHistory.present);
    setEditorExternalRevision((version) => version + 1);
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
        && !activeElement.classList.contains("ProseMirror");
      if (isOtherEditable) return;
      const key = event.key.toLowerCase();
      const wantsUndo = key === "z" && !event.shiftKey;
      const wantsRedo = (key === "z" && event.shiftKey) || key === "y";
      if (!wantsUndo && !wantsRedo) return;

      event.preventDefault();
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

  const applyCanonicalAgentDocument = useCallback((canonicalFile) => {
    if (canonicalFile.id !== file.id) return;
    if (canonicalFile.documentVersion < documentVersionRef.current) return;
    if (
      canonicalFile.documentVersion === documentVersionRef.current
      && JSON.stringify(canonicalFile.document) === JSON.stringify(planRef.current)
    ) return;
    documentVersionRef.current = canonicalFile.documentVersion;
    setDocumentVersion(canonicalFile.documentVersion);
    pendingAgentCommitRef.current = {
      plan: canonicalFile.document,
      documentVersion: canonicalFile.documentVersion,
    };
    persistPlan(
      canonicalFile.document,
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
      const firstSheet = root?.querySelector(".lesson-sheet-frame") ?? firstSheetRef.current;
      if (!root || !firstSheet) {
        onClose();
        return;
      }
      const rails = root.querySelectorAll(".lesson-side-rail");
      const pageContent = root.querySelectorAll(".lesson-sheet-content");
      const secondarySheets = [...root.querySelectorAll(".lesson-sheet-frame")].slice(1);
      const currentRect = firstSheet.getBoundingClientRect();
      const source = document.querySelector(`.folder-paper[data-file-id="${file.id}"]`);
      const targetRect = source?.getBoundingClientRect() ?? originRect;
      const duration = reduceMotion ? 0 : 0.72;
      const rootStyles = getComputedStyle(document.documentElement);
      const clearBackground = rootStyles.getPropertyValue("--app-background-clear").trim();
      const currentShadow = getComputedStyle(firstSheet).boxShadow;
      const sourceShadow = rootStyles.getPropertyValue("--book-paper-shadow-clear").trim();

      if (!targetRect?.width || !targetRect?.height) {
        gsap.timeline({ onComplete: onClose })
          .to([...rails, ...secondarySheets, ...pageContent], {
            autoAlpha: 0,
            duration: reduceMotion ? 0 : 0.24,
            ease: "sine.inOut",
          });
        return;
      }

      gsap.set(firstSheet, {
        position: "fixed",
        top: currentRect.top,
        left: currentRect.left,
        width: currentRect.width,
        height: currentRect.height,
        zIndex: 6,
        transformOrigin: "top left",
        boxShadow: currentShadow,
        willChange: "transform, box-shadow",
      });

      const targetTransform = {
        x: targetRect.left - currentRect.left,
        y: targetRect.top - currentRect.top,
        scaleX: targetRect.width / currentRect.width,
        scaleY: targetRect.height / currentRect.height,
      };

      const timeline = gsap.timeline({ defaults: { ease: "power2.inOut" }, onComplete: onClose })
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
      if (pageContent.length) timeline.to(pageContent, { autoAlpha: 0, duration: reduceMotion ? 0 : 0.24, ease: "sine.inOut" }, "close");
      timeline.to(firstSheet, {
          ...targetTransform,
          boxShadow: sourceShadow,
          borderRadius: 3,
          duration,
        }, "close+=0.06")
        .to(root, {
          backgroundColor: clearBackground,
          duration: reduceMotion ? 0 : 0.42,
        }, `close+=${duration * 0.5}`);
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

  useEffect(() => {
    if (closeSignal) closeWorkspace();
  }, [closeSignal]);

  return (
    <section
      className={`lesson-file-workspace${entryPending ? " is-entering" : ""}`}
      ref={rootRef}
      aria-label={`${file.title}备课文件`}
      tabIndex={-1}
    >
      <PaginationMeasure plan={plan} presentationMaterial={presentationMaterial} measureRef={measureRef} />
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
          <Button
            className="lesson-outline-back"
            variant="ghost"
            size="sm"
            type="button"
            aria-label={`返回备课本：${file.title}`}
            onClick={closeWorkspace}
          >
            <ArrowLeft data-icon="inline-start" />
            <span className="lesson-outline-back-copy">
              <strong>{file.title}</strong>
              <small>{notebook.subject} / {notebook.className}</small>
            </span>
          </Button>
          <div className="lesson-file-identity">
            <p className="lesson-save-status"><Check aria-hidden="true" /> {saveStatus}</p>
            <div className="lesson-history-actions" aria-label="编辑历史">
              <Button
                variant="outline"
                type="button"
                aria-label="撤销"
                aria-keyshortcuts="Meta+Z Control+Z"
                title="撤销"
                disabled={!historyAvailability.canUndo}
                onClick={() => handleHistoryAction("undo")}
              >
                <Undo2 data-icon="inline-start" /> 撤销
              </Button>
              <Button
                variant="outline"
                type="button"
                aria-label="重做"
                aria-keyshortcuts="Meta+Shift+Z Control+Y"
                title="重做"
                disabled={!historyAvailability.canRedo}
                onClick={() => handleHistoryAction("redo")}
              >
                <Redo2 data-icon="inline-start" /> 重做
              </Button>
            </div>
          </div>
        </div>

        <nav
          className="lesson-anchor-nav"
          data-preview={previewSectionIndex == null ? "false" : "true"}
          aria-label="教案章节"
          onMouseLeave={() => setPreviewSectionIndex(null)}
        >
          {lessonPlanSections.map((section, sectionIndex) => {
            const visualFocusIndex = previewSectionIndex ?? activeSectionIndex;
            const distance = Math.min(4, Math.abs(sectionIndex - visualFocusIndex));
            const isActive = activeSection === section.id;
            const isPreview = previewSectionIndex === sectionIndex;
            return (
              <Button
                className={`lesson-anchor ${isActive ? "is-active" : ""} ${isPreview ? "is-preview" : ""}`}
                variant="ghost"
                size="sm"
                data-distance={distance}
                data-tone={section.tone}
                type="button"
                aria-current={isActive ? "location" : undefined}
                onMouseEnter={() => setPreviewSectionIndex(sectionIndex)}
                onFocus={() => setPreviewSectionIndex(sectionIndex)}
                onBlur={() => setPreviewSectionIndex(null)}
                onClick={() => scrollToSection(section.id)}
                key={section.id}
              >
                <span className="lesson-anchor-mark" aria-hidden="true" />
                <span className="lesson-anchor-label">{section.label}</span>
              </Button>
            );
          })}
        </nav>
      </aside>

      <div className="lesson-document-pane">
        <main
          className="lesson-document-scroll"
          ref={scrollRef}
          aria-label="A4教案编辑区"
        >
          <p className="lesson-mobile-document-hint">上下滚动查看完整教案</p>
          <LessonPlanTiptapEditor
            plan={plan}
            pages={pages}
            readOnly={false}
            externalRevision={editorExternalRevision}
            layoutRevision={pageLayoutRevision}
            displayRevision="canonical"
            containerRef={setDocumentPagesRef}
            onEditorReady={handleTiptapEditorReady}
            onFieldChange={commitEditorFragment}
            onFieldFocus={setActiveSection}
            onSelectionChange={setSelectionContext}
            presentationMaterial={{
              ...presentationMaterial,
              onGenerate: generatePresentationMaterial,
              onPreview: previewPresentationMaterial,
              onDelete: deletePresentationMaterial,
            }}
          />
        </main>
      </div>

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
