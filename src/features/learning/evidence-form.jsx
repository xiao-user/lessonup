import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export const evidenceMethods = { student_work: "学生作品", assessment: "评价任务", teacher_observation: "教师观察", document_check: "文档核对" };
export const evidenceLocalTime = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 23); };
export function evidenceFromPlan(plan, decisionId, decisionVersion) {
  return { objective: plan.objective, task: plan.task, criterion: plan.criterion, learnerGroup: plan.learnerGroup,
    method: plan.method, conditions: plan.conditions ?? "", decisionId, decisionVersion, observation: "", sourceReference: "",
    observedAt: evidenceLocalTime(), sampleSize: "", meetingCriterion: "", synthetic: false };
}
export function evidencePayload(value, documentVersion) {
  const { objective, task, criterion, learnerGroup, observation, method, sourceReference, conditions = "", synthetic = false, inquiryId, decisionId, decisionVersion } = value;
  return { documentVersion, objective, task, criterion, learnerGroup, observation, method, sourceReference, conditions, synthetic,
    observedAt: new Date(value.observedAt).toISOString(), ...(inquiryId ? { inquiryId } : {}), ...(decisionId ? { decisionId, decisionVersion } : {}),
    ...(method !== "document_check" && value.sampleSize !== "" && value.sampleSize != null ? { sampleSize: Number(value.sampleSize) } : {}),
    ...(method !== "document_check" && value.meetingCriterion !== "" && value.meetingCriterion != null ? { meetingCriterion: Number(value.meetingCriterion) } : {}) };
}
function TextField({ label, value = "", onChange, multiline = false, ...props }) {
  const id = useId(); const Control = multiline ? Textarea : Input;
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><Control id={id} value={value} onChange={(event) => onChange(event.target.value)} {...props} /></Field>;
}

export function LearningEvidenceForm({ value, onChange, onSubmit, onCancel, busy = false, title = "记录学习证据", linkedPlan }) {
  const methodId = useId(); const syntheticId = useId();
  const documentCheck = value.method === "document_check";
  const patch = (field, next) => onChange({ ...value, [field]: next });
  const mismatch = linkedPlan && ["objective", "criterion", "learnerGroup", "method", "conditions"].some((key) => (value[key] ?? "").normalize("NFKC").trim().replace(/\s+/g, " ") !== (linkedPlan[key] ?? "").normalize("NFKC").trim().replace(/\s+/g, " "));
  return <form className="learning-form" onSubmit={onSubmit} aria-label={title}>
    <h3>{title}</h3>
    {linkedPlan ? <p className="learning-meta">已带入所选决策的目标、任务、判据与取证条件。本次观察会直接关联这项决策。</p> : null}
    {mismatch ? <p className="learning-notice" role="status">本次口径与计划不同。观察仍可保留，审议只能记录为证据不足。</p> : null}
    <fieldset disabled={busy} className="decision-plan-fields">
      {[["objective", documentCheck ? "核对目标" : "本次学习目标"], ["task", documentCheck ? "核对任务" : "学生完成的任务"], ["criterion", "成功判据"], ["learnerGroup", documentCheck ? "核对范围" : "观察群体"], ["conditions", "取证条件"], ["observation", "实际观察"], ["sourceReference", "证据来源与定位"]].map(([key, label]) => <TextField key={key} label={label} required={key !== "conditions"} maxLength={key === "observation" ? 4000 : key === "task" ? 2000 : key === "objective" ? 500 : key === "learnerGroup" ? 300 : 1000} multiline={["task", "criterion", "conditions", "observation"].includes(key)} value={value[key]} onChange={(next) => patch(key, next)} />)}
      <Field><FieldLabel htmlFor={methodId}>取证方式</FieldLabel><select id={methodId} className="learning-select" value={value.method} onChange={(event) => patch("method", event.target.value)}>{Object.entries(evidenceMethods).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></Field>
      <TextField label="观察时间" type="datetime-local" step="any" required value={value.observedAt} onChange={(next) => patch("observedAt", next)} />
      {!documentCheck ? <details><summary>补充人数（可选）</summary><div className="decision-plan-fields"><TextField label="观察人数" type="number" min="1" max="10000" value={value.sampleSize} onChange={(next) => patch("sampleSize", next)} /><TextField label="达到判据的人数" type="number" min="0" max={value.sampleSize || "10000"} value={value.meetingCriterion} onChange={(next) => patch("meetingCriterion", next)} /></div></details> : <p className="learning-meta">文档核对仅检验设计与原文，不统计学生达标人数。</p>}
      <label htmlFor={syntheticId} className="decision-synthetic-label"><input id={syntheticId} type="checkbox" checked={Boolean(value.synthetic)} onChange={(event) => patch("synthetic", event.target.checked)} /> 这些是合成或演示数据</label>
      {value.synthetic ? <p className="learning-meta">合成观察不能确认真实学习变化。</p> : null}
    </fieldset>
    <div className="learning-actions"><Button type="submit" size="sm" disabled={busy}>保存证据</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button></div>
  </form>;
}
