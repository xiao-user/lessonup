# LessonUp

LessonUp 是一个包含真实 A4 教案编辑器与上下文备课 Agent 的 Vite/React 原型。浏览器只负责交互和文档编辑；身份、模型调用、项目隔离、会话、审批、MCP 与版本写入都由同仓库内的 Hono 服务端负责。

## 运行边界

- `npm run dev` 同时启动 Vite 与 Hono；`npm run dev:web`、`npm run dev:api` 可分别启动。
- 未配置外部凭据时，编辑器使用开发身份与进程内仓库，右侧明确显示“AI 服务尚未配置”，不会返回预设回复。
- 配置 Supabase 后，执行 [数据库迁移](./supabase/migrations/202607140001_lessonup_agent_harness.sql)，身份、文档版本、会话、审批和知识来源会切换到持久存储。
- 服务端环境变量以 [.env.example](./.env.example) 为准。`SUPABASE_SERVICE_ROLE_KEY`、DeepSeek Key、MCP Secret 和状态加密密钥不得放入 `VITE_` 变量。

## Agent 运行链路

1. API 依据认证用户验证 `notebook → lesson_file → thread → branch` 归属。
2. Flash 只选择本轮需要的 Skill、Tool、MCP 与专业 Agent；Harness 再校验白名单和具体版本。
3. Pro 负责主对话与复杂教学任务，专业 Agent 以工具形式协作；整份教案是固定工作范围，当前栏目与文字选区只是焦点线索。
4. SSE 只发送规范化文本、工具状态、来源和审批事件，不发送供应商原始事件或推理内容。
5. 所有写入必须形成 `DocumentPatch` 并暂停等待审批。批准时在事务中校验文档版本与原文，再生成完整版本快照。
6. 每个 `thread + branch` 使用独立 Session；超过最近约 12 轮的历史由 Flash 压缩为结构化摘要，原始消息继续保留。

## 目录

- `server/agent`：DeepSeek Provider、能力路由、Skills、Manager、专业 Agent 与 Harness。
- `server/mcp`：知识库和联网搜索的 Streamable HTTP MCP。
- `server/knowledge`：私有资料上传、Office/PDF 结构化解析、异步队列与 BGE-M3 索引 worker。
- `server/repositories`：内存开发仓库与 Supabase 持久仓库。
- `server/security`：短期 MCP 令牌和可恢复 RunState 加密。
- `src/components/craft-agent`：从 Craft Agents 移植并适配 LessonUp 标准化事件的统一对话组件。
- `src/features/assistant`：线程、分支、SSE、来源、工具活动和审批交互。
- `docs/agent-interaction-contract.md`：整体上下文、读取策略、事件投射和对话展示合同。
- `supabase/migrations`：RLS、版本、会话、运行、审批、知识库和审计表。

## 验证

`npm run check` 依次执行 TypeScript、服务端单元/集成测试、编辑器回归测试与生产构建。浏览器验收还覆盖一次性本地导入、详情页、原生光标/回车、自动分页、会话管理和未配置外部服务时的明确降级状态。

## 生产启用

本地无外部凭据时不会模拟模型或资料检索。生产启用前需先配置 Supabase、DeepSeek、BGE-M3 与可选 Tavily，应用数据库迁移，再运行真实账号隔离、模型工具循环、知识召回与审批恢复评测。`NODE_ENV=production` 会强制关闭开发身份，并拒绝缺少 Supabase 或 Agent 加密密钥的启动配置。
