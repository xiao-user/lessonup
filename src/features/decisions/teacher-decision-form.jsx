import { Button } from "@/components/ui/button";
import { DecisionChoice, DecisionPlanFields, DecisionTextField, emptyObservationPlan } from "./decision-plan-fields";

export const lessonFields = { unit: "单元", period: "课时", totalPeriods: "总课时", topic: "课题", objectives: "教学目标", knowledgePoints: "重点知识", continuity: "前后知识关联", focus: "重点难点", preparation: "教学准备", process: "教学过程", assessment: "评价练习", homework: "作业设计", board: "板书设计", reflection: "教学反思" };
export const lines = (value = "") => value.split("\n").map((line) => line.trim()).filter(Boolean);
export function teacherDecisionForm(decision) {
  return { decisionType: decision?.decisionType ?? "", question: decision?.question ?? "", rationale: decision?.rationale ?? "",
    options: decision?.options?.length ? decision.options.map((option) => ({ ...option, tradeoffsText: option.tradeoffs.join("\n") })) : [{ id: "opt_a", statement: "", tradeoffsText: "" }, { id: "opt_b", statement: "", tradeoffsText: "" }],
    assumptionsText: decision?.assumptions?.join("\n") ?? "", counterevidenceText: decision?.counterevidence?.join("\n") ?? "", uncertaintiesText: decision?.uncertainties?.join("\n") ?? "",
    expectedSignal: decision?.expectedSignal ?? "", falsifier: decision?.falsifier ?? "", confidence: decision?.confidence ?? "", observationPlan: decision?.observationPlan ?? null,
    sourceField: "", sourceExcerpt: "", sourceClaim: "" };
}
export function TeacherDecisionForm({ value, onChange, onSave, onCancel, busy, types, sourceDocument, existingEvidenceCount = 0 }) {
  const patch = (key, next) => onChange({ ...value, [key]: next });
  const optionPatch = (index, key, next) => onChange({ ...value, options: value.options.map((option, at) => at === index ? { ...option, [key]: next } : option) });
  return <form className="decision-form decision-inline-form" aria-label="教师记录判断" onSubmit={(event) => { event.preventDefault(); onSave("draft"); }}>
    <h3>记录你已有的判断</h3><p className="decision-context-note">先保存判断草稿；依据与取证计划完善后，再保存为待确认候选。记录不会自动采用或改写教案。</p>
    <fieldset disabled={busy} className="decision-plan-fields">
      <DecisionChoice label="判断类型" required value={value.decisionType} onChange={(next) => patch("decisionType", next)}><option value="">请选择</option>{Object.entries(types).filter(([key]) => key !== "no_change").map(([key, text]) => <option key={key} value={key}>{text}</option>)}</DecisionChoice>
      <DecisionTextField label="需要决定的问题" multiline required maxLength={1000} value={value.question} onChange={(next) => patch("question", next)} />
      {value.options.map((option, index) => <div className="decision-plan-fields" key={option.id}><DecisionTextField label={`方案 ${index + 1}`} multiline required maxLength={2000} value={option.statement} onChange={(next) => optionPatch(index, "statement", next)} /><DecisionTextField label={`方案 ${index + 1} 的取舍（每行一项）`} multiline required value={option.tradeoffsText} onChange={(next) => optionPatch(index, "tradeoffsText", next)} /></div>)}
      <DecisionTextField label="我的判断理由" multiline required maxLength={4000} value={value.rationale} onChange={(next) => patch("rationale", next)} />
      <DecisionTextField label="判断前提（每行一项）" multiline value={value.assumptionsText} onChange={(next) => patch("assumptionsText", next)} />
      <details className="decision-disclosure"><summary>补充依据与不确定性</summary><div className="decision-plan-fields">
        <DecisionTextField label="反例或替代解释（每行一项）" multiline value={value.counterevidenceText} onChange={(next) => patch("counterevidenceText", next)} />
        <DecisionTextField label="尚不确定的部分（每行一项）" multiline value={value.uncertaintiesText} onChange={(next) => patch("uncertaintiesText", next)} />
        <p className="decision-context-note">已有 {existingEvidenceCount} 条原文依据。不选择栏目会保留全部依据；选择栏目将以本次引用替换现有依据，由服务端核对当前原文与版本。</p>
        <DecisionChoice label="引用本课栏目" value={value.sourceField} onChange={(field) => onChange({ ...value, sourceField: field, sourceExcerpt: sourceDocument?.[field] ?? "" })}><option value="">保留已有依据，暂不重新引用</option>{Object.entries(lessonFields).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</DecisionChoice>
        {value.sourceField ? <><DecisionTextField label="引用的教案原文" multiline required maxLength={4000} value={value.sourceExcerpt} onChange={(next) => patch("sourceExcerpt", next)} /><DecisionTextField label="这段原文支持什么判断" multiline required maxLength={1000} value={value.sourceClaim} onChange={(next) => patch("sourceClaim", next)} /></> : null}
      </div></details>
      <details className="decision-disclosure"><summary>取证计划与判断边界</summary><div className="decision-plan-fields">
        {value.observationPlan ? <><DecisionPlanFields value={value.observationPlan} onChange={(next) => patch("observationPlan", next)} disabled={busy} required={false} /><Button type="button" variant="ghost" size="sm" onClick={() => patch("observationPlan", null)}>稍后再定取证计划</Button></> : <Button type="button" variant="outline" size="sm" onClick={() => patch("observationPlan", emptyObservationPlan())}>填写结构化取证计划</Button>}
        <DecisionTextField label="预期观察到什么" multiline maxLength={2000} value={value.expectedSignal} onChange={(next) => patch("expectedSignal", next)} />
        <DecisionTextField label="什么观察会使这项判断不成立" multiline maxLength={2000} value={value.falsifier} onChange={(next) => patch("falsifier", next)} />
        <p className="decision-context-note">分别核对设计是否对齐、学生表现和效果归因。不能仅凭改后任务获得答案，推断改前评价已经足够。</p>
        <DecisionTextField label="自评数值 0–1（未校准，可留空）" type="number" min="0" max="1" step="0.01" value={value.confidence} onChange={(next) => patch("confidence", next)} />
      </div></details>
    </fieldset>
    <div className="decision-actions"><Button size="sm" type="submit" disabled={busy}>保存判断草稿</Button><Button size="sm" type="button" variant="outline" disabled={busy} onClick={(event) => { if (event.currentTarget.closest("form").reportValidity()) onSave("proposed"); }}>保存为待确认候选</Button><Button size="sm" type="button" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button></div>
  </form>;
}
