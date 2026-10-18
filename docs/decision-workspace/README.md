# 决策工作台（Phase 0 + v1 实现）

这一组文档把 LessonUp 的下一步从“材料生成”收敛为“推动教学决策”。Phase 0 完成审计、模型与验证协议；v1 已落地可运行的决策记录、教师确认/实施/审议与无教师盲评工具。真实课堂效果仍未验证。

## 文档索引

| 文档 | 作用 | 状态 |
| --- | --- | --- |
| [00-charter.md](00-charter.md) | 目标、范围、约束、退出标准 | 待评审 |
| [05-implementation.md](05-implementation.md) | v1 实现、验证、回退与边界 | 已发布 |
| [01-current-state-audit.md](01-current-state-audit.md) | 现有能力、Agent 流、失败模式、性能基线 | 待评审 |
| [02-decision-model.md](02-decision-model.md) | 决策对象、证据卡、生命周期、数据模型 | v1 已实现 |
| [03-evaluation-protocol.md](03-evaluation-protocol.md) | 证据阶梯、当前替代验证、真实教师 pilot 预案 | 工具已备，pilot 待启动 |
| [04-instrumentation-and-slo.md](04-instrumentation-and-slo.md) | 指标、事件、性能 SLO、测量方式 | 事件已落地，指标待分析 |
| [06-native-decision-validation.md](06-native-decision-validation.md) | 原生模型暴露的问题、修复合同与评测边界 | 修复与验证 |
| [07-input-reliability.md](07-input-reliability.md) | 本地来源输入、分页、候选完整性与固定批次重试测量 | 已复核 |

## 当前约束

真实教师访谈与 8–12 位教师的课堂 pilot **暂时不可用**。因此：

- 现在能做的：代码/文档/数据审计、内部盲评（标注为内部专家代理，不冒充外部专家）、现有评测集上的决策质量对照、遥测埋点与协议预注册。
- 现在不能做的：把内部评审、合成案例或模型评分结果称为真实课堂证据，或据此宣称“国家级专业水平”“学习效果提升”。
- 一旦教师资源到位，按 [03-evaluation-protocol.md](03-evaluation-protocol.md) 的预注册方案直接启动 pilot，不需要重写协议。

## 评审方式

1. 先读 `00-charter.md` 与 `01-current-state-audit.md`，确认问题定义与失败模式。
2. 再读 `02-decision-model.md`，确认决策对象与证据卡是否覆盖真实教学判断。
3. 最后审 `03` / `04`，确认验证方式与性能预算是否可执行、可证伪。
4. 任何阶段只要证据不支持假设，就停止或改假设，不进入下一阶段。

## 发布记录

- [2026-10-18 教学决策工作台 v1](../releases/2026-10-18-decision-workspace.md)：生产 Worker 版本 `98d5c257-5535-4a0c-82bb-2031dfdb82ad`，迁移 `0024`/`0025` 已应用。

## 与现有系统的关系

- 沿用现有 Pi 协调器、D1/R2、审批与版本合同，不建立平行 harness 或第二份工作流真相。
- 现有学习证据表、课标/教材/知识网络数据、评测与盲评工具是 Phase 0 的输入，不重复造一套。
- 决策记录是新增的业务对象，提案/审批/学习证据继续保留各自语义。
