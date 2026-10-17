import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentApi } from "@/lib/agent-api";

const BusyContext = createContext(false);
const states = { proposed: "待采用", adopted: "已采用，待实施", implemented: "已实施，待复测", reviewed: "已审议", dismissed: "未采用" };
const outcomes = { supported: "符合预期", not_supported: "未见预期", inconclusive: "证据不足" };
const methods = { student_work: "学生作品", assessment: "评价任务", teacher_observation: "教师观察" };
const errors = {
  stale_document: "教案版本已变化，请同步当前教案后重新核对。",
  stale_learning_inquiry: "记录已变化，已同步最新状态，请核对后再操作。",
  learning_evidence_not_comparable: "目标、判据或观察群体不同，目前只能记录为证据不足。",
  learning_evidence_before_implementation: "复测时间必须晚于本次方案的实施时间。",
  learning_proposal_not_delivered: "助手尚未完成这份方案，请等待结果后再采用。",
  learning_implementation_time_invalid: "实施时间应晚于基线观察，且不能晚于当前时间。",
  learning_observation_in_future: "观察时间不能晚于当前时间。",
  learning_transition_invalid: "这项操作已不适用于当前状态，请核对同步后的记录。",
};
const localDateTime = () => {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
};
function TextField({ label, value, onChange, multiline = false, ...props }) {
  const id = useId();
  const busy = useContext(BusyContext);
  const Control = multiline ? Textarea : Input;
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><Control id={id} disabled={busy} value={value} onChange={(event) => onChange(event.target.value)} {...props} /></Field>;
}
function Choice({ label, value, onChange, children, ...props }) {
  const id = useId();
  const busy = useContext(BusyContext);
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><select id={id} disabled={busy} className="learning-select" value={value} onChange={(event) => onChange(event.target.value)} {...props}>{children}</select></Field>;
}
function EvidenceSummary({ title, evidence }) {
  if (!evidence) return null;
  return <details className="learning-evidence-summary"><summary>{title}</summary><dl>
    <dt>目标</dt><dd>{evidence.objective}</dd><dt>任务</dt><dd>{evidence.task}</dd>
    <dt>成功判据</dt><dd>{evidence.criterion}</dd><dt>观察群体</dt><dd>{evidence.learnerGroup}</dd>
    <dt>实际观察</dt><dd>{evidence.observation}</dd><dt>来源</dt><dd>{methods[evidence.method]} · {evidence.sourceReference}</dd>
    <dt>观察时间</dt><dd>{new Date(evidence.observedAt).toLocaleString()}</dd>
    {evidence.sampleSize ? <><dt>记录人数</dt><dd>{evidence.meetingCriterion === undefined ? `观察${evidence.sampleSize}人，未记录达标人数` : `${evidence.sampleSize}人中${evidence.meetingCriterion}人达到判据`}</dd></> : null}
  </dl></details>;
}

