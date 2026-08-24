# LessonUp

LessonUp 是一个包含真实 A4 教案编辑器与上下文备课 Agent 的 Vite/React 原型。浏览器只负责交互和文档编辑；身份、模型调用、项目隔离、会话、审批、MCP 与版本写入都由同仓库内的 Hono 服务端负责。

## 运行边界

- `npm run dev` 同时启动 Vite 与 Hono；`npm run dev:web`、`npm run dev:api` 可分别启动。
- 未配置外部凭据时，编辑器使用开发身份与进程内仓库，右侧明确显示“AI 服务尚未配置”，不会返回预设回复。
- 配置 Supabase 后，按顺序执行 [全部数据库迁移](./supabase/migrations)，身份、文档版本、Pi 会话、审批和知识来源会切换到持久存储。
- 服务端环境变量以 [.env.example](./.env.example) 为准。`SUPABASE_SERVICE_ROLE_KEY`、模型 API Key、MCP Secret 和状态加密密钥不得放入 `VITE_` 变量。

## Agent 运行链路

1. API 依据认证用户验证 `notebook → lesson_file → thread → branch` 归属。
2. 同步能力路由使用确定性业务规则，不等待额外模型调用；`MODEL_ID` 配置的模型承担主对话、异步标题、starter、记忆压缩和轻量审查。
3. 专业 Agent 以同一模型驱动的内部工具形式协作；整份教案是固定工作范围，当前栏目与文字选区只是焦点线索。
4. SSE 只发送规范化文本、工具状态、来源和审批事件，不发送供应商原始事件或推理内容。
5. 所有写入必须形成 `DocumentPatch` 并暂停等待审批。批准时在事务中校验文档版本与原文，再生成完整版本快照。
6. 每个 `thread + branch` 使用独立 Session；超过最近约 12 轮的历史由当前配置模型压缩为结构化摘要，原始消息继续保留。

模型运行时只依赖 `MODEL_BASE_URL`、`MODEL_ID` 和 `MODEL_API_KEY`。`MODEL_API` 默认使用 OpenAI-compatible Responses API，也可显式切换为 `openai-completions`。Responses 请求保持 `store: false`；LessonUp 不使用供应商会话替代自己的 Supabase 分支 Session。

## 课堂演示

教案工作区的“课堂演示”先由同一个 Pi Agent 按需读取当前 A4 教案，并依据课堂编导原则生成唯一一份学生可见逐页脚本。教师确认后，同一 `thread + branch` 才加载项目内固定版本的官方 Dashi Skill；Dashi 只能把已批准脚本映射到真实布局并渲染，不得再次生成或改写内容。LessonUp 调用 Dashi 原生 `render_goal_deck.sh`，并打开其预览、编辑、演示和 HTML/PDF/PPTX 导出服务。生成演示不会修改 A4 教案。

首次生成会由 Dashi 原生脚本在其 `project/` 目录安装运行依赖；无需配置 `DASHI_SKILL_ROOT`。

## 目录

- `server/agent-runtime/pi`：Pi 运行内核、Coordinator、模型协议、作用域工具、会话与审批续跑。
- `server/agent`：能力路由、业务校验、事件呈现和版本化 Skills。
- `server/mcp`：知识库和联网搜索的 Streamable HTTP MCP。
- `server/knowledge`：私有资料上传、Office/PDF 结构化解析、异步队列与 BGE-M3 索引 worker。
- `server/presentations`：已批准 storyboard 的 Dashi 契约、生成记录与受限原生调用桥接。
- `server/repositories`：内存开发仓库与 Supabase 持久仓库。
- `server/curriculum`：国家教材书目与官方章节目录查询。
- `data/curriculum`：SmartEdu 官方目录树清洗产物（仅 `official_tree`）。
- `server/security`：短期 MCP 令牌与服务端状态密钥。
- `src/components/primitives`、`src/components/atoms`：Beautiful UI 原始组件与生产化的 Pi 事件渲染层。
- `src/components/site/IceCreamHarness.tsx`：连接真实 Pi 公共事件、审批与 Prompt Bar 的 Beautiful UI 对话外壳。
- `src/features/assistant`：线程、分支、SSE、来源、工具活动和审批交互。
- `src/features/presentations`：课堂演示生成与打开入口。
- `docs/agent-interaction-contract.md`：整体上下文、读取策略、事件投射和对话展示合同。
- `supabase/migrations`：RLS、版本、会话、运行、审批、知识库、教材目录和审计表。

本地 `npm run db:start` / `db:reset` 会在迁移后执行 `npm run curriculum:import`，将 `data/curriculum` 导入平台表。重新清洗原始导出可用 `npm run curriculum:prepare -- --source <exports目录>`。

## 验证

`npm run check` 依次执行 TypeScript、服务端单元/集成测试、编辑器回归测试与生产构建。浏览器验收还覆盖一次性本地导入、详情页、原生光标/回车、自动分页、会话管理和未配置外部服务时的明确降级状态。

## 生产启用

本地无外部凭据时不会模拟模型或资料检索。生产启用前需先配置 Supabase、OpenAI-compatible 模型服务、BGE-M3 与可选 Tavily，应用数据库迁移，再运行真实账号隔离、Pi 模型工具循环、知识召回与审批恢复评测。`NODE_ENV=production` 会强制关闭开发身份，并始终要求 Supabase、MCP 签名密钥与 Agent 状态密钥。
