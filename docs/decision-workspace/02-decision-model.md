# 02 决策模型（v1 已实现）

> 实现状态：决策表、证据卡与教师动作已按本模型落地（迁移 `0024`/`0025`）。落地时补充了 `version`、`rejection`、`implementation`、`review` 与聚合事件；细节见 [05-implementation.md](05-implementation.md)。

## 1. 原则

1. **决策是一等对象**：文档是决策的表达，不是决策本身。
2. **证据先于建议**：没有可定位的证据，就不给确定语气；证据不足时允许“不改”。
3. **保留反例与替代解释**：只记录被采纳方案是不够的，被放弃的选项与理由同样重要。
4. **教师最终决定**：模型只能提出候选；确认、实施、审议由教师完成。
5. **可追溯、可失效**：每张证据卡带来源、版本、定位、适用范围与失效条件。
6. **最小负担**：默认只记录影响当前决策的 3–5 条，不把教师变成数据录入员。

## 2. 决策类型

| 类型 | 要回答的问题 | 例子 |
| --- | --- | --- |
| `scope_priority` | 这节课保留/砍掉什么？ | 把“体会反复”作为核心，压缩背景介绍 |
| `goal_evidence` | 学会的标志是什么？ | 学生能用两处文本证据解释，而非复述 |
| `task_sequence` | 用哪个任务承载理解？ | 先比较两段改写，再回到原文找依据 |
| `scaffolding` | 哪类学生需要什么支架？ | 为表达困难学生提供句式支架，不降低目标 |
| `assessment` | 用什么证据判断达成？ | 出口条 + 无提示新段落迁移题 |
| `implementation_adjustment` | 课堂中怎么调？ | 若多数学生只复述，追问反例并增加对比 |
| `followup` | 下次改什么、看什么信号？ | 下次检查独立解释与延迟保持 |
| `no_change` | 证据是否支持保留现稿？ | 现有设计已足够，明确不改 |

## 3. 决策记录 schema（示例）

```json
{
  "schema_version": 1,
  "id": "decision_...",
  "owner_id": "user_...",
  "notebook_id": "notebook_...",
  "lesson_file_id": "lesson_...",
  "unit_id": "unit_...",
  "lesson_blueprint_id": "blueprint_...",
  "decision_type": "goal_evidence",
  "question": "本课‘体会反复’的达成证据应该是什么？",
  "context_version": { "document_version": 7, "framework_version": 3 },
  "options": [
    {
      "id": "opt_a",
      "statement": "以出口条复述反复的作用作为达成证据",
      "tradeoffs": ["易评分", "不能区分复述与理解"]
    },
    {
      "id": "opt_b",
      "statement": "以无提示新段落中解释反复效果作为达成证据",
      "tradeoffs": ["更接近迁移", "评分成本更高"]
    }
  ],
  "chosen_option_id": "opt_b",
  "rationale": "目标指向理解而非术语记忆；用新段落区分复述与解释。",
  "evidence_card_ids": ["ev_standard_1", "ev_textbook_2", "ev_student_3"],
  "counterevidence": ["上次出口条显示多数学生只能复述，需先补对比活动"],
  "assumptions": ["本班已具备找出重复词句的基础"],
  "uncertainties": ["新段落难度可能引入额外负担"],
  "confidence": 0.72,
  "expected_signal": "独立解释比例上升；延迟一周仍能解释新段落",
  "review_at": "2026-10-25",
  "status": "teacher_confirmed",
  "provenance": {
    "created_by": "agent",
    "model_run_id": "run_...",
    "tool_call_id": "tool_...",
    "confirmed_by": "teacher_..."
  },
  "created_at": "2026-10-18T01:00:00Z",
  "updated_at": "2026-10-18T01:20:00Z"
}
```

### 字段约束

- `options` 至少 2 个（`no_change` 除外）；每个选项必须有 `tradeoffs`。
- `evidence_card_ids` 非空，除非 `status = insufficient_evidence`。
- `confidence` 是 0–1 的显式值，并附理由（可放在 `uncertainties`）。
- `expected_signal` 必须是可观察的，不使用“效果更好”这类不可检验表述。
- `status` 只能由对应角色推进（见状态机）。
- `context_version` 必须与决策时的文档/框架版本绑定。

## 4. 证据卡 schema

```json
{
  "schema_version": 1,
  "id": "ev_standard_1",
  "kind": "curriculum_standard",
  "source": {
    "system": "curriculum_standards",
    "uri": "d1://curriculum_standards/<id>",
    "locator": "第三学段·阅读与鉴赏·第3条",
    "version": "2022",
    "captured_at": "2026-10-18T00:40:00Z"
  },
  "excerpt": "能联系上下文和自己的积累，推想课文中有关词句的意思，辨别词语的感情色彩，体会其表达效果。",
  "claim": "本课目标应指向解释与表达效果，而非术语记忆。",
  "supports": ["opt_b"],
  "applicability": "第三学段阅读教学；需结合本班文本难度。",
  "limitations": ["课标不规定具体课堂活动与评分方式。"],
  "conflicts_with": [],
  "confidence": 0.95,
  "expires_at": null,
  "pii_level": "none"
}
```

