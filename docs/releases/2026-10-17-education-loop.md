# 2026-10-17：教育 Agent 与学习验证闭环

版本标签：`v2026.10.17-education-loop`。

本版收敛原生 Pi 工具与教学策略，加入学习证据、待采用方案、实施、复测和教师审议，并优化长教案的编辑、草稿投影与响应式侧栏。工程流程通过真实模型与本地 D1 验收；合成学习证据不能证明真实教学效果，专家盲评和来源准确性仍需独立验证。

## 发布前检查

- Node.js `>=24.19.0 <25`。
- 类型检查、Worker 类型检查、构建通过。
- Vitest：709 项通过、1 项跳过；编辑器回归：30 项通过。
- 生产预览浏览器回归：33 项通过。
- 真实模型验收覆盖修改审批、保留无关手工编辑、首字返回前取消、刷新不重发、学习验证与缺失依据时保留现稿。

## 迁移与配置

生产目标为 `wrangler.jsonc` 中的 Worker `lessonup`、D1 `lessonup`（`00a6480e-e7eb-4d37-b464-ec9ceb4ea59e`）。本次待执行迁移：

- `0022_class_feedback_blueprint_reads.sql`：新增课堂反馈查询索引。
- `0023_learning_evidence_and_inquiries.sql`：新增学习证据、方案及版本历史表。

这两项均为增量迁移，不删除、重命名或改写既有业务数据。先单独执行 `npm run db:migrate:remote`，再用 `npm run cloudflare:deploy` 发布。发布脚本通过 `--keep-vars` 保留生产配置，不把本地模型配置或密钥复制到生产。

## 回退基点

- 发布前 Git 提交：`a039572cc731b36e56148db6adf335fe47d6bd47`。
- Git 回退标签：`rollback/2026-10-17-before-education-loop`。
- 发布前生产 Worker 版本：`bfc2d3ca-0cdb-448c-9324-50958e26f4a0`。

快速回退生产 Worker：

```bash
npx wrangler rollback bfc2d3ca-0cdb-448c-9324-50958e26f4a0 --config wrangler.jsonc --message "Rollback education-loop release"
```

随后核对线上 `/api/health`、登录和既有教案编辑。回退版本使用旧业务功能，新增学习表留在 D1 中；无需删除新表，也不应自动回放或重复提交用户写入。

如需让 Git 主分支也回退这次发布，应通过新提交保留历史：

```bash
git revert v2026.10.17-education-loop
git push origin main
npm run cloudflare:deploy
```

D1 的灾难恢复与代码回退是不同操作。发布前另行记录 Time Travel bookmark；整库恢复可能丢失恢复点之后的有效写入，不作为本次代码回退的自动步骤。

## 上线验收

部署后检查 Worker 部署版本、`/api/health` 和静态资源；使用浏览器核对登录、备课文件、审批、取消恢复和学习验证。线上测试内容应明确标注验收用途，保留用户已有资料，不将合成样本描述为真实学情。