export function LearningWorkbench({ file, notebook, plan, onBeforeWrite, onAgentRequest }) {
  const [progress, setProgress] = useState({ evidence: [], inquiries: [], truncated: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null);
  const [implementationTimes, setImplementationTimes] = useState({});
  const [selectedEvidence, setSelectedEvidence] = useState("");
  const [evidenceForm, setEvidenceForm] = useState(null);
  const [proposalForm, setProposalForm] = useState(null);
  const [reviewForm, setReviewForm] = useState(null);
  const [pending, setPending] = useState(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const recoveryId = useRef(null);
  const blocked = busy || Boolean(pending);
  const revision = useRef(0);
  const pendingKey = `lessonup:learning-command:${file.id}`;
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    const value = await agentApi.getLearningProgress(file.id);
    if (!mounted.current || request !== revision.current) return;
    setProgress(value); setLoading(false);
  }, [file.id]);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => { if (mounted.current) { setError("无法读取学习记录，请重试。"); setLoading(false); } });
    const key = sessionStorage.getItem(pendingKey);
    if (key) recoveryId.current = key;
    if (key) void agentApi.getLearningCommandResult(file.id, key).then((result) => {
      if (!mounted.current) return;
      setNotice(result ? "已同步上次保存的结果。" : "上次保存尚未找到结果。重新录入会复用上次请求标识，避免重复建立记录。");
      if (result) sessionStorage.removeItem(pendingKey);
      else recoveryId.current = key;
    }).catch(() => { if (mounted.current) { recoveryId.current = key; setError("上次保存结果尚未确认，请先同步记录。"); } });
    const update = (event) => {
      if (event.detail?.lessonFileId === file.id) void refresh().catch(() => setError("助手结果已保存，读取失败，请同步记录。"));
    };
    window.addEventListener("lessonup:learning-changed", update);
    return () => { mounted.current = false; revision.current += 1; window.removeEventListener("lessonup:learning-changed", update); };
  }, [file.id, pendingKey, refresh]);

  const finish = async (command) => {
    sessionStorage.removeItem(pendingKey); recoveryId.current = null; setPending(null); command.onSuccess?.();
    setNotice("已保存，可继续核对学习证据。");
    try { await refresh(); } catch { setError("保存已完成，最新记录读取失败，请同步。 "); }
  };
  const execute = async (command) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(""); setNotice(""); setPending(command);
    sessionStorage.setItem(pendingKey, command.id);
    try {
      await command.perform(command.id);
      if (mounted.current) await finish(command);
    } catch (cause) {
      try {
        const saved = await agentApi.getLearningCommandResult(file.id, command.id);
        if (saved) { if (mounted.current) await finish(command); return; }
        if (mounted.current) {
          if ([400, 403, 404, 409, 422].includes(cause.status)) {
            sessionStorage.removeItem(pendingKey); recoveryId.current = null; setPending(null);
          }
          setError(errors[cause.message] ?? "未确认保存成功。输入已保留，可用同一次请求重试或同步记录。");
          await refresh().catch(() => undefined);
        }
      } catch {
        if (mounted.current) setError("保存结果尚未确认，请同步或重试同一次请求。不要重复建立记录。");
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const save = (perform, onSuccess) => { if (!pending) return execute({ id: recoveryId.current ?? crypto.randomUUID(), perform, onSuccess }); };
  const synchronize = async () => {
    setError("");
    try {
      const id = pending?.id ?? recoveryId.current;
      if (id) {
        const saved = await agentApi.getLearningCommandResult(file.id, id);
        if (saved) { await finish(pending ?? { id }); return; }
        setError("尚未查到这次保存的结果，可重试同次保存；请勿重复建立记录。");
      }
      await refresh();
    } catch { setError("仍无法确认保存结果，请稍后同步。"); }
  };
  const action = (inquiry, type) => save((id) => agentApi.actOnLearningInquiry(file.id, inquiry.id, {
    action: type, expectedVersion: inquiry.version,
    ...(type === "implement" && implementationTimes[inquiry.id] ? { implementedAt: new Date(implementationTimes[inquiry.id]).toISOString() } : {}),
  }, id));
  const baseline = progress.evidence.find((item) => item.id === selectedEvidence) ?? progress.evidence[0];
  const continueInquiry = async (inquiry) => {
    try {
      const context = await agentApi.getLearningInquiryContext(file.id, inquiry.id);
      if (!mounted.current) return;
      setProgress((current) => ({ ...current, evidence: [...new Map([...current.evidence, ...context.evidence].map((item) => [item.id, item])).values()] }));
      setSelectedEvidence(inquiry.review.evidenceId); setMode(null);
      setNotice("已选中本次复测证据，可据此提出下一轮调整；它仍是一条观察，不是因果结论。");
      document.querySelector(".learning-workbench")?.scrollTo({ top: 0, behavior: "instant" });
    } catch { setError("复测证据读取失败，请同步记录。"); }
  };
  const loadMore = async (kind) => {
    if (busyRef.current || !progress.next?.[kind]) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const page = await agentApi.getLearningProgress(file.id, { [kind === "evidence" ? "evidenceBefore" : "inquiriesBefore"]: progress.next[kind] });
      if (mounted.current) setProgress((current) => ({ ...current,
        [kind]: [...new Map([...current[kind], ...page[kind]].map((item) => [item.id, item])).values()],
        next: { ...current.next, [kind]: page.next[kind] }, truncated: { ...current.truncated, [kind]: page.truncated[kind] },
      }));
    } catch { if (mounted.current) setError("较早记录读取失败，请重试。"); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const beginEvidence = async (inquiry) => {
    let source = inquiry ? progress.evidence.find((item) => item.id === inquiry.baselineEvidenceId) : null;
    if (inquiry && !source) {
      try {
        const context = await agentApi.getLearningInquiryContext(file.id, inquiry.id);
        if (!mounted.current) return;
        source = context.evidence.find((item) => item.id === inquiry.baselineEvidenceId);
      } catch { setError("基线证据读取失败，请先同步记录。"); return; }
    }
    setEvidenceForm({ objective: source?.objective ?? plan.objectives ?? "", task: "", criterion: source?.criterion ?? "",
      learnerGroup: source?.learnerGroup ?? notebook.className ?? "", observation: "", method: source?.method ?? "teacher_observation",
      observedAt: localDateTime(), sourceReference: "", sampleSize: "", meetingCriterion: "", inquiryId: inquiry?.id });
    setMode("evidence");
  };
  const requestInquiry = () => {
    if (!baseline) return;
    onAgentRequest({ prompt: "请读取当前教案和所选真实学习证据，比较一个主要解释与替代解释，提出可执行的教学调整、预期信号及复测办法。只准备待采用方案，不替教师确认实施或效果。",
      taskIntent: { type: "learning_inquiry", evidenceId: baseline.id } });
  };
  const startReview = async (inquiry) => {
    try {
      const context = await agentApi.getLearningInquiryContext(file.id, inquiry.id);
      if (!mounted.current) return;
      inquiry = context.inquiry;
      setProgress((current) => ({ ...current,
        evidence: [...new Map([...current.evidence, ...context.evidence].map((item) => [item.id, item])).values()],
        inquiries: current.inquiries.map((item) => item.id === inquiry.id ? inquiry : item),
      }));
    } catch { setError("基线与方案读取失败，请同步后再审议。"); return; }
    const followups = progress.evidence.filter((item) => item.inquiryId === inquiry.id);
    setReviewForm({ inquiryId: inquiry.id, expectedVersion: inquiry.version,
      evidenceId: inquiry.proposedReview?.evidenceId ?? followups[0]?.id ?? "",
      outcome: inquiry.proposedReview?.outcome ?? "inconclusive", rationale: inquiry.proposedReview?.rationale ?? "",
      limitations: inquiry.proposedReview?.limitations ?? "" });
    setMode("review");
  };
  const reviewInquiry = progress.inquiries.find((item) => item.id === reviewForm?.inquiryId);
  return <BusyContext.Provider value={blocked}><section className="learning-workbench" aria-label="学习验证" aria-busy={busy || loading}>
    <header><h2>学习验证</h2><p>从真实作答提出调整，再用后续证据检查。采用、实施和复测分别记录。</p></header>
    {loading ? <p role="status">正在读取学习记录…</p> : null}
    {notice ? <p role="status" className="learning-notice">{notice}</p> : null}
    {error ? <div role="alert" className="learning-error"><p>{error}</p><div className="learning-actions">
      <Button size="sm" variant="outline" disabled={busy} onClick={synchronize}>同步记录</Button>
      {pending ? <Button size="sm" disabled={busy} onClick={() => execute(pending)}>重试同次保存</Button> : null}
    </div></div> : null}
    <div className="learning-actions"><Button size="sm" disabled={blocked} onClick={() => beginEvidence()}>记录学习证据</Button></div>
    {!progress.evidence.length && !loading ? <p className="learning-empty">先记录一次真实作答或课堂观察，包括任务、成功判据与证据来源。助手会据此提出可检验的调整。</p> : null}
    {mode === "evidence" && evidenceForm ? <form className="learning-form" onSubmit={async (event) => {
      event.preventDefault();
      const snapshot = { ...evidenceForm };
      let canonical;
      try { canonical = await onBeforeWrite?.(); } catch { setError("教案尚未保存，请先完成保存再记录证据。"); return; }
      const input = { ...snapshot, documentVersion: canonical?.documentVersion ?? file.documentVersion,
        observedAt: new Date(snapshot.observedAt).toISOString(),
        sampleSize: snapshot.sampleSize === "" ? undefined : Number(snapshot.sampleSize),
        meetingCriterion: snapshot.meetingCriterion === "" ? undefined : Number(snapshot.meetingCriterion) };
      await save((id) => agentApi.recordLearningEvidence(file.id, input, id), () => { setMode(null); setEvidenceForm(null); });
    }}>
      <h3>{evidenceForm.inquiryId ? "记录实施后的复测" : "记录基线证据"}</h3>
      {[["objective", "本次学习目标"], ["task", "学生完成的任务"], ["criterion", "成功判据"], ["learnerGroup", "观察群体"], ["observation", "实际观察"], ["sourceReference", "证据来源与定位"]].map(([key, label]) => <TextField key={key} label={label} required maxLength={key === "observation" ? 4000 : key === "objective" ? 500 : key === "learnerGroup" ? 300 : 1000}
        multiline={["task", "observation"].includes(key)} value={evidenceForm[key]} onChange={(value) => setEvidenceForm((current) => ({ ...current, [key]: value }))} />)}
      <Choice label="取证方式" value={evidenceForm.method} onChange={(method) => setEvidenceForm((current) => ({ ...current, method }))}>{Object.entries(methods).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</Choice>
      <TextField label="观察时间" type="datetime-local" step="any" required value={evidenceForm.observedAt} onChange={(observedAt) => setEvidenceForm((current) => ({ ...current, observedAt }))} />
      <details><summary>补充人数（可选）</summary><div className="learning-form">
        <TextField label="观察人数" type="number" min="1" max="10000" value={evidenceForm.sampleSize} onChange={(sampleSize) => setEvidenceForm((current) => ({ ...current, sampleSize }))} />
        <TextField label="达到判据人数" type="number" min="0" max={evidenceForm.sampleSize || "10000"} value={evidenceForm.meetingCriterion} onChange={(meetingCriterion) => setEvidenceForm((current) => ({ ...current, meetingCriterion }))} />
      </div></details>
      <div className="learning-actions"><Button size="sm" type="submit" disabled={blocked}>{busy ? "正在保存…" : "保存证据"}</Button><Button size="sm" variant="ghost" type="button" disabled={blocked} onClick={() => setMode(null)}>取消</Button></div>
    </form> : null}
    {progress.evidence.length ? <div className="learning-section">
      <h3>选择诊断起点</h3><Choice label="基线证据" value={baseline?.id ?? ""} onChange={setSelectedEvidence}>{progress.evidence.map((item) => <option key={item.id} value={item.id}>{item.inquiryId ? "复测" : "初次观察"} · {item.objective} · {new Date(item.observedAt).toLocaleDateString()}</option>)}</Choice>
      {baseline ? <p className="learning-observation">{baseline.observation}<small>{methods[baseline.method]} · {baseline.sourceReference}</small></p> : null}
      <div className="learning-actions"><Button size="sm" variant="outline" disabled={blocked} onClick={requestInquiry}>请助手提出改进方案</Button><Button size="sm" variant="ghost" disabled={blocked} onClick={() => { setProposalForm({ hypothesis: "", alternativeExplanation: "", intervention: "", expectedSignal: "", checkPlan: "" }); setMode("proposal"); }}>自行记录方案</Button></div>
    </div> : null}
    {mode === "proposal" && proposalForm && baseline ? <form className="learning-form" onSubmit={async (event) => {
      event.preventDefault(); let canonical;
      try { canonical = await onBeforeWrite?.(); } catch { setError("教案尚未保存，请先完成保存。"); return; }
      const input = { ...proposalForm, baselineEvidenceId: baseline.id, documentVersion: canonical?.documentVersion ?? file.documentVersion };
      await save((id) => agentApi.proposeLearningInquiry(file.id, input, id), () => setMode(null));
    }}><h3>待检验的教学调整</h3>{[["hypothesis", "主要解释（待检验）"], ["alternativeExplanation", "另一种可能解释"], ["intervention", "准备怎样调整"], ["expectedSignal", "预期看到的信号"], ["checkPlan", "后续怎样检查"]].map(([key, label]) => <TextField key={key} label={label} multiline required maxLength={key === "intervention" ? 4000 : 2000} value={proposalForm[key]} onChange={(value) => setProposalForm((current) => ({ ...current, [key]: value }))} />)}
      <div className="learning-actions"><Button type="submit" size="sm" disabled={blocked}>保存待采用方案</Button><Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => setMode(null)}>取消</Button></div>
    </form> : null}
    <div className="learning-section"><h3>教学调整与复测</h3>
      {!progress.inquiries.length && !loading ? <p className="learning-empty">有了证据后，可让助手提出方案或自行记录。保存方案不会自动标记已实施。</p> : null}
      {progress.inquiries.map((inquiry) => <article className="learning-inquiry" key={inquiry.id}>
        <div className="learning-inquiry-heading"><h4>{inquiry.hypothesis}</h4><span>{states[inquiry.state]}</span></div>
        <dl><dt>另一种解释</dt><dd>{inquiry.alternativeExplanation}</dd><dt>教学调整</dt><dd>{inquiry.intervention}</dd><dt>预期信号</dt><dd>{inquiry.expectedSignal}</dd><dt>后续检查</dt><dd>{inquiry.checkPlan}</dd></dl>
        {inquiry.implementedAt ? <p className="learning-meta">教师确认实施：{new Date(inquiry.implementedAt).toLocaleString()}</p> : null}
        {inquiry.proposedReview && !inquiry.review ? <p className="learning-notice">待教师审议：{outcomes[inquiry.proposedReview.outcome]}。{inquiry.proposedReview.rationale}</p> : null}
        {inquiry.review ? <div className="learning-review"><strong>{outcomes[inquiry.review.outcome]}</strong><p>{inquiry.review.rationale}</p><small>限制：{inquiry.review.limitations}</small><p>该结论只对应本次证据，不证明教学调整的因果效果。</p></div> : null}
        {inquiry.state === "adopted" ? <TextField label="实际实施时间（默认现在）" type="datetime-local" step="any" value={implementationTimes[inquiry.id] ?? ""} onChange={(value) => setImplementationTimes((current) => ({ ...current, [inquiry.id]: value }))} /> : null}
        <div className="learning-actions">
          {inquiry.state === "proposed" ? <Button size="sm" disabled={blocked} onClick={() => action(inquiry, "adopt")}>采用方案</Button> : null}
          {["proposed", "adopted"].includes(inquiry.state) ? <Button variant="ghost" size="sm" disabled={blocked} onClick={() => action(inquiry, "dismiss")}>不采用</Button> : null}
          {inquiry.state === "adopted" ? <Button size="sm" disabled={blocked} onClick={() => action(inquiry, "implement")}>确认已经实施</Button> : null}
          {inquiry.state === "implemented" ? <><Button size="sm" variant="outline" disabled={blocked} onClick={() => beginEvidence(inquiry)}>记录复测</Button><Button size="sm" variant="ghost" disabled={blocked || !progress.evidence.some((item) => item.inquiryId === inquiry.id)} onClick={() => startReview(inquiry)}>审议复测</Button></> : null}
          {inquiry.state === "reviewed" ? <Button size="sm" variant="outline" disabled={blocked} onClick={() => continueInquiry(inquiry)}>以复测继续改进</Button> : null}
        </div>
      </article>)}
    </div>
    {mode === "review" && reviewForm ? <form className="learning-form" onSubmit={async (event) => {
      event.preventDefault(); const { inquiryId, expectedVersion, ...review } = reviewForm;
      await save((id) => agentApi.actOnLearningInquiry(file.id, inquiryId, { action: "review", expectedVersion, review }, id), () => setMode(null));
    }}><h3>核对复测证据</h3>
      <Choice label="后测证据" required value={reviewForm.evidenceId} onChange={(evidenceId) => setReviewForm((current) => ({ ...current, evidenceId }))}><option value="">选择一条后测证据</option>{progress.evidence.filter((item) => item.inquiryId === reviewForm.inquiryId).map((item) => <option key={item.id} value={item.id}>{item.observation}</option>)}</Choice>
      <EvidenceSummary title="核对原始基线" evidence={progress.evidence.find((item) => item.id === reviewInquiry?.baselineEvidenceId)} />
      <EvidenceSummary title="核对后测观察" evidence={progress.evidence.find((item) => item.id === reviewForm.evidenceId)} />
      <p className="learning-meta">核对任务难度、提示与取证方式的变化。有支架时答对不等于独立掌握；即时进步仍需要保持与迁移检查。</p>
      <Choice label="本次判断" value={reviewForm.outcome} onChange={(outcome) => setReviewForm((current) => ({ ...current, outcome }))}>{Object.entries(outcomes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Choice>
      <TextField label="判断依据" multiline required maxLength={4000} value={reviewForm.rationale} onChange={(rationale) => setReviewForm((current) => ({ ...current, rationale }))} />
      <TextField label="证据限制与仍需检查的条件" multiline required maxLength={2000} value={reviewForm.limitations} onChange={(limitations) => setReviewForm((current) => ({ ...current, limitations }))} />
      <div className="learning-actions"><Button type="submit" size="sm" disabled={blocked}>确认复测判断</Button><Button type="button" size="sm" variant="outline" disabled={blocked || !reviewForm.evidenceId} onClick={() => onAgentRequest({
        prompt: "请读取这项已实施的教学调整及真实后测证据，比较目标、成功判据和观察群体，建议符合预期、未见预期或证据不足，说明替代解释与限制。仅提出待教师审议的建议，不替教师确认效果。",
        taskIntent: { type: "learning_review", inquiryId: reviewForm.inquiryId, evidenceId: reviewForm.evidenceId, expectedVersion: reviewForm.expectedVersion },
      })}>请助手协助审议</Button><Button type="button" size="sm" variant="ghost" disabled={blocked} onClick={() => setMode(null)}>取消</Button></div>
    </form> : null}
    <div className="learning-actions">
      {progress.next?.evidence ? <Button size="sm" variant="outline" disabled={blocked} onClick={() => loadMore("evidence")}>读取较早证据</Button> : null}
      {progress.next?.inquiries ? <Button size="sm" variant="outline" disabled={blocked} onClick={() => loadMore("inquiries")}>读取较早方案</Button> : null}
    </div>
  </section></BusyContext.Provider>;
}
