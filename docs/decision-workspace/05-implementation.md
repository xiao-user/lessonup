# 05 已落地的垂直切片（v1）

本文件记录实际实现与验证结果，替代“只写文档”的阶段。真实课堂效果仍未验证。

## 1. 已实现

### 1.1 数据

- `0024_lesson_decisions.sql`：决策版本（append-only）、决策版本历史、证据卡。
- `0025_lesson_decision_events.sql`：聚合遥测（无自由文本、无学生标识）。
- 本地与远程迁移均已执行；生产 Worker 已发布（见 [发布记录](../releases/2026-10-18-decision-workspace.md)）。

### 1.2 服务与端口

- [server/decisions/contracts.ts](../../server/decisions/contracts.ts)：决策、证据卡、审议、命令、事件类型。
- [server/decisions/validation.ts](../../server/decisions/validation.ts)：课标/教材必须可定位、学生数据必须在私有对象、选项/反例/不确定性/证伪条件/版本身份校验。
- [server/decisions/lifecycle.ts](../../server/decisions/lifecycle.ts)：Agent 只能提议；确认、实施、审议只能由教师完成。
- [server/decisions/service.ts](../../server/decisions/service.ts)：归属校验、版本 CAS、幂等回执、复测证据时间校验。
- [server/repositories/d1-decision-repository.ts](../../server/repositories/d1-decision-repository.ts)：D1 写入与查询；内存实现用于测试和 E2E。

### 1.3 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/lesson-files/:id/decisions` | 列表与证据卡 |
| GET | `/api/lesson-files/:id/decisions/:decisionId` | 单条决策与版本 |
| GET | `/api/lesson-files/:id/decisions/commands/:key` | 幂等回执 |
| POST | `/api/lesson-files/:id/decisions` | 创建候选（教师或 Agent） |
| PATCH | `/api/lesson-files/:id/decisions/:decisionId` | 确认/拒绝/保留现稿/实施/审议 |
| GET/POST | `/api/lesson-files/:id/decisions/events` | 聚合遥测 |

### 1.4 Agent

- 新工具 `read_decision_context`：读取当前课时决策、证据与版本；普通教学任务可用。
- 新工具 `propose_decision`：仅在结构化 `decision_proposal` 意图下可用；必须先读取上下文；只能提交 `draft/proposed/insufficient_evidence`。
- 新任务意图 `decision_proposal`：由教学决策面板的“请助手准备决策”发起；完成门要求决策候选或“不改”。
- 提示策略要求选项、取舍、证据、反例、不确定性、置信度、预期信号与证伪条件；不允许替教师确认/实施/审议。

### 1.5 前端

- 课时右侧新增“教学决策”标签（键盘左右/Home/End 可切换）。
- 决策列表、选项与取舍、证据抽屉（定位/版本/适用范围/限制）、反例、不确定性、预期信号、证伪条件。
- 教师操作：确认采用、拒绝、保留现稿、登记实施、记录审议（只能引用实施后的真实学习证据）。
- 幂等命令、保存回执恢复、错误分类提示。

### 1.6 遥测

事件：`decision_viewed`、`evidence_opened`、`option_compared`、`proposal_requested`、`decision_confirmed`、`decision_rejected`、`no_change_confirmed`、`implementation_recorded`、`review_recorded`。只记录类型、决策 ID、证据 ID、耗时与计数，不记录自由文本或学生标识。

### 1.7 无教师条件下的评测工具

```bash
npm run eval:decision-quality -- export /tmp/decision-cases.json /tmp/decision-review
# 两位内部评审分别填写 rating-template.json 后：
npm run eval:decision-quality -- summarize /tmp/decision-review/packet.json /tmp/decision-review/coordinator-key.json /tmp/decision-summary.json /tmp/reviewer-a.json /tmp/reviewer-b.json
```

- 对 baseline/treatment 简报做匿名化、随机排序，隐藏变体标签。
- 六维 rubric：决策清晰度、证据可定位、替代方案与反例、不确定性与适用条件、验证信号、教师可用性。
- 汇总：每维均值、配对差值、bootstrap 区间、二次加权 kappa、大分歧与严重问题。
- 明确标注“内部专家代理”，不代表外部专家或课堂效果。

## 2. 验证

- `npm run typecheck` 通过。
- Vitest：134 个文件 / 748 通过 + 1 跳过（含决策领域、服务、D1 仓储、Agent 工具、遥测与评测工具）。
- Playwright：39 项通过，新增决策工作台完整链路（创建 → 证据 → 确认 → 实施 → 复测审议 → 遥测）。
- 编辑器回归、严格类型检查、生产构建与 `npm run check` 通过。
- 本地与远程 D1 迁移 `0024`、`0025` 均已执行。

## 3. 当前边界

- 真实教师访谈、8–12 人文课堂 pilot、学生学习结果：**未执行**；所有专业判断仍为内部代理或工程证据。
- 决策证据目前随提案写入；尚无独立的证据管理界面。
- 复测审议一次引用一条学习证据；多证据/延迟复测仍由学习验证模块承载。
- 尚无决策质量遥测看板；事件已可读，分析脚本面向离线评审。
- 未做登录后的生产浏览器验收；生产已部署，回滚版本见发布记录。

## 4. 回退

- 代码回退：撤回本次提交即可；数据库新增表不影响旧代码（旧代码不会读取），迁移可保留。
- 生产回退：恢复上一 Worker 版本；不删除新表，避免破坏已记录决策。
- 若必须删除表，需先导出 `lesson_decisions`、`lesson_decision_versions`、`lesson_evidence_cards`、`lesson_decision_events`。

## 5. 下一步（按价值排序）

1. 内部盲评：准备 20–30 个真实课时 case 的 baseline/treatment 简报，跑两轮盲评，记录 kappa 与分歧。
2. 真实教师可用性测试：5 位教师、只读/候选模式，测决策时间与理解成本。
3. 预注册 pilot：等教师资源到位后按 [03-evaluation-protocol.md](03-evaluation-protocol.md) 启动。
4. 证据管理：允许教师补充学生作品/课堂观察作为证据卡，并做权限与脱敏。
5. 遥测分析：按决策类型聚合 time-to-decision、证据查看、拒绝原因；只看过程，不推断因果。
