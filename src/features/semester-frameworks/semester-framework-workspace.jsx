import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  FilePlus2,
  Link2,
  LoaderCircle,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BlueprintDialog } from "@/features/semester-frameworks/blueprint-dialog";
import { lessonPeriodContext } from "@/features/semester-frameworks/lesson-blueprint-context";
import { SemesterFrameworkAgentPanel } from "@/features/semester-frameworks/semester-framework-agent-panel";
import { agentApi } from "@/lib/agent-api";

const unitStatusLabels = {
  unplanned: "待规划",
  planned: "已规划",
  in_progress: "进行中",
  completed: "已完成",
  deferred: "已顺延",
};

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
      <div className="framework-unit-schedule">
        <label>起始周<Input type="number" min="1" max={totalWeeks} value={startWeek} onChange={(event) => setStartWeek(event.target.value)} placeholder="—" /></label>
        <span>至</span>
        <label>结束周<Input type="number" min="1" max={totalWeeks} value={endWeek} onChange={(event) => setEndWeek(event.target.value)} placeholder="—" /></label>
        <label>课时<Input type="number" min="0" max="100" value={plannedPeriods} onChange={(event) => setPlannedPeriods(event.target.value)} /></label>
      </div>
      <label className="framework-unit-goals">单元目标<Textarea value={learningGoals} onChange={(event) => setLearningGoals(event.target.value)} placeholder="学生完成本单元后能够做什么？" /></label>
      <Button size="sm" variant={changes.length ? "default" : "outline"} disabled={!changes.length || saving} onClick={save}>
        {saving ? <LoaderCircle className="animate-spin" /> : changes.length ? <Save /> : <Check />}
        {saving ? "保存中" : changes.length ? "保存单元" : "已同步"}
      </Button>
    </div>
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
  const [refreshing, setRefreshing] = useState(false);
  const [creatingLessonId, setCreatingLessonId] = useState(null);
  const [knowledgeByNodeId, setKnowledgeByNodeId] = useState({});
  const [sidecarView, setSidecarView] = useState("assistant");
  const unitRefs = useRef(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const framework = await agentApi.getSemesterFramework(frameworkId);
        const [outline, nextTextbook, nextContinuity] = await Promise.all([
          agentApi.listCurriculumReleaseNodes(
            framework.framework.catalogReleaseId,
            framework.framework.textbookId,
            { maxLevel: 8 },
          ),
          agentApi.getCurriculumReleaseTextbook(
            framework.framework.catalogReleaseId,
            framework.framework.textbookId,
          ),
          agentApi.refreshSemesterFrameworkContinuity(frameworkId),
        ]);
        if (cancelled) return;
        setAggregate(framework);
        setNodes(outline.nodes ?? []);
        setTextbook(nextTextbook.textbook ?? nextTextbook);
        setContinuity(nextContinuity);
        setActiveUnitId(framework.units[0]?.id ?? null);
      } catch (error) {
        if (!cancelled) toast.error(`无法打开学期框架：${error.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [frameworkId]);

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

  const navigateToUnit = (unitId) => {
    setActiveUnitId(unitId);
    unitRefs.current.get(unitId)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      toast.success(result.candidates.length
        ? `找到 ${result.candidates.length} 条教学衔接（${verifiedCount} 条已核验，${suggestedCount} 条待判断）`
        : "已核验，当前没有足够证据形成连续性建议");
    } finally {
      setRefreshing(false);
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

  if (loading || !aggregate) {
    return <section className="semester-framework-workspace is-loading" aria-label="正在加载学期框架"><LoaderCircle className="animate-spin" /><span>正在读取教材目录与教学框架</span></section>;
  }

  const { framework, units, blueprints } = aggregate;
  const plannedPeriods = units.reduce((sum, unit) => sum + unit.plannedPeriods, 0);
  const availablePeriods = Math.floor(framework.totalWeeks * framework.weeklyPeriods * framework.capacityRatio);
  const selectedUnit = unitById.get(activeUnitId) ?? units[0];
  const selectedCandidates = continuityByUnit.get(selectedUnit?.id) ?? [];

  return (
    <section className="semester-framework-workspace" aria-label={framework.title}>
      <header className="framework-header">
        <Button variant="ghost" onClick={onClose}><ArrowLeft />返回备课本</Button>
        <div className="framework-header-copy"><span>{notebook.title}</span><h1>{framework.title}</h1></div>
        <div className="framework-header-actions">
          <span className="framework-version">V{framework.version}</span>
          <Button variant="outline" disabled={refreshing} onClick={refreshContinuity}>{refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}更新教学衔接</Button>
        </div>
      </header>

      <div className="framework-layout">
        <aside className="framework-unit-nav" aria-label="单元目录">
          <div className="framework-overview">
            <span>{textbook?.edition} · {textbook?.grade}{textbook?.volume}</span>
            <strong>{plannedPeriods} / {availablePeriods}</strong>
            <small>已规划课时 / 90% 可用容量</small>
          </div>
          <nav>{units.map((unit) => {
            const title = nodeById.get(unit.curriculumNodeId)?.title ?? `单元 ${unit.sortNo}`;
            return <button className={unit.id === selectedUnit?.id ? "is-active" : ""} type="button" onClick={() => {
              navigateToUnit(unit.id);
            }} key={unit.id}><span>{String(unit.sortNo).padStart(2, "0")}</span><strong>{title}</strong><small>{unitStatusLabels[unit.status]}</small><ChevronRight /></button>;
          })}</nav>
        </aside>

        <main className="framework-main">
          {units.map((unit) => {
            const unitTitle = nodeById.get(unit.curriculumNodeId)?.title ?? `单元 ${unit.sortNo}`;
            const unitBlueprints = blueprints.filter((blueprint) => blueprint.semesterUnitId === unit.id);
            return <article className="framework-unit" ref={(element) => { if (element) unitRefs.current.set(unit.id, element); }} key={unit.id}>
              <div className="framework-unit-heading"><div><span>单元 {String(unit.sortNo).padStart(2, "0")}</span><h2>{unitTitle}</h2></div><Button size="sm" variant="outline" onClick={() => setBlueprintTarget({ unit, unitTitle, blueprint: null })}><Plus />新增课时蓝图</Button></div>
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
                  const lessonContinuity = (continuityByUnit.get(unit.id) ?? []).filter((candidate) => (
                    knowledgeIds.has(candidate.currentEntityId)
                  ));
                  return (
                  <div className="framework-blueprint" key={blueprint.id}>
                    <div className="framework-blueprint-index">单元第 {blueprint.plannedPeriod} 课时<br /><small>本篇第 {periodContext.periodNo} / {periodContext.periodCount} 课时 · {blueprint.plannedMinutes ?? framework.lessonDurationMinutes} 分钟</small>{periodContext.missingPeriods ? <small className="is-warning">本篇还缺 {periodContext.missingPeriods} 个课时蓝图</small> : null}</div>
                    <div className="framework-blueprint-copy"><h3>{blueprint.title}</h3>{knowledge.length ? <div className="framework-blueprint-knowledge"><span>重点知识</span>{knowledge.map((item) => <mark key={item.point.id}>{item.point.canonicalName}</mark>)}</div> : null}<p>{blueprint.mainActivity || "尚未填写主要活动"}</p><div><span>学生产出：{blueprint.observableProduct || "待明确"}</span><span>达成证据：{blueprint.assessmentEvidence || "待明确"}</span>{lessonContinuity.slice(0, 2).map((candidate) => <span className="framework-blueprint-continuity" key={candidate.id}>{candidate.direction === "review" ? `复习承接：${candidate.relatedPointName} → ${candidate.currentPointName}` : `后续铺垫：${candidate.currentPointName} → ${candidate.relatedPointName}`}</span>)}</div></div>
                    <div className="framework-blueprint-actions">
                      <Button size="sm" variant="ghost" onClick={() => setBlueprintTarget({ unit, unitTitle, blueprint })}><Pencil />编辑</Button>
                      <Button size="sm" disabled={creatingLessonId === blueprint.id} onClick={async () => { setCreatingLessonId(blueprint.id); try { await onCreateLesson({ blueprint, unit, unitTitle, textbook, framework, knowledgeRecord, continuityCandidates: lessonContinuity, unitBlueprints, action: lessonFile ? "view" : "create" }); } finally { setCreatingLessonId(null); } }}>{creatingLessonId === blueprint.id ? <LoaderCircle className="animate-spin" /> : <FilePlus2 />}{lessonFile ? "查看教案" : "生成教案"}</Button>
                      {lessonFile ? <>
                        <Button size="sm" variant="ghost" disabled={creatingLessonId === blueprint.id} onClick={async () => { setCreatingLessonId(blueprint.id); try { await onCreateLesson({ blueprint, unit, unitTitle, textbook, framework, knowledgeRecord, continuityCandidates: lessonContinuity, unitBlueprints, action: "regenerate" }); } finally { setCreatingLessonId(null); } }}><RefreshCw />重新生成</Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`删除${blueprint.title}的教案`} onClick={() => onDeleteLesson?.({ blueprint, framework })}><Trash2 /></Button>
                      </> : null}
                    </div>
                  </div>
                  );
                }) : <button className="framework-blueprint-empty" type="button" onClick={() => setBlueprintTarget({ unit, unitTitle, blueprint: null })}><BookOpen /><span><strong>还没有课时蓝图</strong><small>先选教材章节，再确定这一课最重要的教学活动。</small></span><Plus /></button>}
              </div>
            </article>;
          })}
        </main>

        <aside className="framework-sidecar" aria-label="学期规划辅助面板">
          <div className="framework-sidecar-tabs" role="tablist" aria-label="切换辅助内容">
            <button type="button" role="tab" aria-selected={sidecarView === "assistant"} onClick={() => setSidecarView("assistant")}><MessageCircle />助手</button>
            <button type="button" role="tab" aria-selected={sidecarView === "continuity"} onClick={() => setSidecarView("continuity")}><Link2 />教学衔接</button>
          </div>
          {sidecarView === "assistant" ? (
            <SemesterFrameworkAgentPanel
              notebook={notebook}
              aggregate={aggregate}
              activeUnitId={selectedUnit?.id ?? null}
              unitTitleById={unitTitleById}
              onCanonicalFramework={(updated) => {
                setAggregate(updated);
                setContinuity((current) => current ? { ...current, candidates: [] } : current);
              }}
              onNavigateToUnit={navigateToUnit}
            />
          ) : (
            <div className="framework-continuity" aria-label="教学衔接">
              <div className="framework-continuity-heading"><Link2 /><div><h2>教学衔接</h2><p>系统自动寻找可用于复习旧知和后续铺垫的内容</p></div></div>
              {continuity?.status === "semantic_release_unavailable" ? <p className="framework-continuity-empty">当前教材还没有已发布知识点，系统不会猜测关联。</p> : selectedCandidates.length ? <div className="framework-continuity-list">{selectedCandidates.map((candidate) => {
                const relatedUnit = unitById.get(candidate.relatedUnitId);
                const relatedTitle = nodeById.get(relatedUnit?.curriculumNodeId)?.title ?? "相关单元";
                const suggested = candidate.evidenceKind === "lexical_similarity";
                return <div className={`framework-continuity-item direction-${candidate.direction}`} key={candidate.id}><span>{candidate.direction === "review" ? "复习旧知" : "后续铺垫"} · {suggested ? "待判断" : "已核验"}</span><strong>{candidate.currentPointName}</strong><p>{candidate.rationale}</p><small>{candidate.direction === "review" ? "可能承接" : "可能铺垫"}：{relatedTitle} · {candidate.relatedPointName}</small></div>;
              })}</div> : <div className="framework-continuity-empty"><p>{refreshing ? "正在分析当前教材中的前后关联…" : "当前单元暂未找到值得采用的教学衔接。系统不会为了填满内容而强行建立关系。"}</p><Button size="sm" variant="outline" disabled={refreshing} onClick={refreshContinuity}>{refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}重新分析</Button></div>}
            </div>
          )}
        </aside>
      </div>

      {blueprintTarget && <BlueprintDialog unit={blueprintTarget.unit} unitTitle={blueprintTarget.unitTitle} nodes={nodes} blueprint={blueprintTarget.blueprint} lessonDuration={framework.lessonDurationMinutes} unitBlueprints={blueprints.filter((item) => item.semesterUnitId === blueprintTarget.unit.id)} knowledgeByNodeId={knowledgeByNodeId} onClose={() => setBlueprintTarget(null)} onSave={saveBlueprint} onDelete={deleteBlueprint} />}
    </section>
  );
}
