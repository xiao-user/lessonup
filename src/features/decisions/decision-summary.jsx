import { useState } from "react";

const outcomes = { supported: "符合预期", not_supported: "未见预期", inconclusive: "证据不足" };
const levels = { primary: "原始材料", first_hand_summary: "一手记录摘要", secondary: "二手材料", synthetic: "合成验收材料" };
const concise = (value = "", limit = 150) => value.length > limit ? `${value.slice(0, limit)}…` : value;
const opening = (value = "") => concise(value.match(/^.*?[。！？](?:\s|$)?/s)?.[0] ?? value, 100);

export function DecisionOverview({ decision, typeLabel, statusLabel, children }) {
  const [showAllOptions, setShowAllOptions] = useState(false);
  const [showFullQuestion, setShowFullQuestion] = useState(false);
  const options = decision.options ?? [];
  const chosen = options.find((option) => option.id === decision.chosenOptionId);
  const ordered = chosen ? [chosen, ...options.filter((option) => option.id !== chosen.id)] : options;
  const visible = showAllOptions ? ordered : ordered.slice(0, 2);
  return <>
    <div className="decision-heading-line"><span>{typeLabel}</span><span>{statusLabel} · v{decision.version}</span></div>
    <h3 className={`decision-question${!showFullQuestion && decision.question.length > 100 ? " is-condensed" : ""}`}>{decision.question}</h3>
    {decision.question.length > 100 ? <button className="decision-text-button" type="button" aria-expanded={showFullQuestion} onClick={() => setShowFullQuestion((value) => !value)}>{showFullQuestion ? "收起完整问题" : "展开完整问题"}</button> : null}
    <p className="decision-judgment">{opening(decision.rationale)}</p>
    <section className="decision-next-step" aria-label="当前下一步">
      <h4>下一步</h4>
      <p>{decision.status === "proposed" || decision.status === "draft" ? "核对前提与取舍后，由你选择采用、拒绝或暂缓判断。" : decision.status === "teacher_confirmed" ? "先准备需要的教案修改，再分别记录实际实施与学生表现。" : decision.status === "implemented" ? "记录本次实施后的观察，再核对证据能支持什么结论。" : decision.status === "reviewed" ? `本次审议：${outcomes[decision.review?.outcome] ?? "已记录"}。后续判断仍需新的观察与适用条件。` : "可补充依据，或提出下一项需要判断的问题。"}</p>
      {children}
    </section>
    {decision.status === "insufficient_evidence" ? <p className="decision-context-note">这是一条证据缺口记录，尚不能据此确认方案有效。</p> : null}
    {decision.assumptions?.length ? <section className="decision-preconditions" aria-label="判断前提">
      <h4>先核对这些前提</h4>
      <ul>{decision.assumptions.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
    </section> : <p className="decision-context-note">尚未写明判断前提，请在确认前核对适用条件。</p>}
    {options.length ? <section className="decision-comparison" aria-label="比较方案">
      <h4>{options.length > 2 && !showAllOptions ? "先比较两个主要取舍" : "方案与取舍"}</h4>
      {visible.map((option) => <article key={option.id} className="decision-comparison-item">
        <p className="decision-option-label">方案 {options.indexOf(option) + 1}{option.id === decision.chosenOptionId ? ["teacher_confirmed", "implemented", "reviewed", "no_change"].includes(decision.status) ? " · 教师已选择" : " · 候选建议" : ""}</p>
        <p className="decision-option-statement">{concise(option.statement, 110)}</p>
        <ul>{option.tradeoffs.slice(0, 2).map((item, index) => <li key={`${index}-${item}`}>{concise(item, 110)}</li>)}</ul>
        {option.statement.length > 110 || option.tradeoffs.length > 2 || option.tradeoffs.some((item) => item.length > 110) ? <details className="decision-option-more"><summary>完整方案与全部取舍</summary>
          <p>{option.statement}</p>
          <ul>{option.tradeoffs.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
        </details> : null}
      </article>)}
      {options.length > 2 ? <button className="decision-text-button" type="button" onClick={() => setShowAllOptions((value) => !value)}>{showAllOptions ? "收起其他方案" : `比较其他 ${options.length - 2} 个方案`}</button> : null}
    </section> : null}

  </>;
}

export function DecisionReferenceDetails({ decision, context, cards, emit, changedLabels, rejectionReasons }) {
  return <div className="decision-inspection">
    <details className="decision-disclosure"><summary>完整判断理由与自评说明</summary>
      <p>{decision.rationale}</p>
      {decision.confidence != null ? <p className="decision-context-note">自评数值 {Math.round(decision.confidence * 100)}%（未校准）。它记录当时的把握，不是判断正确的概率，也不是学习效果证明。</p> : <p className="decision-context-note">未填写自评数值。</p>}
    </details>
    {decision.evidenceCardIds?.length ? <section className="decision-evidence" aria-label="原文依据"><h4>核对原文依据（{decision.evidenceCardIds.length}）</h4>
      {decision.evidenceCardIds.map((id) => {
        const card = cards.get(id);
        if (!card) return null;
        return <details key={id} onToggle={(event) => { if (event.currentTarget.open) emit("evidence_opened", { decisionId: decision.id, evidenceId: id }); }}>
          <summary>{card.claim}</summary>
          <blockquote className="decision-excerpt">{card.excerpt}</blockquote>
          <p className="decision-meta">{card.source.system === "lessonup" ? "本课资料" : card.source.system} · {card.source.locator ?? "未提供定位"} · 版本 {card.source.version}</p>
          <p className="decision-meta">材料性质：{levels[card.level] ?? "待核对"}</p>
          <p>适用范围：{card.applicability}</p>
          <p>限制：{card.limitations.join("；")}</p>
          {typeof card.confidence === "number" ? <p className="decision-context-note">相关性自评 {Math.round(card.confidence * 100)}%（未校准），请以原文与适用范围核对。</p> : <p className="decision-context-note">相关性未评分，请核对原文与适用范围。</p>}
        </details>;
      })}
    </section> : <p className="decision-context-note">尚无可核对的原文证据。保存判断不代表依据已充分。</p>}
    {decision.counterevidence?.length || decision.uncertainties?.length ? <details className="decision-disclosure"><summary>反例、替代解释与尚缺的依据</summary>
      {decision.counterevidence?.length ? <><h4>可能改变判断的反例或解释</h4><ul>{decision.counterevidence.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></> : null}
      {decision.uncertainties?.length ? <><h4>仍不确定的部分</h4><ul>{decision.uncertainties.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></> : null}
    </details> : null}
    {decision.expectedSignal || decision.falsifier ? <details className="decision-disclosure"><summary>实施后如何检查这项判断</summary>
      {decision.expectedSignal ? <><h4>预期观察到什么</h4><p>{decision.expectedSignal}</p></> : null}
      {decision.falsifier ? <><h4>什么观察会使这项判断不成立</h4><p>{decision.falsifier}</p></> : null}
      <p className="decision-context-note">请分别核对设计是否对齐、学生表现与效果归因。新评价采集到结果，不能单独证明旧评价已经足够。</p>
    </details> : null}
    {decision.implementation || decision.review || decision.rejection ? <details className="decision-disclosure"><summary>已记录的教师决定与实施</summary><dl className="decision-facts">
      {decision.rejection ? <><dt>未采用的原因</dt><dd>{rejectionReasons[decision.rejection.reasonCode] ?? decision.rejection.reasonCode}：{decision.rejection.rationale}</dd></> : null}
      {decision.implementation ? <><dt>实际实施</dt><dd>{new Date(decision.implementation.implementedAt).toLocaleString()}{decision.implementation.note ? ` · ${decision.implementation.note}` : ""}</dd></> : null}
      {decision.review ? <><dt>教师审议</dt><dd>{outcomes[decision.review.outcome]}：{decision.review.rationale}</dd><dt>结论的限制</dt><dd>{decision.review.limitations}</dd></> : null}
    </dl></details> : null}
    {context?.diff && context.versions?.length > 1 ? <details className="decision-disclosure"><summary>本次记录有哪些变化</summary>
      <p>版本 {context.versions.length - 1} → {context.versions.length}</p>
      {context.diff.statusFrom !== context.diff.statusTo ? <p>状态已更新。</p> : null}
      {context.diff.confidenceDelta ? <p>自评数值变化：{context.diff.confidenceDelta > 0 ? "+" : ""}{Math.round(context.diff.confidenceDelta * 100)} 个百分点（未校准）</p> : null}
      {context.diff.addedEvidence.length ? <p>新增证据：{context.diff.addedEvidence.length} 条</p> : null}
      {context.diff.removedEvidence.length ? <p>移除证据：{context.diff.removedEvidence.length} 条</p> : null}
      {context.diff.changed.some((field) => changedLabels[field]) ? <p>更新内容：{context.diff.changed.filter((field) => changedLabels[field]).map((field) => changedLabels[field]).join("、")}</p> : null}
    </details> : null}
  </div>;
}