### 证据等级与允许用途

| 等级 | 例子 | 可以证明 | 不可以证明 |
| --- | --- | --- | --- |
| P0 一手 | 课标原文、教材原文、学生原始作品、课堂录像/观察记录 | 条款、内容、具体表现 | 因果效果、全班推广 |
| P1 一手汇总 | 教师教案版本、评分细则、校历与课时 | 约束与实施条件 | 学生掌握 |
| P2 二手 | 教研记录、公开试题分析、专家解读 | 假设与参照 | 作为原文引用 |
| P3 合成 | 模型生成案例、模拟学生表现 | 工程与流程测试 | 任何专业或效果结论 |

- 课标/教材引用必须带 `locator`，不允许无定位引用。
- `pii_level` 为 `student` 的证据卡只存派生特征与匿名 ID；原始作品留在 R2 私有对象并做权限与审计。
- `expires_at` 用于课标/教材版本或学情变化后的失效提示。

## 5. 生命周期

```text
draft
  → proposed（Agent/教师提出候选）
  → teacher_confirmed | teacher_rejected | no_change | insufficient_evidence
  → implemented（教师确认实施时间与实际调整）
  → reviewed（基于真实证据的审议：符合/未见/证据不足）
  → superseded（被新决策替代；保留历史）
```

- 每次状态变化追加版本，不覆盖历史。
- `teacher_rejected` 必须记录理由类别（证据不足、不可实施、不符合学情、其他）。
- `no_change` 与提案互斥；它同样需要证据与理由。
- `reviewed` 只能由教师完成；模型只能提出审议建议。
- 任何状态都不能自动推导“有效”。

## 6. 决策 diff

不只展示文档改动，还展示判断变化：

```json
{
  "decision_id": "decision_...",
  "from_version": 3,
  "to_version": 4,
  "changed": ["chosen_option_id", "evidence_card_ids", "confidence"],
  "added_evidence": ["ev_student_4"],
  "removed_evidence": ["ev_standard_1"],
  "expected_signal_delta": "从‘同题正确’改为‘无提示新段落解释’",
  "what_would_falsify": "若新段落独立解释比例未上升，或延迟后回落，则本决策不成立"
}
```

## 7. 数据模型草案（仅设计，Phase 0 不迁移）

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `decision_records` | 决策版本（append-only） | owner/lesson 外键；版本号；状态；`context_version` |
| `decision_evidence` | 决策与证据卡的关联 | 证据卡不可变；支持/反驳标记 |
| `evidence_cards` | 证据原文/定位/适用范围 | 来源、版本、locator、pii_level |
| `decision_outcomes` | 实施后的审议记录 | 必须关联真实证据 ID；不能早于实施 |
| `decision_events` | 遥测（打开/查看/确认/拒绝/耗时） | 不含学生 PII；可聚合 |

索引：`(owner_id, lesson_file_id, status)`、`(lesson_file_id, decision_type)`、`(review_at)`、`(unit_id, created_at)`。

迁移策略：新增表，不修改现有学习证据/提案表；决策记录通过 `run_id`、`proposal_id`、`evidence_id` 关联既有事实。上线前提供回退与数据导出方案。

## 8. Agent 合同（Phase 1 最小实现）

工具（拟）：

- `read_decision_context`：读取当前课时已有决策、相关证据卡、最近学习证据与版本。
- `propose_decision`：创建候选（draft/proposed），必须包含 options、evidence、counterevidence、uncertainties、expected_signal。
- `complete_without_change`：沿用现有工具，与 `no_change` 决策关联。

硬性要求：

- 不得创建 `teacher_confirmed` 及以上状态；不得代替教师实施或审议。
- 证据卡引用必须来自工具结果或教师提供；禁止编造 locator/excerpt。
- 证据不足时输出 `insufficient_evidence` 候选，而不是“看起来合理”的方案。
- 与现有文档提案的关系：决策确认后，才生成对应的文档提案；或提案附带决策 ID。两者分离，避免“改文档”冒充“做决策”。

## 9. UI 合同

- 课时侧栏或 A4 顶部展示 3–5 个决策卡：问题、当前选择、置信度、待补证据。
- 证据抽屉：原文、定位、版本、适用范围、冲突、失效提示；一键“在原文中查看”（若可用）。
- 决策 diff：变更判断、证据增减、预期信号、证伪条件。
- “保留现稿”与“证据不足”是一等操作，不做成隐藏菜单。
- 交互预算：点击反馈 ≤100 ms；决策卡展开 ≤200 ms；不阻塞编辑与滚动。

## 10. 开放问题（评审确认后再实现）

1. 决策粒度：每课时 3–5 个是否合适？是否按单元汇总？
2. 是否允许教师只记录“决定”不记录“选项”？如何避免负担过重？
3. 证据卡是否包含教师课堂观察？其可信度如何标注？
4. 学生证据采用原始作品还是派生特征？合规与可用性的平衡点？
5. 决策与现有学习证据表是扩展还是新表？迁移与回退路径？
6. 文档提案是否必须绑定决策 ID，还是允许独立存在？