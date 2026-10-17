# 教学决策工作台 v1 — 2026-10-18

## 行为

- 课时右侧新增“教学决策”标签，与“备课助手”“学习验证”并列；键盘左右、Home、End 可切换。
- 教师可查看决策的问题、选项与代价、可定位证据卡、反例、假设、不确定性、置信度、预期信号与证伪条件；证据卡默认折叠，展开时记录聚合事件。
- 每次变更显示与上一版的变化：状态、置信度、证据增减与字段变化，避免只看到最新文本而看不到判断如何移动。
- 教师动作：确认采用、拒绝、保留现稿（仅 `no_change` 决策）、登记实施、记录复测审议。复测审议只能引用晚于实施时间的真实学习证据；采用不等于有效，实施不等于保真。
- Agent 新增 `read_decision_context` 与受任务意图门控的 `propose_decision`；必须先读取上下文，只能提交 `draft/proposed/insufficient_evidence`，不能替教师确认、实施或审议。新 `decision_proposal` 意图由面板“请助手准备决策”发起，完成门要求决策候选。
- 决策写入独立于 A4 提案与审批；每次变更保留版本、校验 `expectedVersion`、以幂等命令保存并支持回执恢复。
- 遥测只记录事件类型、决策/证据标识、耗时与计数，不记录自由文本或学生标识。

## 验证

- `npm run typecheck`、`npm run typecheck:cloudflare` 通过。
- `npm test`：134 个文件 / 748 项通过 + 1 项跳过；包含决策领域、服务、D1 仓储、Agent 工具、遥测与盲评工具测试。
- `npm run test:e2e:agent`：39 项通过，新增决策工作台完整链路（创建 → 证据 → 确认 → 实施 → 复测审议 → 遥测查询）。
- `npm run test:legacy`：编辑器回归通过；`npm run build` 通过；`npm run check` 全链路通过。
- 本地与远程 D1 迁移 `0024_lesson_decisions.sql`、`0025_lesson_decision_events.sql` 均执行成功。
- 生产核对：`/api/health` 返回 200；首页 200；新增 `decision-workbench` 分包返回 200；未登录访问决策 API 返回 401（符合预期）。
- 未做登录后的生产浏览器验收；真实教师盲评与课堂效果未执行，相关结论仍标注为未验证。

## 发布与回滚

- 发布提交：`1b47b9b`（发布记录提交另计）。
- 发布标签：`v2026.10.18-decision-workspace`（指向发布记录提交）。
- 回退标签：`checkpoint/2026-10-18-before-decision-workspace`（提交 `1056441`）。
- 发布前生产 Worker 版本：`f15f370a-9922-40e0-9906-bb78d39bda5b`。
- 本次生产 Worker 版本：`98d5c257-5535-4a0c-82bb-2031dfdb82ad`。
- 生产数据库已应用 `0024`、`0025`；两张新表为增量，旧 Worker 不读取，回退 Worker 时保留表与数据。
- 发布使用 `npm run cloudflare:deploy`（`--keep-vars`），未改生产变量、密钥、绑定或定时任务。

恢复上一个 Worker 版本：

```bash
npx wrangler rollback f15f370a-9922-40e0-9906-bb78d39bda5b --config wrangler.jsonc --message "Rollback decision workspace v1"
```

若需让主分支回到发布前状态，用新提交还原 `1056441`，不要重置已推送的历史。不要删除 `lesson_decisions`、`lesson_decision_versions`、`lesson_evidence_cards`、`lesson_decision_events`，除非先导出数据。

## 边界

- 真实教师访谈、8–12 人课堂 pilot、学生学习效果：**未执行**。
- 内部盲评工具已可用，但尚未收集 baseline/treatment 简报与两位评审评分；不能据此声称决策质量提升。
- 证据卡目前随提案写入；尚无独立证据管理界面；复测审议一次引用一条学习证据。
