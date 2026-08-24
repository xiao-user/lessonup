import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  FilePlus2,
  Link2,
  List,
  LoaderCircle,
  MessageCircle,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BlueprintDialog } from "@/features/semester-frameworks/blueprint-dialog";
import {
  lessonPeriodContext,
  selectContinuityForDraft,
} from "@/features/semester-frameworks/lesson-blueprint-context";
import { SemesterFrameworkAgentPanel } from "@/features/semester-frameworks/semester-framework-agent-panel";
import { agentApi } from "@/lib/agent-api";

const unitStatusLabels = {
  unplanned: "待规划",
  planned: "已规划",
  in_progress: "进行中",
  completed: "已完成",
  deferred: "已顺延",
};

const classFeedbackKindLabels = {
  observation: "课堂观察",
  practice_gap: "练习缺口",
  error_cause: "错因",
  continuity_outcome: "衔接效果",
};

const classFeedbackOutcomeLabels = {
  worked: "有效",
  weak: "偏弱",
  skipped: "未落实",
};

const classFeedbackProvenance = {
  observation: {
    label: "教师课堂事实",
    hint: "记录你在本班课堂中直接观察到的情况；它不会被当作教材或课程标准事实。",
  },
  practice_gap: {
    label: "教师课堂判断",
    hint: "用于调整本班练习与支架；它不代表所有班级都会出现同样问题。",
  },
  error_cause: {
    label: "教师推断（待后续观察校正）",
    hint: "这是你对错因的教学推断；后续应结合学生表现继续核验，而不是当作已证实原因。",
  },
  continuity_outcome: {
    label: "教师决定：衔接效果",
    hint: "记录本班本次复习或铺垫是否有效；它不等同于平台已核验的先修关系。",
  },
};

function continuityCandidateLabel(candidate) {
  if (!candidate) return "选择衔接候选";
  return candidate.direction === "review"
    ? `复习：${candidate.relatedPointName} → ${candidate.currentPointName}`
    : `铺垫：${candidate.currentPointName} → ${candidate.relatedPointName}`;
}

function continuityCandidateEvidence(candidate) {
  if (!candidate) return null;
  const platformEvidence = candidate.evidenceKind === "lexical_similarity"
    ? "平台推荐：名称相关，仍待教师判断"
    : "平台依据：已核验知识关联";
  const teacherDecision = candidate.decision === "accepted"
    ? "教师决定：已采用"
    : candidate.decision === "dismissed"
      ? "教师决定：已排除"
      : "教师决定：待取舍";
  return `${platformEvidence}；${teacherDecision}。`;
}

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function capacityCaption(plannedPeriods, availablePeriods, capacityRatio) {
  const percent = Math.round(capacityRatio * 100);
  if (plannedPeriods > availablePeriods) {
    return `已规划课时 / ${percent}% 可用容量（超出 ${plannedPeriods - availablePeriods} 课时）`;
  }
  return `已规划课时 / ${percent}% 可用容量`;
}

function UnitPlanningEditor({ unit, totalWeeks, onSave }) {
  const [startWeek, setStartWeek] = useState(unit.plannedStartWeek ?? "");
  const [endWeek, setEndWeek] = useState(unit.plannedEndWeek ?? "");
  const [plannedPeriods, setPlannedPeriods] = useState(unit.plannedPeriods);
  const [learningGoals, setLearningGoals] = useState(unit.learningGoals);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setStartWeek(unit.plannedStartWeek ?? "");
    setEndWeek(unit.plannedEndWeek ?? "");
    setPlannedPeriods(unit.plannedPeriods);
    setLearningGoals(unit.learningGoals);
  }, [unit.id, unit.learningGoals, unit.plannedEndWeek, unit.plannedPeriods, unit.plannedStartWeek, unit.version]);

  const changes = [
    ["plannedStartWeek", unit.plannedStartWeek, startWeek === "" ? null : Number(startWeek)],
    ["plannedEndWeek", unit.plannedEndWeek, endWeek === "" ? null : Number(endWeek)],
    ["plannedPeriods", unit.plannedPeriods, Number(plannedPeriods)],
    ["learningGoals", unit.learningGoals, learningGoals.trim()],
  ].filter(([, expectedValue, replacement]) => expectedValue !== replacement);

  const save = async () => {
    if (!changes.length || saving) return;
    setSaving(true);
    try {
      await onSave(changes.map(([field, expectedValue, replacement]) => ({
        op: "replace_unit_field",
        unitId: unit.id,
        field,
        expectedValue,
        replacement,
      })));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="framework-unit-editor">
      <div className="framework-unit-schedule" role="group" aria-label="单元排程">
        <label>
          <span>周次</span>
          <span className="framework-unit-schedule-range">
            <Input type="number" min="1" max={totalWeeks} value={startWeek} onChange={(event) => setStartWeek(event.target.value)} placeholder="起" aria-label="起始周" />
            <span aria-hidden="true">–</span>
            <Input type="number" min="1" max={totalWeeks} value={endWeek} onChange={(event) => setEndWeek(event.target.value)} placeholder="止" aria-label="结束周" />
          </span>
        </label>
        <label>
          <span>课时</span>
          <Input type="number" min="0" max="100" value={plannedPeriods} onChange={(event) => setPlannedPeriods(event.target.value)} aria-label="规划课时" />
        </label>
      </div>
      <label className="framework-unit-goals">
        <span>单元目标</span>
        <Textarea value={learningGoals} onChange={(event) => setLearningGoals(event.target.value)} placeholder="学生完成本单元后能够做什么？" />
      </label>
      <Button size="sm" variant={changes.length ? "default" : "outline"} disabled={!changes.length || saving} onClick={save}>
        {saving ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : changes.length ? <Save aria-hidden="true" /> : <Check aria-hidden="true" />}
        {saving ? "保存中" : changes.length ? "保存单元" : "已同步"}
      </Button>
    </div>
  );
}

