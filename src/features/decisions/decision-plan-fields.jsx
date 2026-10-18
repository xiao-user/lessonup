import { useId } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export const emptyObservationPlan = () => ({ kind: "", objective: "", task: "", criterion: "", learnerGroup: "", method: "", conditions: "", baselineEvidenceId: null });
export const observationPlanComplete = (plan) => Boolean(plan && ["design_check", "learning_change"].includes(plan.kind) && ["objective", "task", "criterion", "learnerGroup"].every((key) => plan[key]?.trim()) && (plan.kind === "design_check" ? plan.method === "document_check" : ["student_work", "assessment", "teacher_observation"].includes(plan.method)));

export function DecisionTextField({ label, multiline = false, value = "", onChange, ...props }) {
  const id = useId();
  const Control = multiline ? Textarea : Input;
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><Control id={id} value={value} onChange={(event) => onChange(event.target.value)} {...props} /></Field>;
}

export function DecisionChoice({ label, children, value, onChange, ...props }) {
  const id = useId();
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><select id={id} className="learning-select" value={value} onChange={(event) => onChange(event.target.value)} {...props}>{children}</select></Field>;
}

export function DecisionPlanFields({ value, onChange, disabled = false, required = true }) {
  const plan = value ?? emptyObservationPlan();
  const patch = (key, next) => onChange({ ...plan, [key]: next });
  const documentCheck = plan.kind === "design_check";
  return <fieldset className="decision-plan-fields" disabled={disabled}>
    <legend className="decision-plan-heading">这次准备核对什么</legend>
    <DecisionChoice label="检验类型" required={required} value={plan.kind} onChange={(kind) => onChange({ ...plan, kind, method: kind === "design_check" ? "document_check" : "" })}>
      <option value="">请选择本次检验类型</option><option value="design_check">设计核对：目标、任务与评价是否对齐</option><option value="learning_change">学习变化：实施前后的学生表现</option>
    </DecisionChoice>
    <p className="decision-field-help">设计核对检验方案本身；学习变化需要同口径的实施前基线与实施后观察。</p>
    <DecisionTextField label="核对目标" required={required} maxLength={500} value={plan.objective} onChange={(next) => patch("objective", next)} />
    <DecisionTextField label="取证任务" required={required} multiline maxLength={1000} value={plan.task} onChange={(next) => patch("task", next)} />
    <DecisionTextField label="成功判据" required={required} multiline maxLength={1000} value={plan.criterion} onChange={(next) => patch("criterion", next)} />
    <DecisionTextField label={documentCheck ? "核对范围" : "观察群体"} required={required} maxLength={300} value={plan.learnerGroup} onChange={(next) => patch("learnerGroup", next)} />
    {documentCheck ? <p className="decision-field-help">取证方式：文档核对。教案设计一致不能直接证明学生学习改善。</p> : <DecisionChoice label="计划取证方式" required={required} value={plan.method} onChange={(next) => patch("method", next)}>
      <option value="">请选择</option><option value="student_work">学生作品</option><option value="assessment">评价任务</option><option value="teacher_observation">教师观察</option>
    </DecisionChoice>}
    <DecisionTextField label="取证条件" multiline maxLength={1000} value={plan.conditions} onChange={(next) => patch("conditions", next)} />
    <p className="decision-field-help">记录提示、材料难度、作答时间等条件；后续观察将带入这些字段供你核对。</p>
  </fieldset>;
}
