import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowLeft, Check, PanelRightClose, PanelRightOpen, Redo2, Sparkles, Undo2, X } from "lucide-react";

import { CanvasTools, CanvasZoom } from "@/features/workspace/canvas-controls";
import { useWorkspaceCanvas } from "@/features/workspace/use-workspace-canvas";
import { useLessonPaperTransition } from "./use-lesson-paper-transition";
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
import { reconcilePresentationMaterial } from "./presentation-material-state.js";
import { createMeasurementCache } from "./measurement-cache.js";
import { previewDocumentDraft } from "@/features/assistant/document-draft.js";
import { createLessonDraft, lessonDraftScope, readLessonDrafts, reconcileLessonDraft, removeLessonDraft, resolveLessonDraftConflict, sameLessonDocument, writeLessonDraft } from "@/lib/lesson-drafts.js";

function loadEditorRecovery(file, notebook, canonical) {
  const scope = lessonDraftScope(file, notebook);
  try {
    if (!scope) return { scope, document: canonical, error: "无法确认当前账号，本机草稿保护不可用；未同步前请勿关闭页面。" };
    const records = readLessonDrafts(window.localStorage, scope);
    if (records.length > 1) return { scope, document: canonical, candidates: records };
    if (!records.length) return { scope, document: canonical };
    const previous = records[0];
    const result = reconcileLessonDraft(previous, canonical, file.documentVersion ?? 0);
    return { scope, ...result, previous, record: result.synchronized ? null : createLessonDraft(scope, result.baseDocument, result.baseVersion, result.document, { id: previous.id, attempt: result.attempt, conflicts: result.conflicts }) };
  } catch {
    return { scope, document: canonical, error: "无法读取本机草稿。未同步的修改可能仅保留在此页面，请勿直接关闭。" };
  }
}


gsap.registerPlugin(useGSAP);

const LearningWorkbench = lazy(() => import("@/features/learning/learning-workbench").then((module) => ({ default: module.LearningWorkbench })));
const DecisionWorkbench = lazy(() => import("@/features/decisions/decision-workbench").then((module) => ({ default: module.DecisionWorkbench })));

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

