import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentApi } from "@/lib/agent-api";

const types = {
  scope_priority: "内容取舍",
  goal_evidence: "目标与证据",
  task_sequence: "任务序列",
  scaffolding: "支架与差异",
  assessment: "评价证据",
  implementation_adjustment: "课堂调整",
  followup: "后续调整",
  no_change: "保留现稿",
};
const statuses = {
  draft: "草稿",
  proposed: "待确认",
  insufficient_evidence: "证据不足",
  teacher_confirmed: "已确认",
  teacher_rejected: "已拒绝",
  no_change: "保留现稿",
  implemented: "已实施",
  review: "待审议",
  reviewed: "已审议",
  superseded: "已替代",
};
const outcomes = { supported: "符合预期", not_supported: "未见预期", inconclusive: "证据不足" };
const changedLabels = {
  decisionType: "类型", question: "问题", options: "选项", chosenOptionId: "采用选项", rationale: "理由",
  counterevidence: "反例", assumptions: "假设", uncertainties: "不确定性", confidence: "置信度",
  expectedSignal: "预期信号", falsifier: "证伪条件", reviewAt: "复测时间",
};
const rejectionReasons = {
  insufficient_evidence: "证据不足",
  not_applicable: "不适用本班",
  student_mismatch: "不符合学情",
  other: "其他",
};
const errors = {
  stale_decision: "决策已变化，请核对同步后的最新版本。",
  stale_document: "教案版本已变化，请同步当前教案后重新提出。",
  decision_not_found: "这条决策已不存在，请刷新。",
  decision_proposal_not_requested: "请从教学决策入口发起。",
  decision_review_evidence_before_implementation: "复测证据必须晚于实施时间。",
  decision_review_evidence_not_found: "复测证据不存在或不属于本课时。",
  decision_invalid: "决策信息不完整，请核对选项、证据与不确定性。",
  idempotency_conflict: "同一请求标识对应了不同内容，请重新提交。",
};
const localDateTime = () => {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const label = (map, value) => map[value] ?? value;

function TextControl({ label: text, textarea = false, ...props }) {
  const id = useId();
  const Control = textarea ? Textarea : Input;
  return <Field><FieldLabel htmlFor={id}>{text}</FieldLabel><Control id={id} {...props} /></Field>;
}

export function DecisionWorkbench({ file, onAgentRequest }) {
  const [progress, setProgress] = useState({ decisions: [], evidenceCards: [], loading: true });
  const [context, setContext] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [learningEvidence, setLearningEvidence] = useState([]);
  const mounted = useRef(true);
  const revision = useRef(0);
  const pendingKey = `lessonup:decision-command:${file.id}`;
  const recoveryId = useRef(null);

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    const value = await agentApi.getDecisions(file.id);
    if (!mounted.current || request !== revision.current) return;
    setProgress({ ...value, loading: false });
    setSelectedId((current) => current ?? value.decisions[0]?.id ?? null);
  }, [file.id]);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => { if (mounted.current) { setError("无法读取教学决策，请重试。"); setProgress((current) => ({ ...current, loading: false })); } });
    const key = sessionStorage.getItem(pendingKey);
    if (key) recoveryId.current = key;
    if (key) void agentApi.getDecisionCommandResult(file.id, key).then((result) => {
      if (!mounted.current) return;
      sessionStorage.removeItem(pendingKey);
      if (result) { setNotice("已同步上次保存的决策结果。"); void refresh(); }
    }).catch(() => { if (mounted.current) setError("上次保存结果尚未确认，请先重试同一请求。"); });
    const update = (event) => {
      if (event.detail?.lessonFileId === file.id) void refresh().catch(() => setError("决策已保存，最新记录读取失败，请同步。"));
    };
    window.addEventListener("lessonup:decisions-changed", update);
    return () => { mounted.current = false; revision.current += 1; window.removeEventListener("lessonup:decisions-changed", update); };
  }, [file.id, pendingKey, refresh]);

  const selected = progress.decisions.find((decision) => decision.id === selectedId) ?? null;
  const emit = useCallback((type, extra = {}) => {
    void agentApi.recordDecisionEvent(file.id, { type, ...extra }).catch(() => undefined);
  }, [file.id]);
  useEffect(() => {
    if (selected) emit("decision_viewed", { decisionId: selected.id, decisionType: selected.decisionType });
  }, [selected?.id, selected?.decisionType, emit]);
  useEffect(() => {
    if (!selected) { setContext(null); return undefined; }
    let active = true;
    void agentApi.getDecisionContext(file.id, selected.id)
      .then((value) => { if (active) setContext(value); })
      .catch(() => { if (active) setContext(null); });
    return () => { active = false; };
  }, [file.id, selected?.id, selected?.version]);
  const cards = new Map(progress.evidenceCards.map((card) => [card.id, card]));
  const revisionLabel = selected ? `v${selected.version}` : "";

  const resetForm = () => { setMode(null); setForm({}); setError(""); };

  const openMode = async (next) => {
    setNotice(""); setError("");
    if (next === "review" && selected) {
      setLearningEvidence([]);
      const data = await agentApi.getLearningProgress(file.id).catch(() => null);
      const implementedAt = selected.implementation?.implementedAt;
      setLearningEvidence((data?.evidence ?? []).filter((evidence) => !implementedAt || evidence.observedAt > implementedAt));
    }
    if (next === "confirm" && selected) emit("option_compared", { decisionId: selected.id, count: selected.options?.length ?? 0 });
    setMode(next);
    setForm({
      chosenOptionId: selected?.chosenOptionId ?? selected?.options?.[0]?.id ?? "",
      confidence: selected?.confidence ?? 0.7,
      rationale: next === "reject" ? "" : selected?.rationale ?? "",
      reasonCode: "insufficient_evidence",
      implementedAt: localDateTime(),
      note: "",
      evidenceId: "",
      outcome: "supported",
      limitations: "",
    });
  };

  const execute = async (input) => {
    if (!selected || busy) return;
    const commandId = recoveryId.current ?? crypto.randomUUID();
    recoveryId.current = commandId;
    sessionStorage.setItem(pendingKey, commandId);
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    setBusy(true); setError(""); setNotice("");
    try {
      await agentApi.actOnDecision(file.id, selected.id, { ...input, expectedVersion: selected.version }, commandId);
      sessionStorage.removeItem(pendingKey); recoveryId.current = null;
      const eventTypes = {
        confirm: "decision_confirmed", reject: "decision_rejected", no_change: "no_change_confirmed",
        implement: "implementation_recorded", review: "review_recorded",
      };
      emit(eventTypes[input.action] ?? "decision_viewed", {
        decisionId: selected.id, decisionType: selected.decisionType,
        durationMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt),
      });
      setNotice("已保存，教师决定与证据已记录。");
      resetForm();
      await refresh();
      window.dispatchEvent(new CustomEvent("lessonup:decisions-changed", { detail: { lessonFileId: file.id } }));
    } catch (cause) {
      try {
        const saved = await agentApi.getDecisionCommandResult(file.id, commandId);
        if (saved) { sessionStorage.removeItem(pendingKey); recoveryId.current = null; setNotice("已同步上次保存的结果。"); resetForm(); await refresh(); return; }
      } catch { /* keep the original error */ }
      if (mounted.current) {
        if ([400, 403, 404, 409, 422].includes(cause.status)) {
          sessionStorage.removeItem(pendingKey); recoveryId.current = null;
        }
        setError(errors[cause.message] ?? "未确认保存成功。输入已保留，可用同一请求重试或同步记录。");
        void refresh().catch(() => undefined);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const requestProposal = () => {
    emit("proposal_requested", { decisionType: selected?.decisionType });
    onAgentRequest?.({
      prompt: "请读取当前教案、课标/教材原文、学习证据与课堂反馈，提出一个最关键的教学决策候选。必须写清问题、至少两个选项及取舍、可定位证据、反例、假设、不确定性、置信度、预期信号与证伪条件；证据不足时提交证据不足，不替我确认、实施或审议。",
      taskIntent: { type: "decision_proposal" },
    });
  };

  return <div className="decision-workbench" aria-label="教学决策">
    <header>
      <div>
        <h2>教学决策</h2>
        <p className="decision-meta">记录判断、证据与后续验证。采用不等于有效，实施不等于保真。</p>
      </div>
      <Button size="sm" variant="outline" type="button" disabled={busy} onClick={requestProposal}>请助手准备决策</Button>
    </header>
    {error ? <p className="decision-error" role="alert">{error}</p> : null}
    {notice ? <p className="decision-notice" role="status">{notice}</p> : null}

    {progress.loading ? <p role="status">正在读取教学决策…</p> : null}
    {!progress.loading && progress.decisions.length === 0 ? <div className="decision-empty">
      <p>还没有教学决策记录。</p>
      <p>让助手基于当前教案与真实证据提出候选，或先记录你已做的判断。</p>
    </div> : null}

    {progress.decisions.length ? <div className="decision-list">
      {progress.decisions.map((decision) => <button
        key={decision.id}
        type="button"
        className={`decision-card ${decision.id === selectedId ? "is-selected" : ""}`}
        aria-pressed={decision.id === selectedId}
        onClick={() => { setSelectedId(decision.id); resetForm(); }}
      >
        <span className="decision-card-type">{label(types, decision.decisionType)}</span>
        <strong>{decision.question}</strong>
        <span className="decision-card-state">{label(statuses, decision.status)}{decision.confidence != null ? ` · 置信 ${Math.round(decision.confidence * 100)}%` : ""}</span>
      </button>)}
    </div> : null}

    {selected ? <section className="decision-detail" aria-label="当前决策">
      <div className="decision-detail-heading">
        <div>
          <h3>{label(types, selected.decisionType)} · {revisionLabel}</h3>
          <p className="decision-meta">{label(statuses, selected.status)}{selected.reviewAt ? ` · 计划复测 ${new Date(selected.reviewAt).toLocaleDateString()}` : ""}</p>
        </div>
      </div>
      <p className="decision-question">{selected.question}</p>
      <p>{selected.rationale}</p>

      {context?.diff && context.versions?.length > 1 ? <div className="decision-diff">
        <h4>本次变化（v{context.versions.length - 1} → v{context.versions.length}）</h4>
        {context.diff.statusFrom !== context.diff.statusTo ? <p>状态：{label(statuses, context.diff.statusFrom)} → {label(statuses, context.diff.statusTo)}</p> : null}
        {context.diff.confidenceDelta ? <p>置信度变化：{context.diff.confidenceDelta > 0 ? "+" : ""}{Math.round(context.diff.confidenceDelta * 100)}%</p> : null}
        {context.diff.addedEvidence.length ? <p>新增证据：{context.diff.addedEvidence.length} 条</p> : null}
        {context.diff.removedEvidence.length ? <p>移除证据：{context.diff.removedEvidence.length} 条</p> : null}
        {context.diff.changed.some((field) => changedLabels[field]) ? <p>字段变化：{context.diff.changed.filter((field) => changedLabels[field]).map((field) => changedLabels[field]).join("、")}</p> : null}
      </div> : null}

      {selected.options?.length ? <div className="decision-options">
        <h4>选项与取舍</h4>
        {selected.options.map((option) => <div key={option.id} className={`decision-option ${selected.chosenOptionId === option.id ? "is-chosen" : ""}`}>
          <strong>{option.statement}</strong>
          <ul>{option.tradeoffs.map((tradeoff) => <li key={tradeoff}>{tradeoff}</li>)}</ul>
        </div>)}
      </div> : null}

      {selected.evidenceCardIds?.length ? <div className="decision-evidence">
        <h4>证据</h4>
        {selected.evidenceCardIds.map((id) => {
          const card = cards.get(id);
          if (!card) return null;
          return <details key={id} onToggle={(event) => {
            if (event.currentTarget.open) emit("evidence_opened", { decisionId: selected.id, evidenceId: id });
          }}>
            <summary>{card.claim}</summary>
            <p className="decision-excerpt">“{card.excerpt}”</p>
            <p className="decision-meta">{card.source.system} · {card.source.locator ?? "无定位"} · {card.source.version}</p>
            <p className="decision-meta">适用范围：{card.applicability}</p>
            <p className="decision-meta">限制：{card.limitations.join("；")}</p>
            <p className="decision-meta">证据置信：{Math.round(card.confidence * 100)}%</p>
          </details>;
        })}
      </div> : null}

      <dl className="decision-facts">
        {selected.counterevidence?.length ? <><dt>反例</dt><dd>{selected.counterevidence.join("；")}</dd></> : null}
        {selected.uncertainties?.length ? <><dt>不确定性</dt><dd>{selected.uncertainties.join("；")}</dd></> : null}
        {selected.expectedSignal ? <><dt>预期信号</dt><dd>{selected.expectedSignal}</dd></> : null}
        {selected.falsifier ? <><dt>证伪条件</dt><dd>{selected.falsifier}</dd></> : null}
        {selected.rejection ? <><dt>拒绝原因</dt><dd>{label(rejectionReasons, selected.rejection.reasonCode)}：{selected.rejection.rationale}</dd></> : null}
        {selected.implementation ? <><dt>实施</dt><dd>{new Date(selected.implementation.implementedAt).toLocaleString()}{selected.implementation.note ? ` · ${selected.implementation.note}` : ""}</dd></> : null}
        {selected.review ? <><dt>审议</dt><dd>{label(outcomes, selected.review.outcome)}：{selected.review.rationale}（{selected.review.limitations}）</dd></> : null}
      </dl>

      <div className="decision-actions">
        {selected.status === "proposed" ? <>
          {selected.decisionType === "no_change"
            ? <Button size="sm" type="button" disabled={busy} onClick={() => execute({ action: "no_change", rationale: selected.rationale, confidence: selected.confidence ?? 0.7 })}>确认保留现稿</Button>
            : <>
              <Button size="sm" type="button" disabled={busy} onClick={() => openMode("confirm")}>确认采用</Button>
              <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => openMode("reject")}>拒绝</Button>
              <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => openMode("reject")}>证据不足</Button>
            </>}
        </> : null}
        {selected.status === "teacher_confirmed" ? <Button size="sm" type="button" disabled={busy} onClick={() => openMode("implement")}>登记实施</Button> : null}
        {selected.status === "implemented" ? <Button size="sm" type="button" disabled={busy} onClick={() => openMode("review")}>记录审议</Button> : null}
      </div>

      {mode ? <div className="decision-form">
        {mode === "confirm" ? <>
          <Field><FieldLabel htmlFor="decision-option">采用的选项</FieldLabel>
            <select id="decision-option" className="learning-select" value={form.chosenOptionId} onChange={(event) => setForm({ ...form, chosenOptionId: event.target.value })}>
              {selected.options.map((option) => <option key={option.id} value={option.id}>{option.statement}</option>)}
            </select>
          </Field>
          <TextControl label="理由（可选补充）" textarea value={form.rationale} onChange={(event) => setForm({ ...form, rationale: event.target.value })} />
          <TextControl label="置信度 0–1" type="number" min="0" max="1" step="0.05" value={form.confidence} onChange={(event) => setForm({ ...form, confidence: Number(event.target.value) })} />
          <div className="decision-actions">
            <Button size="sm" disabled={busy} onClick={() => execute({ action: "confirm", chosenOptionId: form.chosenOptionId, rationale: form.rationale || undefined, confidence: form.confidence })}>保存确认</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={resetForm}>取消</Button>
          </div>
        </> : null}
        {mode === "reject" ? <>
          <Field><FieldLabel htmlFor="decision-reject">拒绝原因</FieldLabel>
            <select id="decision-reject" className="learning-select" value={form.reasonCode} onChange={(event) => setForm({ ...form, reasonCode: event.target.value })}>
              {Object.entries(rejectionReasons).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </Field>
          <TextControl label="具体说明" textarea value={form.rationale} onChange={(event) => setForm({ ...form, rationale: event.target.value })} />
          <div className="decision-actions">
            <Button size="sm" disabled={busy || !form.rationale.trim()} onClick={() => execute({ action: "reject", reasonCode: form.reasonCode, rationale: form.rationale })}>记录拒绝</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={resetForm}>取消</Button>
          </div>
        </> : null}
        {mode === "implement" ? <>
          <TextControl label="实施时间" type="datetime-local" value={form.implementedAt} onChange={(event) => setForm({ ...form, implementedAt: event.target.value })} />
          <TextControl label="实施说明（可选）" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
          <div className="decision-actions">
            <Button size="sm" disabled={busy || !form.implementedAt} onClick={() => execute({ action: "implement", implementedAt: new Date(form.implementedAt).toISOString(), note: form.note })}>保存实施登记</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={resetForm}>取消</Button>
          </div>
        </> : null}
        {mode === "review" ? <>
          <Field><FieldLabel htmlFor="decision-evidence">复测证据</FieldLabel>
            <select id="decision-evidence" className="learning-select" value={form.evidenceId} onChange={(event) => setForm({ ...form, evidenceId: event.target.value })}>
              <option value="">选择实施后的真实证据</option>
              {learningEvidence.map((evidence) => <option key={evidence.id} value={evidence.id}>{new Date(evidence.observedAt).toLocaleString()} · {evidence.observation.slice(0, 40)}</option>)}
            </select>
          </Field>
          {!learningEvidence.length ? <p className="decision-meta">还没有晚于实施时间的学习证据。请先在学习验证中记录真实观察。</p> : null}
          <Field><FieldLabel htmlFor="decision-outcome">审议结论</FieldLabel>
            <select id="decision-outcome" className="learning-select" value={form.outcome} onChange={(event) => setForm({ ...form, outcome: event.target.value })}>
              {Object.entries(outcomes).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </Field>
          <TextControl label="依据" textarea value={form.rationale} onChange={(event) => setForm({ ...form, rationale: event.target.value })} />
          <TextControl label="限制" value={form.limitations} onChange={(event) => setForm({ ...form, limitations: event.target.value })} />
          <div className="decision-actions">
            <Button size="sm" disabled={busy || !form.evidenceId || !form.rationale.trim() || !form.limitations.trim()} onClick={() => execute({ action: "review", outcome: form.outcome, rationale: form.rationale, limitations: form.limitations, evidenceIds: [form.evidenceId] })}>保存审议</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={resetForm}>取消</Button>
          </div>
        </> : null}
      </div> : null}
    </section> : null}
  </div>;
}
