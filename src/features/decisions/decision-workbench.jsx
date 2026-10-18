import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { agentApi } from "@/lib/agent-api";
import { LearningEvidenceForm, evidenceFromPlan, evidencePayload } from "../learning/evidence-form";
import { DecisionOverview, DecisionReferenceDetails } from "./decision-summary";
import { DecisionChoice, DecisionPlanFields, DecisionTextField, emptyObservationPlan, observationPlanComplete } from "./decision-plan-fields";
import { TeacherDecisionForm, lines, teacherDecisionForm } from "./teacher-decision-form";
import { readWorkbenchDraft, writeWorkbenchDraft } from "./workbench-draft";
import "./decision-workbench.css";

const types = { scope_priority: "内容取舍", goal_evidence: "目标与证据", task_sequence: "任务序列", scaffolding: "支架与差异", assessment: "评价证据", implementation_adjustment: "课堂调整", followup: "后续调整", no_change: "保留现稿" };
const statuses = { draft: "草稿", proposed: "待确认", insufficient_evidence: "证据不足", teacher_confirmed: "已确认", teacher_rejected: "已拒绝", no_change: "保留现稿", implemented: "已实施", reviewed: "已审议", superseded: "已替代" };
const outcomes = { supported: "符合预期", not_supported: "未见预期", inconclusive: "证据不足" };
const changedLabels = { decisionType: "类型", question: "问题", options: "方案", chosenOptionId: "采用选项", rationale: "理由", counterevidence: "反例", assumptions: "前提", uncertainties: "不确定性", confidence: "自评数值", expectedSignal: "预期观察", falsifier: "判断边界", reviewAt: "复测时间", observationPlan: "取证计划" };
const rejectionReasons = { insufficient_evidence: "证据不足", not_applicable: "不适用本班", student_mismatch: "不符合学情", other: "其他" };
const errors = {
  invalid_request: "信息校验未通过。请核对必填字段、观察时间与合成数据声明；输入已保留。演示或明确标注非真实学生的观察请勾选合成数据。",
  decision_evidence_source_invalid: "引用的学习观察不属于本课或版本不匹配，请重新选择本课的记录。",
  decision_evidence_excerpt_not_exact: "引用内容与原始观察不一致，请核对原文后重新提交。",
  decision_synthetic_evidence_declared_real: "这条来源是合成或演示观察，请保留合成标记，不能作为真实学生表现。",
  decision_lesson_excerpt_stale: "引用的教案原文或版本已变化。输入已保留，请重新核对当前栏目原文。",
  decision_proposal_not_delivered: "助手候选尚未完成交付，请等待结果后再操作。",
  decision_baseline_not_found: "基线已不存在或不属于本课，请重新选择。",
  decision_baseline_not_comparable: "基线与当前计划的目标、判据、群体、条件或取证方式不同，请核对后重新选择。",
  decision_baseline_after_implementation: "基线观察晚于本次实施时间，请核对两个时间。",
  decision_implementation_time_invalid: "实施时间不能晚于当前时间。",
  decision_review_baseline_required: "尚无可比较的实施前基线，这次只能审议为证据不足。",
  decision_review_synthetic_learning: "合成观察不能确认真实学习变化，请选择证据不足。",
  decision_review_evidence_unlinked: "请选择明确关联本项决策的观察。",
  stale_decision: "决策版本已变化。你的输入仍保留，请同步后核对再提交。", stale_document: "教案版本已变化，请读取当前教案并核对引用。", decision_review_evidence_before_implementation: "复测证据必须晚于实施时间。", decision_review_evidence_not_found: "请选择直接关联本项决策的观察。", decision_invalid: "信息尚不完整，请核对依据、取证计划与判断边界。", decision_observation_plan_required: "确认前请填写结构化取证计划。", decision_review_evidence_not_comparable: "取证口径不同，当前只能记录为证据不足。", decision_review_synthetic_evidence: "合成观察不能确认真实学习变化，请选择证据不足。", idempotency_conflict: "保存内容与上次请求不一致，请先同步原请求结果。" };