const MeasuredMarkdown = memo(function MeasuredMarkdown({ value }) {
  const html = useMemo(() => renderLessonMarkdownHtml(value), [value]);
  return (
    <div
      className="lesson-tiptap-field"
      // This HTML is generated locally from the same trusted Markdown parser
      // and extension set as the field editor; no remote HTML enters here.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

const PaginationMeasure = memo(function PaginationMeasure({ plan, presentationMaterial, measureRef }) {
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
});

const measurementCaches = new WeakMap();

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

  const probeStyle = getComputedStyle(probeContent);
  const geometry = `${probeRow.offsetWidth}:${probeStyle.font}:${probeStyle.lineHeight}:${probeStyle.letterSpacing}`;
  let saved = measurementCaches.get(measureRoot);
  if (!saved || saved.geometry !== geometry) {
    saved = { geometry, cache: createMeasurementCache() };
    measurementCaches.set(measureRoot, saved);
  }
  const cache = saved.cache;
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

function paginateMeasuredPlan(measureRoot, plan, presentationMaterial) {
  if (!measureRoot || !plan) return null;
  const measurements = createDomMeasurements(measureRoot, plan);
  return measurements ? paginateLessonPlan(plan, measurements, presentationMaterial) : null;
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

export function LessonFileWorkspace({ notebook, file, sourceElement, closeSignal = 0, onSave, onAgentVersionCommitted, onClose, onCloseBlocked }) {
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const canvas = useWorkspaceCanvas(scrollRef);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const documentPagesRef = useRef(null);
  const closingRef = useRef(false);
  const sectionScrollRef = useRef(null);
  const anchorScrollActiveRef = useRef(false);
  const syncActiveSectionRef = useRef(() => {});
  const saveTimerRef = useRef(null);
  const measureRef = useRef(null);
  const draftMeasureRef = useRef(null);
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
  const [recovery] = useState(() => loadEditorRecovery(file, notebook, initialPlan));
  const draftScopeRef = useRef(recovery.scope);
  const canonicalRef = useRef({ document: initialPlan, documentVersion: file.documentVersion ?? 0 });
  const localDraftRef = useRef(recovery.record ?? null);
  const storedDraftRef = useRef(recovery.previous ?? null);
  const conflictsRef = useRef(recovery.conflicts ?? []);
  const recoveryHoldRef = useRef(Boolean(recovery.record || recovery.candidates?.length));
  const needsReconcileRef = useRef(Boolean(recovery.record));
  const saveBusyRef = useRef(false);
  const [localDraftError, setLocalDraftError] = useState(recovery.error ?? "");
  const [draftConflicts, setDraftConflicts] = useState(recovery.conflicts ?? []);
  const [recoveryCandidates, setRecoveryCandidates] = useState(recovery.candidates ?? []);
  const [draftNeedsSync, setDraftNeedsSync] = useState(Boolean(recovery.record));
  const [plan, setPlan] = useState(recovery.document);
  const [agentDraft, setAgentDraft] = useState(null);
  const [showOriginal, setShowOriginal] = useState(false);
  // The same proposal gains an approval id after streaming; keep the teacher's
  // original/draft view selection stable across that handoff.
  const draftIdentity = agentDraft?.toolCallId ?? agentDraft?.id;
  useEffect(() => { setShowOriginal(false); }, [draftIdentity]);
  const incomingProjection = useMemo(() => ({ identity: draftIdentity, fields: agentDraft?.fields }), [draftIdentity, agentDraft?.fields]);
  const deferredProjection = useDeferredValue(incomingProjection);
  const draftFields = agentDraft?.phase === "streaming" && deferredProjection.identity === draftIdentity
    ? deferredProjection.fields : incomingProjection.fields;
  const draftPatch = agentDraft?.patch;
  const draftPlan = useMemo(() => previewDocumentDraft(plan, draftFields || draftPatch ? { fields: draftFields, patch: draftPatch } : null), [plan, draftFields, draftPatch]);
  const displayingDraft = Boolean(agentDraft && draftPlan && !showOriginal);
  const historyRef = useRef(createLessonHistory(recovery.document));
  const [historyAvailability, setHistoryAvailability] = useState({
    canUndo: false,
    canRedo: false,
  });
  const [editorExternalRevision, setEditorExternalRevision] = useState(0);
  const [editorReadyRevision, setEditorReadyRevision] = useState(0);
  const [activeSection, setActiveSection] = useState("basics");
  const [previewSectionIndex, setPreviewSectionIndex] = useState(null);
  const [saveStatus, setSaveStatus] = useState(recovery.record ? "已恢复本机草稿，待核对" : recovery.candidates?.length ? "发现多份本机草稿" : "已自动保存");
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
  const [measuredDraftPages, setMeasuredDraftPages] = useState(null);
  const draftPages = useMemo(() => {
    if (!displayingDraft) return null;
    // Keep the last measured projection while the layout effect measures the
    // new snapshot. Replacing every fragment with an estimated projection and
    // then the measured one made each stream update render the paper twice.
    return measuredDraftPages ?? paginateLessonPlan(draftPlan, {}, presentationMaterial);
  }, [displayingDraft, draftPlan, measuredDraftPages, presentationMaterial]);
  const pageLayoutSignatureRef = useRef(pageLayoutSignature(pages));
  const pageContentSignatureRef = useRef(pageContentSignature(pages));
  const [pageLayoutRevision, setPageLayoutRevision] = useState(0);
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

  const rememberDraft = useCallback((document, attempt = localDraftRef.current?.attempt ?? null) => {
    const previous = storedDraftRef.current;
    const current = localDraftRef.current;
    const conflicts = conflictsRef.current.map((entry) => ({ ...entry, local: document[entry.field] }));
    try {
      const next = createLessonDraft(draftScopeRef.current, canonicalRef.current.document, canonicalRef.current.documentVersion, document, {
        id: current?.id ?? previous?.id, attempt, conflicts,
      });
      localDraftRef.current = next;
      writeLessonDraft(window.localStorage, next, previous);
      storedDraftRef.current = next;
      setLocalDraftError("");
      return next;
    } catch {
      setLocalDraftError("本机草稿保护失败，修改可能仅保留在此页面。请保持页面开启并重试同步。");
      return null;
    }
  }, []);

  const acceptCanonical = useCallback((remote) => {
    const scope = draftScopeRef.current;
    if (!remote?.document || !Number.isInteger(remote.documentVersion)
      || remote.id !== file.id || (scope && remote.ownerId !== scope.ownerId)) throw new Error("invalid_canonical_document");
    const previousCanonical = canonicalRef.current;
    if (remote.documentVersion < previousCanonical.documentVersion) throw new Error("stale_document");
    const pending = localDraftRef.current ?? (dirtyPlanRef.current || failedSaveDataRef.current ? {
      baseDocument: previousCanonical.document, baseVersion: previousCanonical.documentVersion,
      document: planRef.current, attempt: failedSaveDataRef.current, conflicts: conflictsRef.current,
    } : null);
    const result = pending ? reconcileLessonDraft(pending, remote.document, remote.documentVersion) : {
      document: remote.document, synchronized: true, conflicts: [], attempt: null,
    };
    canonicalRef.current = { document: remote.document, documentVersion: remote.documentVersion };
    documentVersionRef.current = remote.documentVersion;
    setDocumentVersion(remote.documentVersion);
    setSelectionContext(null);
    conflictsRef.current = result.conflicts;
    setDraftConflicts(result.conflicts);
    if (!sameLessonDocument(planRef.current, result.document)) {
      planRef.current = result.document;
      setPlan(result.document);
      historyRef.current = createLessonHistory(result.document);
      setHistoryAvailability({ canUndo: false, canRedo: false });
      setEditorExternalRevision((revision) => revision + 1);
    }
    if (result.synchronized) {
      if (storedDraftRef.current) {
        try { removeLessonDraft(window.localStorage, storedDraftRef.current); }
        catch { setLocalDraftError("内容已同步，但本机草稿清理失败；重新打开时会再核对云端。"); }
      }
      setLocalDraftError((current) => current.startsWith("本机草稿保护失败") ? "" : current);
      localDraftRef.current = null;
      storedDraftRef.current = null;
      dirtyPlanRef.current = null;
      failedSaveDataRef.current = null;
      pendingSaveDataRef.current = null;
      recoveryHoldRef.current = false;
      setDraftNeedsSync(false);
      setSaveStatus("已自动保存");
    } else {
      dirtyPlanRef.current = planRef.current;
      failedSaveDataRef.current = result.attempt;
      pendingSaveDataRef.current = { plan: planRef.current, pageCount: remote.pageCount ?? 1, source: pendingSaveSourceRef.current };
      rememberDraft(planRef.current, result.attempt);
      if (result.conflicts.length || recoveryHoldRef.current || needsReconcileRef.current) setDraftNeedsSync(true);
      setSaveStatus(result.conflicts.length ? "存在冲突，待核对" : "本机草稿，待同步");
    }
    return result;
  }, [file.id, rememberDraft]);

  const persistPendingSave = useCallback(() => {
    const save = saveInFlightRef.current.catch(() => null).then(async () => {
      if (recoveryHoldRef.current) throw new Error("draft_review_required");
      if (conflictsRef.current.length) throw new Error("draft_conflict");
      saveBusyRef.current = true;
      try {
        if (needsReconcileRef.current || failedSaveDataRef.current) {
          acceptCanonical(await agentApi.getLessonFile(file.id));
          needsReconcileRef.current = false;
        }
        let staleRetries = 0;
        let lastSaved = null;
        while (failedSaveDataRef.current || pendingSaveDataRef.current || dirtyPlanRef.current) {
          if (conflictsRef.current.length) throw new Error("draft_conflict");
          const candidate = localDraftRef.current?.attempt ?? failedSaveDataRef.current ?? pendingSaveDataRef.current ?? {
            plan: planRef.current, pageCount: 1, source: pendingSaveSourceRef.current,
          };
          const pendingSave = candidate.idempotencyKey ? candidate : {
            ...candidate, baseDocumentVersion: documentVersionRef.current, idempotencyKey: crypto.randomUUID(),
          };
          if (pendingSave.source === "agent-local") {
            pendingSaveDataRef.current = null;
            dirtyPlanRef.current = null;
            continue;
          }
          rememberDraft(planRef.current, pendingSave);
          failedSaveDataRef.current = pendingSave;
          setSaveStatus("正在同步…");
          try {
            const saved = await onSaveRef.current(pendingSave.plan, pendingSave.pageCount, pendingSave.source, pendingSave.baseDocumentVersion, pendingSave.idempotencyKey);
            acceptCanonical(saved);
            lastSaved = saved;
          } catch (error) {
            needsReconcileRef.current = true;
            if (error?.message === "stale_document" && staleRetries++ < 2) {
              acceptCanonical(await agentApi.getLessonFile(file.id));
              needsReconcileRef.current = false;
              continue;
            }
            setDraftNeedsSync(true);
            setSaveStatus("同步未确认，请重试");
            throw error;
          }
        }
        return lastSaved;
      } finally { saveBusyRef.current = false; }
    });
    saveInFlightRef.current = save;
    return save;
  }, [acceptCanonical, file.id, rememberDraft]);
  persistPendingSaveRef.current = persistPendingSave;

  const measureAndPaginateRef = useRef(() => {});
  measureAndPaginateRef.current = () => {
    const currentPlan = planRef.current;
    const measuredPages = paginateMeasuredPlan(measureRef.current, currentPlan, presentationMaterial);
    if (!measuredPages) return;
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

  const measureDraftRef = useRef(() => {});
  measureDraftRef.current = () => {
    if (!displayingDraft) return;
    const measuredPages = paginateMeasuredPlan(draftMeasureRef.current, draftPlan, presentationMaterial);
    if (measuredPages) setMeasuredDraftPages(measuredPages);
  };

  const flushDocumentBeforeAgentRun = useCallback(async () => {
    tiptapBridgeRef.current?.flush();
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    measureAndPaginateRef.current();
    window.clearTimeout(saveTimerRef.current);
    await persistPendingSaveRef.current();
    await saveInFlightRef.current;
    return { documentVersion: documentVersionRef.current, document: canonicalRef.current.document };
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
      setPresentationMaterial((current) => reconcilePresentationMaterial(
        current, presentations[0] ?? null, generation, presentationGenerationErrorMessage(generation),
      ));
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
    const refresh = () => { if (document.visibilityState === "visible") void loadPresentationMaterial(); };
    const timer = window.setInterval(refresh, presentationMaterial.state === "generating" ? 1_500 : 30_000);
    const settled = (event) => { if (!event.detail?.lessonFileId || event.detail.lessonFileId === file.id) refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("lessonup:presentation-changed", settled);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh);
      window.removeEventListener("lessonup:presentation-changed", settled); document.removeEventListener("visibilitychange", refresh); };
  }, [file.id, loadPresentationMaterial, presentationMaterial.state]);

  const generatePresentationMaterial = useCallback(async () => {
    setPresentationMaterial((current) => ({ ...current, error: "", confirmingDelete: false }));
    try {
      await flushDocumentBeforeAgentRun();
      setMobileRail("assistant");
    setAssistantOpen(true);
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

  useLayoutEffect(() => {
    measureDraftRef.current();
  }, [displayingDraft, draftPlan, presentationMaterial]);

  useEffect(() => {
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) {
        measurementCaches.delete(measureRef.current);
        measurementCaches.delete(draftMeasureRef.current);
        measureAndPaginateRef.current();
        measureDraftRef.current();
      }
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
      const fitScale = canonicalWidth ? Math.min(1, Math.max(0.25, availableWidth / canonicalWidth)) : 1;
      const scale = canvas.zoom ?? fitScale;
      pagesRoot.style.setProperty("--lesson-paper-scale", String(scale));
      pagesRoot.style.setProperty("--lesson-paper-display-width", `${canonicalWidth * scale}px`);
      pagesRoot.style.setProperty("--lesson-paper-display-height", `${sheet.offsetHeight * scale}px`);
      scrollRoot.style.setProperty("--canvas-paper-width", `${canonicalWidth * scale}px`);
      canvas.onScaleApplied(scale);
    };

    const observer = new ResizeObserver(updateScale);
    observer.observe(scrollRoot);
    updateScale();
    return () => observer.disconnect();
  }, [canvas.zoom, canvas.onScaleApplied, editorReadyRevision, displayingDraft]);

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
      const sections = [...root.querySelectorAll("[data-lesson-section]")].filter((section) => !section.closest("[hidden]")).map((section) => {
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

  useEffect(() => {
    if (recovery.previous && !recovery.record) {
      try { removeLessonDraft(window.localStorage, recovery.previous); storedDraftRef.current = null; }
      catch { setLocalDraftError("内容已同步，但本机草稿暂时无法清理。"); }
    } else if (recovery.record) rememberDraft(planRef.current, recovery.record.attempt);
  }, [recovery, rememberDraft]);

  useEffect(() => {
    // App updates lessonPlan optimistically; only a strictly newer version can
    // be treated as canonical, and the save response owns its in-flight update.
    if (!saveBusyRef.current && file.documentVersion > canonicalRef.current.documentVersion && file.lessonPlan) {
      try { acceptCanonical({ ...file, document: file.lessonPlan }); }
      catch { setLocalDraftError("云端内容已变化，请先重试同步并核对草稿。"); }
    }
  }, [acceptCanonical, file]);

  useEffect(() => {
    const protect = (event) => {
      tiptapBridgeRef.current?.flush();
      if (!dirtyPlanRef.current && !localDraftRef.current && !failedSaveDataRef.current && !saveBusyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const reconnect = () => {
      if (recoveryHoldRef.current || conflictsRef.current.length || (!dirtyPlanRef.current && !failedSaveDataRef.current)) return;
      needsReconcileRef.current = true;
      persistPendingSaveRef.current().catch(() => null);
    };
    window.addEventListener("beforeunload", protect);
    window.addEventListener("online", reconnect);
    return () => { window.removeEventListener("beforeunload", protect); window.removeEventListener("online", reconnect); };
  }, []);

  useEffect(() => () => {
    window.clearTimeout(saveTimerRef.current);
    persistPendingSaveRef.current().catch(() => null);
  }, []);

  const { contextSafe } = useGSAP(() => {}, { scope: rootRef });
  const closePaper = useLessonPaperTransition({ rootRef, scrollRef, sourceElement });

  const updateHistoryAvailability = (history) => {
    setHistoryAvailability({
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    });
  };

  const persistPlan = useCallback((nextPlan, transaction = null) => {
    rememberDraft(nextPlan);
    setSelectionContext((current) => current && nextPlan[current.field] !== current.fieldSnapshot ? null : current);
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
    setSaveStatus(recoveryHoldRef.current || conflictsRef.current.length ? "本机草稿，待核对" : "正在保存…");
    setPlan(nextPlan);
    if (transaction?.origin !== "tiptap") {
      setEditorExternalRevision((version) => version + 1);
    }
  }, [rememberDraft]);

  const commitEditorFragment = useCallback((edit, transaction) => {
    const currentPlan = planRef.current;
    const nextPlan = applyLessonFieldEdit(currentPlan, edit);
    if (nextPlan === currentPlan) return;
    persistPlan(
      nextPlan,
      transaction ?? { field: edit.field, kind: "typing", origin: "tiptap" },
    );
  }, [persistPlan]);

  const applyHistory = (direction) => {
    const currentHistory = historyRef.current;
    const nextHistory = direction === "undo"
      ? undoLessonChange(currentHistory)
      : redoLessonChange(currentHistory);
    if (nextHistory === currentHistory) return;

    rememberDraft(nextHistory.present);
    setSelectionContext(null);
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
    const target = documentPagesRef.current?.querySelector(`#lesson-section-${sectionId}`);
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
    const previousHistory = historyRef.current;
    const result = acceptCanonical(canonicalFile);
    const adoptedHistory = recordLessonChange(previousHistory, planRef.current, { field: "document", kind: "agent" });
    historyRef.current = adoptedHistory;
    updateHistoryAvailability(adoptedHistory);
    if (result.synchronized) pendingAgentCommitRef.current = {
      plan: planRef.current,
      documentVersion: canonicalFile.documentVersion,
    };
  }, [acceptCanonical, file.id]);

  const closeWorkspace = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    sectionScrollRef.current?.kill();
    try {
      tiptapBridgeRef.current?.flush();
      if (dirtyPlanRef.current || pendingSaveDataRef.current || failedSaveDataRef.current) {
        await flushDocumentBeforeAgentRun();
      } else {
        await saveInFlightRef.current;
      }
      if (await closePaper()) onClose();
    } catch {
      // Retain the editor and its retryable save if delivery failed.
      closingRef.current = false;
      onCloseBlocked?.();
    }
  };

  useEffect(() => {
    if (closeSignal) closeWorkspace();
  }, [closeSignal]);

  const [sidecarView, setSidecarView] = useState("assistant");
  const editablePresentationMaterial = useMemo(() => ({ ...presentationMaterial,
    onGenerate: generatePresentationMaterial, onPreview: previewPresentationMaterial, onDelete: deletePresentationMaterial,
  }), [presentationMaterial, generatePresentationMaterial, previewPresentationMaterial, deletePresentationMaterial]);
  const [learningRequest, setLearningRequest] = useState(null);
  const [decisionRequest, setDecisionRequest] = useState(null);
  const handleLearningRequest = useCallback((id) => setLearningRequest((current) => current?.id === id ? null : current), []);
  const requestLearningAgent = useCallback((request) => {
    setLearningRequest({ ...request, id: crypto.randomUUID() });
    setSidecarView("assistant");
    setMobileRail("assistant");
    setAssistantOpen(true);
  }, []);
  const handleDecisionRequest = useCallback((id) => setDecisionRequest((current) => current?.id === id ? null : current), []);
  const requestDecisionAgent = useCallback((request) => {
    setDecisionRequest({ ...request, id: crypto.randomUUID() });
    setSidecarView("assistant");
    setMobileRail("assistant");
    setAssistantOpen(true);
  }, []);

  const chooseRecovery = (id) => {
    try {
      const record = readLessonDrafts(window.localStorage, draftScopeRef.current).find((entry) => entry.id === id);
      if (!record) throw new Error("draft_missing");
      localDraftRef.current = record;
      storedDraftRef.current = record;
      const result = acceptCanonical({ ...canonicalRef.current, id: file.id, ownerId: draftScopeRef.current?.ownerId });
      recoveryHoldRef.current = !result.synchronized;
      needsReconcileRef.current = true;
      setRecoveryCandidates((current) => current.filter((entry) => entry.id !== id));
    } catch { setLocalDraftError("无法恢复这份本机草稿，原记录仍保留，请勿覆盖或清除浏览器数据。"); }
  };
  const resolveConflict = (field, value) => {
    const current = localDraftRef.current;
    if (!current) return;
    const resolved = resolveLessonDraftConflict(current, field, value);
    conflictsRef.current = resolved.conflicts;
    setDraftConflicts(resolved.conflicts);
    localDraftRef.current = resolved;
    planRef.current = resolved.document;
    dirtyPlanRef.current = resolved.document;
    historyRef.current = createLessonHistory(resolved.document);
    setHistoryAvailability({ canUndo: false, canRedo: false });
    setPlan(resolved.document);
    setSelectionContext(null);
    setEditorExternalRevision((revision) => revision + 1);
    rememberDraft(resolved.document, null);
    setDraftNeedsSync(true);
  };
  const retryDocumentSync = async () => {
    if (conflictsRef.current.length) return;
    recoveryHoldRef.current = false;
    needsReconcileRef.current = true;
    try { await flushDocumentBeforeAgentRun(); }
    catch { setSaveStatus(conflictsRef.current.length ? "存在冲突，待核对" : "同步未完成，请重试"); }
  };
  const handleSelectionChange = useCallback((selection) => {
    setSelectionContext(selection ? {
      ...selection,
      fieldSnapshot: planRef.current[selection.field],
      baseDocumentVersion: documentVersionRef.current,
    } : null);
  }, []);

  const prepareDecisionRevision = useCallback((decision) => {
    if (!["teacher_confirmed", "implemented"].includes(decision.status) || !decision.chosenOptionId) return;
    setSelectionContext(null);
    requestDecisionAgent({
      taskIntent: { type: "document_write", decisionRef: { id: decision.id, version: decision.version, chosenOptionId: decision.chosenOptionId } },
      prompt: "请读取当前教案以及本次已确认的教学判断，仅落实教师已选方案，准备最小充分的教案修改提案供我核对。核对判断前提和取证安排，保留无关内容，不替我采用修改、登记实施或审议；不能根据历史对话重新选择方案。",
    });
  }, [requestDecisionAgent]);

  return (
    <section
      className={`lesson-file-workspace canvas-workspace ${assistantOpen ? "" : "is-assistant-collapsed"}`}
      ref={rootRef}
      aria-label={`${file.title}备课文件`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && mobileRail === "outline") {
          setMobileRail(null);
          rootRef.current?.querySelector('[aria-label="显示教案目录"]')?.focus();
          event.stopPropagation();
        }
      }}
    >
      <div className="lesson-workspace-backdrop" aria-hidden="true" />
      <PaginationMeasure plan={plan} presentationMaterial={presentationMaterial} measureRef={measureRef} />
      {displayingDraft ? <PaginationMeasure plan={draftPlan} presentationMaterial={presentationMaterial} measureRef={draftMeasureRef} /> : null}
      <div className="lesson-mobile-switcher" aria-label="详情页工具">
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

      <aside id="lesson-outline-panel" aria-label="教案目录" hidden={mobileRail !== "outline"} className={`lesson-side-rail lesson-outline-rail ${mobileRail === "outline" ? "is-mobile-open" : ""}`}>
        <div className="workspace-outline-heading"><strong>教案目录</strong><Button variant="ghost" size="icon-sm" aria-label="关闭教案目录" onClick={() => setMobileRail(null)}><X /></Button></div>
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

      <div className="lesson-document-pane workspace-surface">
        <div className="workspace-header lesson-outline-header">
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
            <p className="lesson-save-status" role="status" aria-live="polite">{saveStatus === "已自动保存" ? <Check aria-hidden="true" /> : null} {saveStatus}</p>

          </div>
          <Button className="workspace-assistant-toggle" variant="ghost" size="icon-sm" aria-label={assistantOpen ? "收起备课助手" : "展开备课助手"} title={assistantOpen ? "收起备课助手" : "展开备课助手"} onClick={() => setAssistantOpen(open => !open)}>
            {assistantOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
        </div>
        <CanvasTools canvas={canvas} outlineOpen={mobileRail === "outline"} outlineLabel="显示教案目录" onToggleOutline={() => setMobileRail(current => current === "outline" ? null : "outline")}>
            <div className="lesson-history-actions" aria-label="编辑历史">
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label="撤销"
                aria-keyshortcuts="Meta+Z Control+Z"
                title="撤销"
                disabled={!historyAvailability.canUndo}
                onClick={() => handleHistoryAction("undo")}
              >
                <Undo2 aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label="重做"
                aria-keyshortcuts="Meta+Shift+Z Control+Y"
                title="重做"
                disabled={!historyAvailability.canRedo}
                onClick={() => handleHistoryAction("redo")}
              >
                <Redo2 aria-hidden="true" />
              </Button>
            </div>
        </CanvasTools>
        <CanvasZoom canvas={canvas} />
        <main
          className="lesson-document-scroll workspace-canvas-viewport"
          data-canvas-mode={canvas.mode}
          tabIndex={0}
          ref={scrollRef}
          aria-label="A4教案编辑区"
        >
          <div className="workspace-canvas-content">
          {localDraftError || draftNeedsSync || recoveryCandidates.length ? <section className="mx-auto mb-4 w-full max-w-3xl space-y-3 rounded-lg border bg-background p-4 text-sm" aria-label="本机草稿与同步">
            {localDraftError ? <p role="alert">{localDraftError}</p> : draftNeedsSync ? <p role="status">未同步修改已保留在本机。请核对恢复内容后同步；云端同时变化的段落需要逐项选择。</p> : null}
            {recoveryCandidates.length ? <div className="space-y-2">
              <p>发现 {recoveryCandidates.length} 份本机草稿，未自动覆盖当前教案。请选择要核对的草稿，其他草稿仍会保留。</p>
              {recoveryCandidates.map((record, index) => <Button key={record.id} variant="outline" size="sm" onClick={() => chooseRecovery(record.id)}>恢复草稿 {index + 1} · {new Date(record.updatedAt).toLocaleString("zh-CN")}</Button>)}
              {!localDraftRef.current ? <Button variant="ghost" size="sm" onClick={() => { setRecoveryCandidates([]); recoveryHoldRef.current = false; setSaveStatus("已载入云端内容，本机草稿保留"); }}>暂用云端内容</Button> : null}
            </div> : null}
            {draftConflicts.map((conflict) => <details key={conflict.field} open className="space-y-2">
              <summary>{lessonPlanSections.find((section) => section.id === conflict.field)?.label ?? ({ unit: "单元", period: "课时", totalPeriods: "总课时", topic: "课题" })[conflict.field]}存在同时修改，请选择</summary>
              <p><strong>当前编辑</strong></p><p className="whitespace-pre-wrap break-words">{plan[conflict.field] || "（空）"}</p>
              <p><strong>云端内容</strong></p><p className="whitespace-pre-wrap break-words">{conflict.remote || "（空）"}</p>
              <Button variant="outline" size="sm" onClick={() => resolveConflict(conflict.field, planRef.current[conflict.field])}>采用当前编辑</Button>{" "}
              <Button variant="outline" size="sm" onClick={() => resolveConflict(conflict.field, conflict.remote)}>采用云端内容</Button>
            </details>)}
            {draftNeedsSync || localDraftError ? <Button size="sm" disabled={draftConflicts.length > 0} onClick={() => { void retryDocumentSync(); }}>核对并重试同步</Button> : null}
          </section> : null}
          {displayingDraft ? <LessonPlanTiptapEditor
            key="agent-draft"
            plan={draftPlan}
            pages={draftPages}
            readOnly
            externalRevision={0}
            layoutRevision={0}
            displayRevision="draft"
            containerRef={setDocumentPagesRef}
            onFieldChange={() => {}}
            onFieldFocus={setActiveSection}
            onSelectionChange={() => {}}
            presentationMaterial={presentationMaterial}
          /> : null}
          <div hidden={displayingDraft}>
          <LessonPlanTiptapEditor
            plan={plan}
            pages={pages}
            readOnly={false}
            externalRevision={editorExternalRevision}
            layoutRevision={pageLayoutRevision}
            displayRevision="canonical"
            containerRef={displayingDraft ? undefined : setDocumentPagesRef}
            onEditorReady={handleTiptapEditorReady}
            onFieldChange={commitEditorFragment}
            onFieldFocus={setActiveSection}
            onSelectionChange={handleSelectionChange}
            presentationMaterial={editablePresentationMaterial}
          />
          </div>
          </div>
        </main>
        {agentDraft ? <div className="lesson-draft-bar" aria-label="A4 草稿操作">
          <div role="status">
            <strong>{agentDraft.phase === "streaming" || agentDraft.generating ? "正在生成草稿…" : agentDraft.phase === "executing" ? "正在保存决定…" : agentDraft.patch?.summary ?? "修改待采用"}</strong>
            <span>{agentDraft.phase === "recoverable" ? "决定已保存，仅需恢复旧会话回复。" : !draftPlan ? "原文已变化，请重新生成；未覆盖你的编辑。" : "草稿尚未保存，对话可以继续。"}</span>
            {agentDraft.error ? <span role="alert">{agentDraft.error}</span> : null}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowOriginal((value) => !value)}>{showOriginal ? "查看草稿" : "查看原文"}</Button>
          {agentDraft.choices?.length > 1 ? <select aria-label="选择待采用草稿" value={agentDraft.id} onChange={(event) => agentDraft.choose(event.target.value)}>
            {agentDraft.choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select> : null}
          {agentDraft.phase === "syncing" ? <Button size="sm" onClick={agentDraft.synchronize}>同步结果</Button> : <>
            <Button variant="outline" size="sm" disabled={agentDraft.phase !== "pending" || agentDraft.generating} onClick={agentDraft.discard}>放弃修改</Button>
            <Button size="sm" disabled={agentDraft.phase !== "recoverable" && (!draftPlan || agentDraft.phase !== "pending" || agentDraft.generating)} onClick={agentDraft.accept}>{agentDraft.phase === "recoverable" ? "恢复回复" : "采用修改"}</Button>
          </>}
        </div> : null}
      </div>

      <aside id="lesson-assistant-panel" className={`lesson-side-rail lesson-assistant-rail ${mobileRail === "assistant" ? "is-mobile-open" : ""}`}>
        <div className="lesson-sidecar-tabs" role="tablist" aria-label="备课、学习验证与教学决策" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const views = ["assistant", "learning", "decisions"];
          const index = Math.max(0, views.indexOf(sidecarView));
          const view = event.key === "Home" ? views[0]
            : event.key === "End" ? views[views.length - 1]
              : views[(index + (event.key === "ArrowRight" ? 1 : views.length - 1)) % views.length];
          setSidecarView(view); document.getElementById(`${view}-tab`)?.focus();
        }}>
          <Button id="assistant-tab" role="tab" tabIndex={sidecarView === "assistant" ? 0 : -1} aria-selected={sidecarView === "assistant"} aria-controls="assistant-tab-panel" size="sm" variant="ghost" onClick={() => setSidecarView("assistant")}>备课助手</Button>
          <Button id="learning-tab" role="tab" tabIndex={sidecarView === "learning" ? 0 : -1} aria-selected={sidecarView === "learning"} aria-controls="learning-tab-panel" size="sm" variant="ghost" onClick={() => setSidecarView("learning")}>学习验证</Button>
          <Button id="decisions-tab" role="tab" tabIndex={sidecarView === "decisions" ? 0 : -1} aria-selected={sidecarView === "decisions"} aria-controls="decisions-tab-panel" size="sm" variant="ghost" onClick={() => setSidecarView("decisions")}>教学决策</Button>
        </div>
        <div id="decisions-tab-panel" role="tabpanel" aria-labelledby="decisions-tab" hidden={sidecarView !== "decisions"} className="lesson-sidecar-content">
          {sidecarView === "decisions" ? <Suspense fallback={<p role="status">正在读取教学决策…</p>}><DecisionWorkbench file={{ ...file, documentVersion }} onBeforeWrite={flushDocumentBeforeAgentRun} onPrepareDecisionRevision={prepareDecisionRevision} onAgentRequest={requestDecisionAgent} /></Suspense> : null}
        </div>
        <div id="learning-tab-panel" role="tabpanel" aria-labelledby="learning-tab" hidden={sidecarView !== "learning"} className="lesson-sidecar-content">
          {sidecarView === "learning" ? <Suspense fallback={<p role="status">正在读取学习记录…</p>}><LearningWorkbench file={{ ...file, documentVersion }} notebook={notebook} plan={plan} onBeforeWrite={flushDocumentBeforeAgentRun} onAgentRequest={requestLearningAgent} /></Suspense> : null}
        </div>
        <div id="assistant-tab-panel" role="tabpanel" aria-labelledby="assistant-tab" hidden={sidecarView !== "assistant"} className="lesson-sidecar-content">
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
            onDocumentDraft={setAgentDraft}
            onNavigateToSection={scrollToSection}
            learningRequest={learningRequest}
            onLearningRequestHandled={handleLearningRequest}
            decisionRequest={decisionRequest}
            onDecisionRequestHandled={handleDecisionRequest}
          />
        </Suspense>
        </div>
      </aside>

    </section>
  );
}
