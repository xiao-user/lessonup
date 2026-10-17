# 04 埋点、指标与性能 SLO

## 1. 原则

- 只采集能驱动决策的实验数据；不为“数据丰富”而采集。
- 区分过程指标（采用、点击、耗时）与结果指标（决策质量、学习结果）；前者不能替代后者。
- 学生数据最小化：默认只存匿名 ID 与派生特征；原始作品留在 R2 私有对象并审计。
- 所有延迟按任务类型分列，报告 p50/p95；不把“正在处理”事件当作首字可用。

## 2. 事件模型（草案）

### 2.1 前端交互事件

| 事件 | 关键字段 | 用途 |
| --- | --- | --- |
| `decision_viewed` | decision_id, decision_type, lesson_id, at | 决策是否被看到 |
| `evidence_opened` | decision_id, evidence_id, kind, at | 证据是否被检查 |
| `option_compared` | decision_id, option_ids, at | 是否比较替代方案 |
| `decision_confirmed` | decision_id, chosen_option_id, rationale_len, at | 采纳/拒绝/保留现稿 |
| `decision_rejected` | decision_id, reason_code, at | 拒绝原因分类 |
| `no_change_confirmed` | decision_id, reason_code, at | 诚实保留现稿 |
| `review_recorded` | decision_id, outcome, evidence_ids, at | 实施后审议 |
| `interaction_latency` | surface, action, duration_ms | INP/交互反馈 |

字段约束：不携带学生姓名、原始作品内容或自由文本中的可识别信息；`rationale_len` 只记长度，不记正文。

### 2.2 Agent 与运行事件（沿用现有运行事实）

- 请求接收、首个模型事件、首个可用文本/决策候选、工具开始/结束、审批依赖写入完成、采用后同步。
- 已有字段：`durationMs`、`firstOutputMs`、`modelRequests`、`toolCalls`、`inputTokens`（见 [evals/README.md](../../evals/README.md)）。
- 新增：按决策类型分组的 `time_to_decision`、证据查看次数、候选被拒原因。

### 2.3 结果事件

- `outcome_recorded`：只允许关联真实证据 ID；记录观察、解释、局限，不允许模型自动填写。
- `implementation_recorded`：实施时间、实际调整、fidelity 标记（若 pilot 提供观察）。
- 学习结果：pilot 期间由研究工具采集，不进入日常遥测；日常只保留聚合、去标识指标。

## 3. 指标定义

| 指标 | 定义 | 类型 | 备注 |
| --- | --- | --- | --- |
| Time-to-decision | 打开决策到确认/拒绝的耗时 | 过程 | 需与决策复杂度分层 |
| 证据检查率 | 打开至少一张证据卡的决策占比 | 过程 | 不能代表质量 |
| 替代方案查看率 | 查看 ≥2 个选项的决策占比 | 过程 | 设计应鼓励 |
| 决策确认率 | 确认/提出的比例 | 过程 | **不是**质量指标 |
| 保留现稿率 | `no_change` 占比 | 过程 | 需结合证据充分性 |
| 返工率 | 确认后 7 天内被替代/回退的比例 | 过程 | 需定义窗口 |
| 理由完整度 | 必填字段完整率 | 过程 | 不评论文本质量 |
| 决策质量评分 | 盲评 rubric 平均分 | 结果（代理/外部） | 需一致性报告 |
| 教师备课时间 | 周日志/时间动作 | 结果 | pilot 采集 |
| 学生学习结果 | 独立/保持/迁移任务 | 结果 | pilot 采集 |
| TTFT | 请求到首个可用文本/候选中位与 p95 | 性能 | 按任务类型 |
| INP | 交互到下一帧 p75 | 性能 | 真实设备 |

## 4. 性能 SLO

### 4.1 UI

| 指标 | 目标 | 测量 |
| --- | --- | --- |
| 点击/按键反馈 | ≤100 ms（p95） | Playwright 交互测量 + 真实设备 |
| INP | p75 ≤200 ms | WebPageTest / RUM |
| 动画帧间隔 | 常规 ≤16.7 ms；长任务阻塞 ≤50 ms | CDP trace / PerformanceObserver |
| 决策卡展开 | ≤200 ms | 真实设备 trace |
| 取消/关闭反馈 | ≤100 ms | 交互测试 |

### 4.2 Agent

| 指标 | 目标（初版，需真实供应商基线后校准） | 测量 |
| --- | --- | --- |
| 请求接收 | ≤100 ms（p95） | 服务端 trace |
| 首个模型事件 | p50 ≤600 ms；p95 ≤1.5 s | 运行事件 |
| 首个可用文本/候选 | p50 ≤1.2 s；p95 ≤3 s | 运行事件 |
| 工具往返 | 按工具设 p95 预算（读文档/检索/课标分别） | 工具 trace |
| 取消生效 | ≤150 ms | 取消测试 |
| 整轮（按任务类型） | 按类型设 p95，不用统一数字掩盖差异 | 评测与遥测 |

**注意**：LLM 生成的“总时长”受供应商与网络支配，不能承诺毫秒级；可承诺的是感知响应（流式、首字、取消、乐观 UI）与预算内的 p95。当前单机 4× CPU 数字仅用于纵向比较。

## 5. 测量与门禁

- 前端：Playwright trace、`PerformanceObserver`、Lighthouse CI、WebPageTest；按设备档位分层。
- 服务端：OpenTelemetry 或现有运行事件；按任务类型聚合。
- 发布门：沿用并扩展 `LESSONUP_UI_ENFORCE_BUDGET`、`LESSONUP_UI_MAX_INPUT_MS`、`LESSONUP_UI_MAX_BLOCKING_MS`、`LESSONUP_UI_MAX_FRAME_GAP_MS`；模型侧沿用 `LESSONUP_EVAL_MAX_*` 五个阈值。
- 所有预算必须由产品目标与真实基线决定，先测量后固化；缺失观测视为不通过（当门禁开启时）。

## 6. 隐私与保留

- 默认禁采：学生姓名、学号、原始作品正文、自由文本理由。
- 允许采集：匿名 ID、事件类型、耗时、聚合分数、决策状态。
- 保留期与访问控制写入数据字典；pilot 数据单独存储、单独授权、可删除。
- 遥测用于改进产品，不用于对学生或教师做个体评价。

## 7. 遥测不能证明什么

- 采用率、点击率、停留时长不能证明决策正确或学习改善。
- 单机性能不能外推到全部设备与网络。
- 事件相关性不能替代对照与因果设计。