const localTime = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 23); };

export function DecisionWorkbench({ file, ownerId = file.ownerId, onAgentRequest, onBeforeWrite, onPrepareDecisionRevision }) {
  const [restored] = useState(() => readWorkbenchDraft("decision", file.id, ownerId));
  const [progress, setProgress] = useState({ decisions: [], evidenceCards: [], loading: true });
  const [selectedId, setSelectedId] = useState(restored?.selectedId ?? null);
  const [mode, setMode] = useState(restored?.mode ?? null);
  const [form, setForm] = useState(restored?.form ?? {});
  const [pending, setPending] = useState(restored?.pending ?? null);
  const [context, setContext] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(restored?.mode ? "已恢复本课未提交的表单。" : "");
  const [observations, setObservations] = useState([]);
  const [observationsNext, setObservationsNext] = useState(null);
  const [loadingObservations, setLoadingObservations] = useState(false);
  const [sourceDocument, setSourceDocument] = useState(file.document ?? file.lessonPlan);
  const [storageWarning, setStorageWarning] = useState(false);
  const mounted = useRef(true); const busyRef = useRef(false); const preparing = useRef(false); const revision = useRef(0);
  const pendingKey = `lessonup:decision-command:${file.id}`;
  const [unknownCommand, setUnknownCommand] = useState(() => sessionStorage.getItem(pendingKey));
  const blocked = busy || Boolean(pending) || Boolean(unknownCommand);
  const selected = progress.decisions.find((item) => item.id === selectedId) ?? null;
  const emit = useCallback((type, extra = {}) => { void agentApi.recordDecisionEvent(file.id, { type, ...extra }).catch(() => undefined); }, [file.id]);
  const refresh = useCallback(async () => {
    const request = ++revision.current; const value = await agentApi.getDecisions(file.id);
    if (!mounted.current || request !== revision.current) return;
    setProgress({ ...value, loading: false });
    setSelectedId((current) => value.decisions.some((item) => item.id === current) ? current : value.decisions[0]?.id ?? null);
  }, [file.id]);
  const clearForm = () => { setMode(null); setForm({}); setError(""); };
  useEffect(() => { setStorageWarning(!writeWorkbenchDraft("decision", file.id, ownerId, { selectedId, mode, form, pending })); }, [file.id, ownerId, selectedId, mode, form, pending]);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => { if (mounted.current) { setProgress((value) => ({ ...value, loading: false })); setError("无法读取教学决策，请同步重试。"); } });
    const update = (event) => { if (event.detail?.lessonFileId === file.id) void refresh().catch(() => setError("记录已保存，最新内容读取失败，请同步。")); };
    window.addEventListener("lessonup:decisions-changed", update);
    return () => { mounted.current = false; revision.current += 1; window.removeEventListener("lessonup:decisions-changed", update); };
  }, [file.id, refresh]);
  useEffect(() => {
    if (!selected) { setContext(null); return; }
    let active = true;
    void agentApi.getDecisionContext(file.id, selected.id).then((value) => { if (active) setContext(value); }).catch(() => { if (active) setContext(null); });
    emit("decision_viewed", { decisionId: selected.id, decisionType: selected.decisionType });
    return () => { active = false; };
  }, [file.id, selected?.id, selected?.version, emit]);
  const finish = async (command, result) => {
    sessionStorage.removeItem(pendingKey); setPending(null); setUnknownCommand(null);
    setMode(null); setForm({}); setNotice("已保存，教师决定与证据已记录。");
    if (result?.id && command.operation === "propose") setSelectedId(result.id);
    const eventTypes = { confirm: "decision_confirmed", reject: "decision_rejected", no_change: "no_change_confirmed", implement: "implementation_recorded", review: "review_recorded" };
    if (command.input?.action && eventTypes[command.input.action]) emit(eventTypes[command.input.action], { decisionId: command.decisionId });
    await refresh().catch(() => setError("保存已完成，最新记录读取失败，请同步。"));
    window.dispatchEvent(new CustomEvent(command.operation === "evidence" ? "lessonup:learning-changed" : "lessonup:decisions-changed", { detail: { lessonFileId: file.id } }));
  };
  const perform = (command) => command.operation === "propose" ? agentApi.proposeDecision(file.id, command.input, command.id) : command.operation === "evidence" ? agentApi.recordLearningEvidence(file.id, command.input, command.id) : agentApi.actOnDecision(file.id, command.decisionId, command.input, command.id);
  const receipt = (commandId, operation = pending?.operation) => operation === "evidence" ? agentApi.getLearningCommandResult(file.id, commandId) : agentApi.getDecisionCommandResult(file.id, commandId);
  const run = async (command) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice(""); setPending(command); setUnknownCommand(command.id);
    sessionStorage.setItem(pendingKey, command.id);
    writeWorkbenchDraft("decision", file.id, ownerId, { selectedId, mode, form, pending: command });
    try { const result = await perform(command); if (mounted.current) await finish(command, result); }
    catch (cause) {
      let saved = null;
      try { saved = await receipt(command.id, command.operation); } catch { /* Preserve the exact original request until its outcome is known. */ }
      if (!mounted.current) return;
      if (saved) { await finish(command, saved); return; }
      if ([400, 403, 404, 409, 422].includes(cause.status) && cause.message !== "idempotency_conflict") { sessionStorage.removeItem(pendingKey); setPending(null); setUnknownCommand(null); }
      setError(errors[cause.message] ?? "未确认保存成功。输入与原请求已保留，请同步或重试同一次保存。");
      void refresh().catch(() => undefined);
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const synchronize = async () => {
    setError("");
    try {
      const key = pending?.id ?? unknownCommand;
      if (key) { const saved = await receipt(key); if (saved) { await finish(pending ?? { id: key }, saved); return; } setError("上次保存尚未确认，请重试原请求或稍后同步；当前输入已保留。"); }
      await refresh();
    } catch { setError("仍无法确认保存结果，请稍后同步。"); }
  };
  useEffect(() => { if (unknownCommand) void synchronize(); /* receipt recovery runs on mount, never resubmits */ }, []);
  const canonical = async () => { const value = await onBeforeWrite?.(); if (value?.document) setSourceDocument(value.document); return value ?? file; };
  const issue = (input) => {
    if (!selected || blocked || preparing.current) return;
    preparing.current = true;
    void (async () => {
      try {
        await canonical();
        await run({ id: crypto.randomUUID(), operation: "act", decisionId: selected.id, input: { ...input, expectedVersion: selected.version } });
      } catch { setError("当前教案尚未同步，输入已保留。请先完成教案保存，再提交本次决定。"); }
      finally { preparing.current = false; }
    })();
  };
  const loadObservations = async (before = null) => {
    if (!selected || loadingObservations) return [];
    const decisionId = selected.id;
    setLoadingObservations(true);
    try {
      const data = await agentApi.getLearningProgress(file.id, { decisionId, ...(before ? { evidenceBefore: before } : {}) });
      if (!mounted.current) return [];
      const records = data.evidence ?? [];
      setObservations((current) => before ? [...new Map([...current, ...records].map((item) => [item.id, item])).values()] : records);
      setObservationsNext(data.next?.evidence ?? null);
      return records;
    } finally { if (mounted.current) setLoadingObservations(false); }
  };
  const openMode = async (next) => {
    if (blocked) return; setError(""); setNotice("");
    try {
      if (["review", "implement"].includes(next)) await loadObservations();
      if (next === "create" || next === "edit") {
        await canonical(); setForm(teacherDecisionForm(next === "edit" ? selected : null));
      } else if (next === "evidence") {
        if (!selected?.observationPlan) { setError("请先完善并确认取证计划，再记录关联观察。"); return; }
        setForm(evidenceFromPlan(selected.observationPlan, selected.id, selected.version));
      } else {
        setForm({ chosenOptionId: selected?.chosenOptionId ?? selected?.options?.[0]?.id ?? "", rationale: next === "reject" ? "" : selected?.rationale ?? "", confidence: selected?.confidence ?? "", reasonCode: "insufficient_evidence", implementedAt: localTime(), note: "", evidenceId: "", outcome: "inconclusive", limitations: "", expectedSignal: selected?.expectedSignal ?? "", falsifier: selected?.falsifier ?? "", assumptionsText: selected?.assumptions?.join("\n") ?? "", uncertaintiesText: selected?.uncertainties?.join("\n") ?? "", observationPlan: selected?.observationPlan ?? emptyObservationPlan(), baselineEvidenceId: selected?.observationPlan?.baselineEvidenceId ?? "" });
      }
      setMode(next);
      if (next === "confirm") emit("option_compared", { decisionId: selected.id, count: selected.options.length });
    } catch { setError("读取当前教案或关联记录失败，已有输入未修改，请同步后重试。"); }
  };
  const saveTeacher = async (status) => {
    if (blocked || preparing.current) return;
    const options = form.options.map(({ id, statement, tradeoffsText }) => ({ id, statement, tradeoffs: lines(tradeoffsText) }));
    if (!form.decisionType || !form.question.trim() || !form.rationale.trim() || options.some((option) => !option.statement.trim() || !option.tradeoffs.length)) { setError("请填写问题、判断理由以及至少两个方案的取舍。"); return; }
    if (form.observationPlan && !observationPlanComplete(form.observationPlan)) { setError("取证计划尚未填完。请补齐，或选择稍后再定以先保存判断草稿。"); return; }
    if (status === "proposed" && (!observationPlanComplete(form.observationPlan) || !form.expectedSignal.trim() || !form.falsifier.trim() || (!form.sourceField && !selected?.evidenceCardIds?.length))) { setError("待确认候选需要原文依据、完整取证计划、预期观察与可改变判断的条件。可先保存草稿。"); return; }
    preparing.current = true;
    try {
      const current = await canonical();
      const input = { contextVersion: { documentVersion: current.documentVersion, frameworkVersion: selected?.contextVersion?.frameworkVersion ?? null }, decisionType: form.decisionType, question: form.question, options, rationale: form.rationale, assumptions: lines(form.assumptionsText), counterevidence: lines(form.counterevidenceText), uncertainties: lines(form.uncertaintiesText), expectedSignal: form.expectedSignal, falsifier: form.falsifier, confidence: form.confidence === "" ? null : Number(form.confidence), observationPlan: form.observationPlan, status,
        ...(form.sourceField ? { lessonEvidence: [{ field: form.sourceField, excerpt: form.sourceExcerpt, claim: form.sourceClaim, applicability: "当前课时的教案设计", limitations: ["这是教案设计材料，不能直接证明学生学习改善。"] }] } : mode === "create" ? { lessonEvidence: [] } : {}) };
      await run({ id: crypto.randomUUID(), operation: mode === "create" ? "propose" : "act", decisionId: selected?.id, input: mode === "create" ? { ...input, createdBy: "teacher", chosenOptionId: null, evidenceCards: [] } : { ...input, action: "revise", expectedVersion: selected.version } });
    } catch { setError("教案尚未保存，判断输入已保留。请完成保存后重试。"); } finally { preparing.current = false; }
  };
  const saveEvidence = async (event) => {
    event.preventDefault(); if (blocked || preparing.current) return;
    preparing.current = true;
    try { const current = await canonical(); await run({ id: crypto.randomUUID(), operation: "evidence", decisionId: selected.id, input: evidencePayload(form, current.documentVersion) }); }
    catch { setError("教案尚未保存，观察输入已保留。请完成保存后重试。"); } finally { preparing.current = false; }
  };
  const requestProposal = () => { emit("proposal_requested", { decisionType: selected?.decisionType }); onAgentRequest?.({ prompt: "请读取当前教案、现有教学决策及其最新确认/实施/审议状态、学习证据和课堂反馈，提出目前最关键的教学决策候选。写清关键判断、适用前提、至少两个选项与代价、可核对原文、反例、不确定性及能真正反驳该判断的观察；区分设计对齐与学习变化。证据不足时记录缺口，不替教师确认、实施或审议。", taskIntent: { type: "decision_proposal" } }); };
  const cards = new Map(progress.evidenceCards.map((card) => [card.id, card]));
  const field = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const isEditable = selected && ["draft", "proposed", "insufficient_evidence"].includes(selected.status);
  const afterImplementation = observations.filter((item) => !selected?.implementation || item.observedAt > selected.implementation.implementedAt);
  return <div className="decision-workbench" aria-label="教学决策" aria-busy={busy}>
    <header><h2>教学决策</h2><p className="decision-meta">核对判断依据，由你决定采用，并分别记录实施与观察。</p><div className="decision-actions"><Button size="sm" type="button" variant="outline" disabled={blocked} onClick={requestProposal}>请助手准备决策</Button><Button size="sm" type="button" variant="ghost" disabled={blocked} onClick={() => openMode("create")}>记录已有判断</Button></div></header>
    {error ? <div className="decision-error" role="alert"><p>{error}</p><div className="decision-actions"><Button size="sm" variant="outline" disabled={busy} onClick={synchronize}>同步记录</Button>{pending ? <Button size="sm" disabled={busy} onClick={() => run(pending)}>重试同次保存</Button> : null}</div></div> : null}
    {notice ? <p className="decision-notice" role="status">{notice}</p> : null}
    {storageWarning && mode ? <p className="decision-context-note" role="status">浏览器暂存不可用，离开前请完成本次保存。</p> : null}
    {progress.loading ? <p role="status">正在读取教学决策…</p> : null}
    {!progress.loading && !progress.decisions.length && mode !== "create" ? <p className="decision-empty">可让助手准备候选，或直接记录你已有的问题、方案和依据。</p> : null}
    {progress.decisions.length > 1 ? <div className="decision-record-picker"><DecisionChoice label="切换教学决策" value={selectedId ?? ""} disabled={blocked || loadingObservations} onChange={(id) => { setSelectedId(id); clearForm(); }}>{progress.decisions.map((item) => <option key={item.id} value={item.id}>{statuses[item.status]} · {item.question.slice(0, 60)}</option>)}</DecisionChoice></div> : null}
    {["create", "edit"].includes(mode) ? <TeacherDecisionForm value={form} onChange={setForm} busy={blocked} onSave={saveTeacher} onCancel={clearForm} types={types} sourceDocument={sourceDocument} existingEvidenceCount={mode === "edit" ? selected?.evidenceCardIds?.length ?? 0 : 0} /> : null}
    {selected && mode !== "create" && mode !== "edit" ? <section className="decision-detail" aria-label="当前决策">
      <DecisionOverview key={selected.id} decision={selected} typeLabel={types[selected.decisionType]} statusLabel={statuses[selected.status]}>
        <div className="decision-actions">
          {isEditable ? <Button size="sm" type="button" variant="outline" disabled={blocked} onClick={() => openMode("edit")}>完善判断与依据</Button> : null}
          {selected.status === "proposed" ? selected.decisionType === "no_change" ? <Button size="sm" type="button" disabled={blocked} onClick={() => openMode("confirm")}>确认保留现稿</Button> : <><Button size="sm" type="button" disabled={blocked} onClick={() => openMode("confirm")}>确认采用</Button><Button size="sm" type="button" variant="outline" disabled={blocked} onClick={() => openMode("reject")}>拒绝或暂缓</Button></> : null}
          {selected.status === "teacher_confirmed" ? <><Button size="sm" type="button" variant="outline" disabled={blocked || !onPrepareDecisionRevision} onClick={() => onPrepareDecisionRevision?.(selected)}>准备教案修改</Button><Button size="sm" type="button" disabled={blocked} onClick={() => openMode("implement")}>登记实施</Button></> : null}
          {["teacher_confirmed", "implemented", "reviewed"].includes(selected.status) ? <Button size="sm" type="button" variant="outline" disabled={blocked || !selected.observationPlan} onClick={() => openMode("evidence")}>{selected.status === "teacher_confirmed" ? "记录关联观察或基线" : "记录本次后续观察"}</Button> : null}
          {selected.status === "implemented" ? <Button size="sm" type="button" disabled={blocked} onClick={() => openMode("review")}>记录审议</Button> : null}
        </div>
        {mode === "confirm" ? <form className="decision-form" onSubmit={(event) => { event.preventDefault(); if (selected.decisionType !== "no_change" && !observationPlanComplete(form.observationPlan)) { setError("请填写完整取证计划。"); return; } issue({ action: selected.decisionType === "no_change" ? "no_change" : "confirm", ...(selected.decisionType !== "no_change" ? { chosenOptionId: form.chosenOptionId, observationPlan: form.observationPlan, assumptions: lines(form.assumptionsText), uncertainties: lines(form.uncertaintiesText), expectedSignal: form.expectedSignal, falsifier: form.falsifier } : {}), rationale: form.rationale, ...(form.confidence === "" ? {} : { confidence: Number(form.confidence) }) }); }}>
          <h3>核对后确认</h3><fieldset disabled={blocked} className="decision-plan-fields">
            {selected.decisionType !== "no_change" ? <><DecisionChoice label="采用的选项" value={form.chosenOptionId} onChange={field("chosenOptionId")}>{selected.options.map((option) => <option key={option.id} value={option.id}>{option.statement}</option>)}</DecisionChoice><DecisionPlanFields value={form.observationPlan} onChange={field("observationPlan")} disabled={blocked} /><DecisionTextField label="我核对的判断前提（每行一项）" multiline value={form.assumptionsText} onChange={field("assumptionsText")} /><DecisionTextField label="尚不确定的部分（每行一项）" multiline value={form.uncertaintiesText} onChange={field("uncertaintiesText")} /><DecisionTextField label="预期观察到什么" multiline required value={form.expectedSignal} onChange={field("expectedSignal")} /><DecisionTextField label="什么观察会使这项判断不成立" multiline required value={form.falsifier} onChange={field("falsifier")} /><p className="decision-context-note">请区分设计对齐与学习变化。改后能采集到解释，不等于改前的识别评价已足够。</p></> : null}
            <DecisionTextField label="理由（可补充）" multiline required value={form.rationale} onChange={field("rationale")} /><DecisionTextField label="自评数值 0–1（可选，未校准）" type="number" min="0" max="1" step="0.01" value={form.confidence} onChange={field("confidence")} /><p className="decision-context-note">这项自评不代表判断正确概率或学习成效。</p>
          </fieldset><div className="decision-actions"><Button size="sm" type="submit" disabled={blocked}>保存确认</Button><Button size="sm" type="button" variant="ghost" disabled={blocked} onClick={clearForm}>取消</Button></div>
        </form> : null}
        {mode === "reject" ? <form className="decision-form" onSubmit={(event) => { event.preventDefault(); issue({ action: "reject", reasonCode: form.reasonCode, rationale: form.rationale }); }}><DecisionChoice label="拒绝原因" value={form.reasonCode} disabled={blocked} onChange={field("reasonCode")}>{Object.entries(rejectionReasons).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</DecisionChoice><DecisionTextField label="具体说明" multiline required disabled={blocked} value={form.rationale} onChange={field("rationale")} /><div className="decision-actions"><Button size="sm" type="submit" disabled={blocked}>记录拒绝或暂缓</Button><Button size="sm" type="button" variant="ghost" disabled={blocked} onClick={clearForm}>取消</Button></div></form> : null}
        {mode === "implement" ? <form className="decision-form" onSubmit={(event) => { event.preventDefault(); issue({ action: "implement", implementedAt: new Date(form.implementedAt).toISOString(), note: form.note, ...(form.baselineEvidenceId ? { baselineEvidenceId: form.baselineEvidenceId } : {}) }); }}><DecisionTextField label="实施时间" type="datetime-local" step="any" required disabled={blocked} value={form.implementedAt} onChange={field("implementedAt")} /><DecisionTextField label="实施说明（可选）" disabled={blocked} value={form.note} onChange={field("note")} />{selected.observationPlan?.kind === "learning_change" ? <DecisionChoice label="本次实施前的基线" value={form.baselineEvidenceId} disabled={blocked} onChange={field("baselineEvidenceId")}><option value="">暂未有基线，后续只能审议为证据不足</option>{observations.filter((item) => !item.synthetic && item.method !== "document_check").map((item) => <option key={item.id} value={item.id}>{new Date(item.observedAt).toLocaleString()} · {item.observation.slice(0, 40)}</option>)}</DecisionChoice> : null}<div className="decision-actions"><Button size="sm" type="submit" disabled={blocked}>保存实施登记</Button><Button size="sm" type="button" variant="ghost" disabled={blocked} onClick={clearForm}>取消</Button></div></form> : null}
        {mode === "evidence" && form.decisionVersion !== selected.version ? <p className="decision-context-note">取证计划已变化。实际观察已保留，请核对上方最新判断与计划后再关联。<button type="button" className="decision-text-button" disabled={blocked} onClick={() => setForm((value) => ({ ...value, decisionVersion: selected.version }))}>核对最新计划后关联本次观察</button></p> : null}
        {mode === "evidence" ? <LearningEvidenceForm value={form} onChange={setForm} onSubmit={saveEvidence} onCancel={clearForm} busy={blocked || form.decisionVersion !== selected.version} linkedPlan={selected.observationPlan} title={form.method === "document_check" ? "记录本次文档核对" : selected.status === "teacher_confirmed" ? "记录关联观察或基线" : "记录本次后续观察"} /> : null}
        {mode === "review" ? <form className="decision-form" onSubmit={(event) => { event.preventDefault(); issue({ action: "review", outcome: form.outcome, rationale: form.rationale, limitations: form.limitations, evidenceIds: [form.evidenceId] }); }}><DecisionChoice label="本次关联复测证据" value={form.evidenceId} required disabled={blocked} onChange={field("evidenceId")}><option value="">选择实施后、直接关联本决策的观察</option>{afterImplementation.map((item) => <option key={item.id} value={item.id}>{item.synthetic ? "合成 · " : ""}{new Date(item.observedAt).toLocaleString()} · {item.observation.slice(0, 40)}</option>)}</DecisionChoice>{!afterImplementation.length ? <p className="decision-context-note">尚无本次实施后的关联观察。可先取消并直接记录本次后续观察。</p> : null}<DecisionChoice label="审议结论" value={form.outcome} disabled={blocked} onChange={field("outcome")}>{Object.entries(outcomes).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</DecisionChoice><DecisionTextField label="依据" multiline required disabled={blocked} value={form.rationale} onChange={field("rationale")} /><DecisionTextField label="限制" required disabled={blocked} value={form.limitations} onChange={field("limitations")} /><p className="decision-context-note">学习变化需同口径的真实基线与后测；合成、口径不一致或仅有文档核对时不能确认学习改善。</p><div className="decision-actions"><Button size="sm" type="submit" disabled={blocked || !form.evidenceId}>保存审议</Button><Button size="sm" type="button" variant="ghost" disabled={blocked} onClick={clearForm}>取消</Button></div></form> : null}
      </DecisionOverview>
      {["implement", "review"].includes(mode) && observationsNext ? <Button size="sm" type="button" variant="outline" disabled={blocked || loadingObservations} onClick={() => { void loadObservations(observationsNext).catch(() => setError("较早的关联观察读取失败，当前选择已保留，请重试。")); }}>{loadingObservations ? "正在读取关联观察…" : "读取更早的关联观察"}</Button> : null}
      <DecisionReferenceDetails decision={selected} context={context} cards={cards} emit={emit} changedLabels={changedLabels} rejectionReasons={rejectionReasons} />
    </section> : null}
  </div>;
}