function FrameworkUnitNav({
  textbook,
  plannedPeriods,
  availablePeriods,
  capacityRatio,
  units,
  selectedUnitId,
  nodeById,
  onSelectUnit,
}) {
  return (
    <>
      <div className="framework-overview" aria-label="学期容量">
        <span>{textbook?.edition} · {textbook?.grade}{textbook?.volume}</span>
        <p className="framework-overview-capacity">
          <strong>{plannedPeriods}</strong>
          <span aria-hidden="true">/</span>
          <span>{availablePeriods}</span>
        </p>
        <small>{capacityCaption(plannedPeriods, availablePeriods, capacityRatio)}</small>
      </div>
      <nav aria-label="单元列表">
        {units.map((unit) => {
          const title = nodeById.get(unit.curriculumNodeId)?.title ?? `单元 ${unit.sortNo}`;
          const active = unit.id === selectedUnitId;
          return (
            <button
              className={active ? "is-active" : undefined}
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => onSelectUnit(unit.id)}
              key={unit.id}
            >
              <span aria-hidden="true">{String(unit.sortNo).padStart(2, "0")}</span>
              <strong>{title}</strong>
              <small>{unitStatusLabels[unit.status]}</small>
              <ChevronRight aria-hidden="true" />
            </button>
          );
        })}
      </nav>
    </>
  );
}

function FrameworkContinuityPanel({
  continuity,
  selectedCandidates,
  unitById,
  nodeById,
  refreshing,
  decidingFingerprint,
  onRefresh,
  onDecide,
}) {
  return (
    <div className="framework-continuity" aria-label="教学衔接">
      <div className="framework-continuity-toolbar">
        <p>采用后会优先进入蓝图与教案；排除后不再写入后续规划。</p>
        <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          更新
        </Button>
      </div>
      {continuity?.status === "semantic_release_unavailable" ? (
        <p className="framework-continuity-empty">当前教材还没有已发布知识点，系统不会猜测关联。</p>
      ) : selectedCandidates.length ? (
        <div className="framework-continuity-list">
          {selectedCandidates.map((candidate) => {
            const relatedUnit = unitById.get(candidate.relatedUnitId);
            const relatedTitle = nodeById.get(relatedUnit?.curriculumNodeId)?.title ?? "相关单元";
            const suggested = candidate.evidenceKind === "lexical_similarity";
            const decisionLabel = candidate.decision === "accepted"
              ? "已采用"
              : candidate.decision === "dismissed"
                ? "已排除"
                : "待取舍";
            const busy = decidingFingerprint === candidate.fingerprint;
            return (
              <div
                className={`framework-continuity-item direction-${candidate.direction} decision-${candidate.decision}`}
                key={candidate.id}
              >
                <span>
                  {candidate.direction === "review" ? "复习旧知" : "后续铺垫"}
                  {" · "}
                  {suggested ? "待判断" : "已核验"}
                  {" · "}
                  {decisionLabel}
                </span>
                <strong>{candidate.currentPointName}</strong>
                <p>{candidate.rationale}</p>
                <small>
                  {candidate.direction === "review" ? "可能承接" : "可能铺垫"}：{relatedTitle} · {candidate.relatedPointName}
                </small>
                <div className="framework-continuity-actions">
                  <Button
                    size="sm"
                    variant={candidate.decision === "accepted" ? "default" : "outline"}
                    disabled={busy || candidate.decision === "accepted"}
                    onClick={() => onDecide(candidate, "accepted")}
                  >
                    {busy && candidate.decision !== "accepted" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
                    采用
                  </Button>
                  <Button
                    size="sm"
                    variant={candidate.decision === "dismissed" ? "default" : "ghost"}
                    disabled={busy || candidate.decision === "dismissed"}
                    onClick={() => onDecide(candidate, "dismissed")}
                  >
                    排除
                  </Button>
                  {candidate.decision !== "candidate" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onDecide(candidate, "candidate")}
                    >
                      撤销取舍
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="framework-continuity-empty">
          <p>
            {refreshing
              ? "正在分析当前教材中的前后关联…"
              : "当前单元暂未找到值得采用的教学衔接。系统不会为了填满内容而强行建立关系。"}
          </p>
        </div>
      )}
    </div>
  );
}

function FrameworkOutlineBack({ title, subtitle, onClose }) {
  return (
    <Button
      className="framework-outline-back"
      variant="ghost"
      size="sm"
      type="button"
      aria-label={`返回备课本：${title}`}
      onClick={onClose}
    >
      <ArrowLeft data-icon="inline-start" aria-hidden="true" />
      <span className="framework-outline-back-copy">
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </span>
    </Button>
  );
}

export function SemesterFrameworkWorkspace({ notebook, frameworkId, onClose, onCreateLesson, onDeleteLesson }) {
  const [aggregate, setAggregate] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [textbook, setTextbook] = useState(null);
  const [continuity, setContinuity] = useState(null);
  const [activeUnitId, setActiveUnitId] = useState(null);
  const [blueprintTarget, setBlueprintTarget] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [decidingFingerprint, setDecidingFingerprint] = useState(null);
  const [feedbackTarget, setFeedbackTarget] = useState(null);
  const [feedbackKind, setFeedbackKind] = useState("observation");
  const [feedbackStatement, setFeedbackStatement] = useState("");
  const [feedbackFingerprint, setFeedbackFingerprint] = useState("");
  const [feedbackOutcome, setFeedbackOutcome] = useState("weak");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [creatingLessonId, setCreatingLessonId] = useState(null);
  const [knowledgeByNodeId, setKnowledgeByNodeId] = useState({});
  const [sidecarView, setSidecarView] = useState("assistant");
  const [mobilePanel, setMobilePanel] = useState(null);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [pendingWritebackPrompt, setPendingWritebackPrompt] = useState(null);
  const selectedFeedbackCandidate = useMemo(() => (
    (feedbackTarget?.candidates ?? []).find((candidate) => (
      candidate.fingerprint === feedbackFingerprint
    )) ?? null
  ), [feedbackFingerprint, feedbackTarget]);
  const unitRefs = useRef(new Map());
  const mainScrollRef = useRef(null);
  const reactId = useId();
  const mobileCloseId = `${reactId}-mobile-close`;

  const closeMobilePanel = () => {
    if (prefersReducedMotion()) {
      setMobileDrawerOpen(false);
      setMobilePanel(null);
      return;
    }
    setMobileDrawerOpen(false);
  };

  const openMobilePanel = (panel) => {
    setMobilePanel(panel);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      setAggregate(null);
      try {
        const framework = await agentApi.getSemesterFramework(frameworkId);
        const continuityRequest = agentApi.refreshSemesterFrameworkContinuity(frameworkId)
          .catch(() => agentApi.getSemesterFrameworkContinuity(frameworkId))
          .catch(() => null);
        const [outline, nextTextbook] = await Promise.all([
          agentApi.listCurriculumReleaseNodes(
            framework.framework.catalogReleaseId,
            framework.framework.textbookId,
            { maxLevel: 8 },
          ),
          agentApi.getCurriculumReleaseTextbook(
            framework.framework.catalogReleaseId,
            framework.framework.textbookId,
          ),
        ]);
        if (cancelled) return;
        setAggregate(framework);
        setNodes(outline.nodes ?? []);
        setTextbook(nextTextbook.textbook ?? nextTextbook);
        setActiveUnitId(framework.units[0]?.id ?? null);
        void continuityRequest.then((nextContinuity) => {
          if (!cancelled && nextContinuity) setContinuity(nextContinuity);
        });
      } catch (error) {
        if (!cancelled) {
          setLoadError(error.message || "未知错误");
          toast.error(`无法打开学期框架：${error.message}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [frameworkId, loadNonce]);

  useEffect(() => {
    const frameworkVersion = aggregate?.framework?.version;
    if (
      frameworkVersion == null
      || continuity?.frameworkVersion === frameworkVersion
    ) return undefined;
    let cancelled = false;
    setRefreshing(true);
    agentApi.refreshSemesterFrameworkContinuity(frameworkId)
      .then((result) => {
        if (!cancelled) setContinuity(result);
      })
      .catch((error) => {
        if (!cancelled) toast.error(`无法更新教学衔接：${error.message}`);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => { cancelled = true; };
  }, [aggregate?.framework?.version, continuity?.frameworkVersion, frameworkId]);

  useEffect(() => {
    if (!mobilePanel) {
      setMobileDrawerOpen(false);
      return undefined;
    }
    if (prefersReducedMotion()) {
      setMobileDrawerOpen(true);
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      setMobileDrawerOpen(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [mobilePanel]);

  useEffect(() => {
    if (!mobilePanel) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeMobilePanel();
    };
    window.addEventListener("keydown", onKeyDown);
    queueMicrotask(() => document.getElementById(mobileCloseId)?.focus());
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileCloseId, mobilePanel]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1050px)");
    const onChange = () => {
      if (!media.matches) {
        setMobileDrawerOpen(false);
        setMobilePanel(null);
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.nodeId, node])), [nodes]);
  const unitById = useMemo(
    () => new Map((aggregate?.units ?? []).map((unit) => [unit.id, unit])),
    [aggregate?.units],
  );
  const continuityByUnit = useMemo(() => {
    const grouped = new Map();
    for (const candidate of continuity?.candidates ?? []) {
      const list = grouped.get(candidate.targetUnitId) ?? [];
      list.push(candidate);
      grouped.set(candidate.targetUnitId, list);
    }
    return grouped;
  }, [continuity?.candidates]);
  const unitTitleById = useMemo(() => new Map((aggregate?.units ?? []).map((unit) => [
    unit.id,
    nodeById.get(unit.curriculumNodeId)?.title ?? `单元 ${unit.sortNo}`,
  ])), [aggregate?.units, nodeById]);

  useEffect(() => {
    if (!aggregate || !activeUnitId) return undefined;
    const descendantNodeIds = (() => {
      const activeUnit = aggregate.units.find((unit) => unit.id === activeUnitId);
      if (!activeUnit) return [];
      const childrenByParent = new Map();
      for (const node of nodes) {
        const list = childrenByParent.get(node.parentId) ?? [];
        list.push(node);
        childrenByParent.set(node.parentId, list);
      }
      const result = [];
      const pending = [...(childrenByParent.get(activeUnit.curriculumNodeId) ?? [])];
      while (pending.length) {
        const node = pending.shift();
        result.push(node.nodeId);
        pending.push(...(childrenByParent.get(node.nodeId) ?? []));
      }
      return result;
    })();
    const nodeIds = [...new Set([
      ...descendantNodeIds,
      ...aggregate.blueprints
        .filter((blueprint) => blueprint.semesterUnitId === activeUnitId)
        .map((blueprint) => blueprint.curriculumNodeId),
    ])]
      .filter((nodeId) => !knowledgeByNodeId[nodeId]);
    if (!nodeIds.length) return undefined;
    let cancelled = false;
    agentApi.readCurriculumKnowledgePointsBatch(
      aggregate.framework.textbookId,
      nodeIds,
    ).then(({ records }) => {
      if (!cancelled) setKnowledgeByNodeId((current) => ({
        ...current,
        ...records,
      }));
    }).catch(() => {
      if (!cancelled) setKnowledgeByNodeId((current) => ({
        ...current,
        ...Object.fromEntries(nodeIds.map((nodeId) => [nodeId, { points: [] }])),
      }));
    });
    return () => { cancelled = true; };
  }, [activeUnitId, aggregate, knowledgeByNodeId, nodes]);

  const handleCanonicalFramework = useCallback((updated) => {
    setAggregate(updated);
    setContinuity((current) => (current ? { ...current, candidates: [] } : current));
  }, []);

  const navigateToUnit = (unitId, { closeMobile = false } = {}) => {
    setActiveUnitId(unitId);
    if (closeMobile) closeMobilePanel();
    // Scroll only the center column. Native scrollIntoView also walks other
    // scrollable ancestors and can yank nested overflow panes.
    queueMicrotask(() => {
      const root = mainScrollRef.current;
      const target = unitRefs.current.get(unitId);
      if (!root || !target || !root.contains(target)) return;
      const top = target.getBoundingClientRect().top
        - root.getBoundingClientRect().top
        + root.scrollTop
        - 32;
      root.scrollTo({
        top: Math.max(0, top),
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    });
  };

  const saveUnitOperations = async (operations) => {
    const updated = await agentApi.updateSemesterFramework(frameworkId, {
      baseFrameworkVersion: aggregate.framework.version,
      summary: "教师更新单元规划",
      operations,
    });
    setAggregate(updated);
    setContinuity((current) => current ? { ...current, candidates: [] } : current);
    toast.success("单元规划已保存");
  };

  const refreshContinuity = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await agentApi.refreshSemesterFrameworkContinuity(frameworkId);
      setContinuity(result);
      const verifiedCount = result.candidates.filter((candidate) => candidate.evidenceKind !== "lexical_similarity").length;
      const suggestedCount = result.candidates.length - verifiedCount;
      const acceptedCount = result.candidates.filter((candidate) => candidate.decision === "accepted").length;
      toast.success(result.candidates.length
        ? `找到 ${result.candidates.length} 条教学衔接（${verifiedCount} 条已核验，${suggestedCount} 条待判断${acceptedCount ? `，${acceptedCount} 条已采用` : ""}）`
        : "已核验，当前没有足够证据形成连续性建议");
    } finally {
      setRefreshing(false);
    }
  };

  const decideContinuity = async (candidate, decision) => {
    if (decidingFingerprint) return;
    setDecidingFingerprint(candidate.fingerprint);
    try {
      const result = await agentApi.setSemesterFrameworkContinuityDecision(frameworkId, {
        fingerprint: candidate.fingerprint,
        decision,
      });
      setContinuity(result);
      toast.success(
        decision === "accepted" ? "已采用这条教学衔接"
          : decision === "dismissed" ? "已排除这条教学衔接"
            : "已撤销取舍",
      );
    } catch (error) {
      toast.error(`无法保存取舍：${error.message}`);
    } finally {
      setDecidingFingerprint(null);
    }
  };

  const saveBlueprint = async (values, idempotencyKey) => {
    const updated = blueprintTarget.blueprint
      ? await agentApi.updateLessonBlueprint(
          frameworkId,
          blueprintTarget.blueprint.id,
          values,
          idempotencyKey,
        )
      : await agentApi.createLessonBlueprint(frameworkId, values, idempotencyKey);
    setAggregate(updated);
    setBlueprintTarget(null);
    toast.success(blueprintTarget.blueprint ? "课时蓝图已更新" : "课时蓝图已加入单元");
  };

  const deleteBlueprint = async (values, idempotencyKey) => {
    const updated = await agentApi.deleteLessonBlueprint(
      frameworkId,
      blueprintTarget.blueprint.id,
      values,
      idempotencyKey,
    );
    setAggregate(updated);
    setContinuity((current) => current ? { ...current, candidates: [] } : current);
    setBlueprintTarget(null);
    toast.success("课时蓝图已删除");
  };

  const openMobileSidecar = (view) => {
    setSidecarView(view);
    openMobilePanel("sidecar");
  };

  const handleMobileDrawerTransitionEnd = (event) => {
    if (event.target !== event.currentTarget) return;
    if (event.propertyName !== "transform") return;
    if (!mobileDrawerOpen) setMobilePanel(null);
  };

  if (loading) {
    return (
      <section
        className="semester-framework-workspace is-loading"
        aria-label="正在加载学期框架"
        aria-busy="true"
        aria-live="polite"
      >
        <LoaderCircle className="animate-spin" aria-hidden="true" />
        <span>正在读取教材目录与教学框架</span>
      </section>
    );
  }

  if (loadError || !aggregate) {
    return (
      <section className="semester-framework-workspace is-error" aria-label="学期框架加载失败" role="alert">
        <p>无法打开学期框架{loadError ? `：${loadError}` : "。"}</p>
        <div className="framework-error-actions">
          <Button onClick={() => setLoadNonce((value) => value + 1)}>
            <RefreshCw aria-hidden="true" />
            重试
          </Button>
          <Button variant="ghost" onClick={onClose}>
            <ArrowLeft aria-hidden="true" />
            返回备课本
          </Button>
        </div>
      </section>
    );
  }

  const { framework, units, blueprints } = aggregate;
  const plannedPeriods = units.reduce((sum, unit) => sum + unit.plannedPeriods, 0);
  const availablePeriods = Math.floor(framework.totalWeeks * framework.weeklyPeriods * framework.capacityRatio);
  const selectedUnit = unitById.get(activeUnitId) ?? units[0];
  const selectedCandidates = continuityByUnit.get(selectedUnit?.id) ?? [];

  const unitNavProps = {
    textbook,
    plannedPeriods,
    availablePeriods,
    capacityRatio: framework.capacityRatio,
    units,
    selectedUnitId: selectedUnit?.id,
    nodeById,
  };

  const continuityPanel = (
    <FrameworkContinuityPanel
      continuity={continuity}
      selectedCandidates={selectedCandidates}
      unitById={unitById}
      nodeById={nodeById}
      refreshing={refreshing}
      decidingFingerprint={decidingFingerprint}
      onRefresh={refreshContinuity}
      onDecide={decideContinuity}
    />
  );

  const assistantPanel = (
    <SemesterFrameworkAgentPanel
      notebook={notebook}
      aggregate={aggregate}
      activeUnitId={selectedUnit?.id ?? null}
      unitTitleById={unitTitleById}
      onCanonicalFramework={handleCanonicalFramework}
      onNavigateToUnit={navigateToUnit}
      initialPrompt={pendingWritebackPrompt}
      onInitialPromptConsumed={() => setPendingWritebackPrompt(null)}
      railMode={sidecarView}
      onRailModeChange={setSidecarView}
      continuitySlot={continuityPanel}
    />
  );

  const sidecarBody = assistantPanel;

  return (
    <section className="semester-framework-workspace" aria-label={framework.title}>
      <div className="framework-workspace-shell" inert={mobilePanel ? true : undefined}>
        <div className="framework-mobile-switcher" aria-label="框架页工具">
          <Button
            className="framework-mobile-units-trigger"
            size="icon-sm"
            variant="outline"
            type="button"
            aria-label="打开单元目录"
            aria-pressed={mobilePanel === "units"}
            onClick={() => openMobilePanel("units")}
          >
            <List aria-hidden="true" />
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            type="button"
            aria-label="打开备课助手"
            aria-pressed={mobilePanel === "sidecar" && sidecarView === "assistant"}
            onClick={() => openMobileSidecar("assistant")}
          >
            <MessageCircle aria-hidden="true" />
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            type="button"
            aria-label="打开教学衔接"
            aria-pressed={mobilePanel === "sidecar" && sidecarView === "continuity"}
            onClick={() => openMobileSidecar("continuity")}
          >
            <Link2 aria-hidden="true" />
          </Button>
        </div>

        <div className="framework-layout">
          <aside className="framework-unit-nav" aria-label="单元目录">
            <div className="framework-nav-header">
              <FrameworkOutlineBack
                title={framework.title}
                subtitle={`${notebook.title} · V${framework.version}`}
                onClose={onClose}
              />
            </div>
            <div className="framework-nav-body">
              <FrameworkUnitNav
                {...unitNavProps}
                onSelectUnit={(unitId) => navigateToUnit(unitId)}
              />
            </div>
          </aside>

          <main className="framework-main" ref={mainScrollRef}>
            {units.map((unit) => {
              const unitTitle = nodeById.get(unit.curriculumNodeId)?.title ?? `单元 ${unit.sortNo}`;
              const unitBlueprints = blueprints.filter((blueprint) => blueprint.semesterUnitId === unit.id);
              return (
                <article
                  className="framework-unit"
                  ref={(element) => {
                    if (element) unitRefs.current.set(unit.id, element);
                  }}
                  key={unit.id}
                >
                  <div className="framework-unit-heading">
                    <h2>{unitTitle}</h2>
                    <Button size="sm" variant="outline" onClick={() => setBlueprintTarget({ unit, unitTitle, blueprint: null })}>
                      <Plus aria-hidden="true" />
                      新增课时蓝图
                    </Button>
                  </div>
                  <UnitPlanningEditor unit={unit} totalWeeks={framework.totalWeeks} onSave={saveUnitOperations} />
                  <div className="framework-blueprints">
                    {unitBlueprints.length ? unitBlueprints.map((blueprint) => {
                      const lessonFile = notebook.files.find((file) => (
                        file.lessonBlueprintId === blueprint.id
                      ));
                      const knowledgeRecord = knowledgeByNodeId[blueprint.curriculumNodeId];
                      const periodContext = lessonPeriodContext(blueprint, unitBlueprints, knowledgeRecord);
                      const knowledge = periodContext.points;
                      const knowledgeIds = new Set(knowledge.map((item) => item.point.id));
                      const lessonContinuity = selectContinuityForDraft(
                        (continuityByUnit.get(unit.id) ?? []).filter((candidate) => (
                          knowledgeIds.has(candidate.currentEntityId)
                        )),
                      );
                      const plannedMinutes = blueprint.plannedMinutes ?? framework.lessonDurationMinutes;
                      return (
                        <div className="framework-blueprint" key={blueprint.id}>
                          <div className="framework-blueprint-header">
                            <span
                              className="framework-blueprint-period"
                              aria-label={`单元第 ${blueprint.plannedPeriod} 课时`}
                            >
                              {blueprint.plannedPeriod}
                            </span>
                            <div className="framework-blueprint-heading">
                              <h3>{blueprint.title}</h3>
                              <div className="framework-blueprint-tags">
                                <Badge variant="secondary">{plannedMinutes} 分钟</Badge>
                                {periodContext.missingPeriods ? (
                                  <Badge variant="destructive">本篇缺 {periodContext.missingPeriods} 课时</Badge>
                                ) : null}
                              </div>
                            </div>
                          </div>
                          <div className="framework-blueprint-body">
                            {knowledge.length ? (
                              <div className="framework-blueprint-knowledge">
                                {knowledge.map((item) => (
                                  <mark key={item.point.id}>{item.point.canonicalName}</mark>
                                ))}
                              </div>
                            ) : null}
                            <p className="framework-blueprint-activity">
                              {blueprint.mainActivity || "尚未填写主要活动"}
                            </p>
                            <dl className="framework-blueprint-meta">
                              <div>
                                <dt>产出</dt>
                                <dd>{blueprint.observableProduct || "待明确"}</dd>
                              </div>
                              <div>
                                <dt>证据</dt>
                                <dd>{blueprint.assessmentEvidence || "待明确"}</dd>
                              </div>
                              {lessonContinuity.slice(0, 2).map((candidate) => (
                                <div className="framework-blueprint-continuity" key={candidate.id}>
                                  <dt>{candidate.direction === "review" ? "承接" : "铺垫"}</dt>
                                  <dd>
                                    {candidate.direction === "review"
                                      ? `${candidate.relatedPointName} → ${candidate.currentPointName}`
                                      : `${candidate.currentPointName} → ${candidate.relatedPointName}`}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                          <div className="framework-blueprint-actions">
                            <div className="framework-blueprint-actions-secondary">
                              <Button size="sm" variant="ghost" onClick={() => setBlueprintTarget({ unit, unitTitle, blueprint })}>
                                <Pencil aria-hidden="true" />
                                编辑
                              </Button>
                              {lessonFile ? (
                                <>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      setFeedbackTarget({
                                        lessonFileId: lessonFile.id,
                                        blueprint,
                                        unit,
                                        candidates: lessonContinuity,
                                      });
                                      setFeedbackKind("observation");
                                      setFeedbackStatement("");
                                      setFeedbackFingerprint(lessonContinuity[0]?.fingerprint ?? "");
                                      setFeedbackOutcome("weak");
                                    }}
                                  >
                                    <MessageSquareText aria-hidden="true" />
                                    反馈
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={creatingLessonId === blueprint.id}
                                    onClick={async () => {
                                      setCreatingLessonId(blueprint.id);
                                      try {
                                        await onCreateLesson({
                                          blueprint,
                                          unit,
                                          unitTitle,
                                          textbook,
                                          framework,
                                          knowledgeRecord,
                                          continuityCandidates: lessonContinuity,
                                          unitBlueprints,
                                          action: "regenerate",
                                        });
                                      } finally {
                                        setCreatingLessonId(null);
                                      }
                                    }}
                                  >
                                    <RefreshCw aria-hidden="true" />
                                    重生成
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={`删除${blueprint.title}的教案`}
                                    onClick={() => onDeleteLesson?.({ blueprint, framework })}
                                  >
                                    <Trash2 aria-hidden="true" />
                                    删除
                                  </Button>
                                </>
                              ) : null}
                            </div>
                            <div className="framework-blueprint-actions-primary">
                              <Button
                                size="sm"
                                disabled={creatingLessonId === blueprint.id}
                                onClick={async () => {
                                  setCreatingLessonId(blueprint.id);
                                  try {
                                    await onCreateLesson({
                                      blueprint,
                                      unit,
                                      unitTitle,
                                      textbook,
                                      framework,
                                      knowledgeRecord,
                                      continuityCandidates: lessonContinuity,
                                      unitBlueprints,
                                      action: lessonFile ? "view" : "create",
                                    });
                                  } finally {
                                    setCreatingLessonId(null);
                                  }
                                }}
                              >
                                {creatingLessonId === blueprint.id
                                  ? <LoaderCircle className="animate-spin" aria-hidden="true" />
                                  : lessonFile
                                    ? <BookOpen aria-hidden="true" />
                                    : <FilePlus2 aria-hidden="true" />}
                                {lessonFile ? "查看教案" : "生成教案"}
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    }) : (
                      <button
                        className="framework-blueprint-empty"
                        type="button"
                        onClick={() => setBlueprintTarget({ unit, unitTitle, blueprint: null })}
                      >
                        <BookOpen aria-hidden="true" />
                        <span>
                          <strong>还没有课时蓝图</strong>
                          <small>先选教材章节，再确定这一课最重要的教学活动。</small>
                        </span>
                        <Plus aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </main>

          <aside className="framework-sidecar lesson-assistant-rail" aria-label="学期规划辅助面板">
            {mobilePanel === "sidecar" ? null : sidecarBody}
          </aside>
        </div>
      </div>

      {mobilePanel ? (
        <div className={`framework-mobile-layer${mobileDrawerOpen ? " is-open" : ""}`}>
          <button
            className="framework-mobile-backdrop"
            type="button"
            aria-label="关闭面板"
            onClick={closeMobilePanel}
          />
          <aside
            className={`framework-mobile-drawer is-${mobilePanel}`}
            role="dialog"
            aria-modal="true"
            aria-label={mobilePanel === "units" ? "单元目录" : "学期规划辅助面板"}
            onTransitionEnd={handleMobileDrawerTransitionEnd}
          >
            <div className="framework-mobile-drawer-header">
              <strong>{mobilePanel === "units" ? "单元目录" : "规划辅助"}</strong>
              <Button
                id={mobileCloseId}
                size="icon-sm"
                variant="ghost"
                aria-label="关闭面板"
                onClick={closeMobilePanel}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            {mobilePanel === "units" ? (
              <div className="framework-mobile-unit-nav">
                <FrameworkOutlineBack
                  title={framework.title}
                  subtitle={`${notebook.title} · V${framework.version}`}
                  onClose={onClose}
                />
                <FrameworkUnitNav
                  {...unitNavProps}
                  onSelectUnit={(unitId) => navigateToUnit(unitId, { closeMobile: true })}
                />
              </div>
            ) : (
              <div className="framework-mobile-sidecar lesson-assistant-rail">
                {sidecarBody}
              </div>
            )}
          </aside>
        </div>
      ) : null}

      {blueprintTarget && (
        <BlueprintDialog
          unit={blueprintTarget.unit}
          unitTitle={blueprintTarget.unitTitle}
          nodes={nodes}
          blueprint={blueprintTarget.blueprint}
          lessonDuration={framework.lessonDurationMinutes}
          unitBlueprints={blueprints.filter((item) => item.semesterUnitId === blueprintTarget.unit.id)}
          knowledgeByNodeId={knowledgeByNodeId}
          onClose={() => setBlueprintTarget(null)}
          onSave={saveBlueprint}
          onDelete={deleteBlueprint}
        />
      )}

      <Dialog open={Boolean(feedbackTarget)} onOpenChange={(open) => !open && setFeedbackTarget(null)}>
        <DialogContent className="framework-blueprint-dialog">
          <DialogHeader>
            <DialogTitle>记录课堂反馈</DialogTitle>
            <DialogDescription>
              {feedbackTarget
                ? `把「${feedbackTarget.blueprint.title}」课堂上的真实情况记下来，供后续课时规划读取。`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="class-feedback-kind">反馈类型</FieldLabel>
              <Select value={feedbackKind} onValueChange={setFeedbackKind}>
                <SelectTrigger id="class-feedback-kind">
                  <SelectValue>
                    {(value) => classFeedbackKindLabels[value] ?? "选择反馈类型"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {Object.entries(classFeedbackKindLabels).map(([value, label]) => (
                      <SelectItem value={value} key={value}>{label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {feedbackKind === "continuity_outcome" ? (
                <p className="framework-feedback-hint">
                  将补充对应衔接与课堂效果；偏弱或未落实时，助手可提出下一课时蓝图修改确认。
                </p>
              ) : null}
              <p className="framework-feedback-hint">
                {classFeedbackProvenance[feedbackKind].label}：
                {classFeedbackProvenance[feedbackKind].hint}
              </p>
            </Field>
            {feedbackKind === "continuity_outcome" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="class-feedback-link">对应衔接</FieldLabel>
                  <Select
                    value={feedbackFingerprint || undefined}
                    onValueChange={setFeedbackFingerprint}
                    disabled={!feedbackTarget?.candidates?.length}
                  >
                    <SelectTrigger id="class-feedback-link">
                      <SelectValue placeholder={feedbackTarget?.candidates?.length ? "选择衔接候选" : "本课暂无衔接候选"}>
                        {(value) => continuityCandidateLabel(
                          (feedbackTarget?.candidates ?? []).find((candidate) => (
                            candidate.fingerprint === value
                          )),
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {(feedbackTarget?.candidates ?? []).map((candidate) => (
                          <SelectItem key={candidate.fingerprint} value={candidate.fingerprint}>
                            {continuityCandidateLabel(candidate)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {!feedbackTarget?.candidates?.length ? (
                    <p className="framework-feedback-hint">
                      本课还没有可用衔接候选。可先在「教学衔接」中取舍，或改记课堂观察/练习缺口。
                    </p>
                  ) : null}
                  {selectedFeedbackCandidate ? (
                    <p className="framework-feedback-hint">
                      {continuityCandidateEvidence(selectedFeedbackCandidate)}
                    </p>
                  ) : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="class-feedback-outcome">课堂效果</FieldLabel>
                  <Select value={feedbackOutcome} onValueChange={setFeedbackOutcome}>
                    <SelectTrigger id="class-feedback-outcome">
                      <SelectValue>
                        {(value) => classFeedbackOutcomeLabels[value] ?? "选择课堂效果"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {Object.entries(classFeedbackOutcomeLabels).map(([value, label]) => (
                          <SelectItem value={value} key={value}>{label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </>
            ) : null}
            <Field>
              <FieldLabel htmlFor="class-feedback-statement">课堂记录</FieldLabel>
              <Textarea
                id="class-feedback-statement"
                value={feedbackStatement}
                onChange={(event) => setFeedbackStatement(event.target.value)}
                placeholder={
                  feedbackKind === "continuity_outcome"
                    ? "例如：复习写景顺序时只有半数学生能独立完成，下一课时需要补一个短任务。"
                    : "例如：比喻本体喻体仍易混；复习写景顺序时只有半数学生能独立完成。"
                }
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="gap-3">
            <Button variant="ghost" onClick={() => setFeedbackTarget(null)}>取消</Button>
            <Button
              disabled={
                feedbackSubmitting
                || !feedbackStatement.trim()
                || (
                  feedbackKind === "continuity_outcome"
                  && (!feedbackFingerprint || !feedbackOutcome)
                )
              }
              onClick={async () => {
                if (!feedbackTarget) return;
                const selectedCandidate = (feedbackTarget.candidates ?? []).find((candidate) => (
                  candidate.fingerprint === feedbackFingerprint
                ));
                if (feedbackKind === "continuity_outcome" && !selectedCandidate) {
                  toast.error("请先选择对应的衔接候选");
                  return;
                }
                setFeedbackSubmitting(true);
                try {
                  const created = await agentApi.createLessonClassFeedback(feedbackTarget.lessonFileId, {
                    kind: feedbackKind,
                    statement: feedbackStatement.trim(),
                    lessonBlueprintId: feedbackTarget.blueprint.id,
                    semesterFrameworkId: framework.id,
                    ...(feedbackKind === "continuity_outcome"
                      ? {
                          continuityFingerprint: selectedCandidate.fingerprint,
                          continuityDirection: selectedCandidate.direction,
                          continuityOutcome: feedbackOutcome,
                        }
                      : {}),
                    evidence: {
                      origin: "teacher_classroom_record",
                      informationLevel: classFeedbackProvenance[feedbackKind].label,
                    },
                  });
                  if (created.writebackSeed) {
                    setPendingWritebackPrompt(created.writebackSeed);
                    setSidecarView("assistant");
                    openMobileSidecar("assistant");
                    toast.success("衔接效果已记录，助手正在准备下一课时调整确认");
                  } else {
                    toast.success("课堂反馈已记录，后续规划助手可读取");
                  }
                  setFeedbackTarget(null);
                } catch (error) {
                  toast.error(`无法保存反馈：${error.message}`);
                } finally {
                  setFeedbackSubmitting(false);
                }
              }}
            >
              {feedbackSubmitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              保存反馈
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
