# LessonUp

面向教师的备课工作台：管理备课本和课时文件，编辑 A4 教案，与上下文 Agent 协作，并基于当前教案生成可编辑、可导出的课堂演示。

## 主要功能

- **备课工作区**：备课本、学期框架、教材与单元关联，Tiptap 教案编辑、A4 自动分页和撤销/重做。
- **上下文助手**：独立线程与分支、流式回复、工具活动、资料引用、附件和写入审批。
- **资料库**：私有文件上传、异步解析与索引、按权限检索。
- **课堂演示**：确认 Dashi 演示方案后生成并保存，支持浏览器预览、编辑及 HTML/PDF/PPTX 导出。

## 当前架构

| 层 | 实现与职责 |
| --- | --- |
| 前端 | React、Vite、Tiptap、shadcn/Base UI；展示文档和规范化 Agent 事件 |
| API | Hono on Cloudflare Workers；认证、作用域校验和业务服务 |
| 实时执行 | Durable Object 按用户/线程承载原生 Pi Agent 的流、取消和队列 |
| 持久化 | D1 保存业务数据、原始对话、运行、审批和作品元数据；R2 保存私有文件 |
| 模型与检索 | 配置的同一模型处理主对话及辅助任务；Function Tools、MCP 和版本化 Skills 提供能力 |
| 演示 | Workers 使用预计算布局目录规划；浏览器加载官方 Dashi 主题与编辑/导出运行时 |

当前默认开发和生产链路不依赖 Docker、Supabase 或 Node Container。仓库仍保留部分旧入口和迁移工具，它们不是默认启动方式。

### 会话与审批

原生 Pi 负责模型循环和工具执行；每个 `thread + branch` 的历史隔离。原始消息持续保存，较旧上下文按模型窗口容量后台压缩，不按固定对话轮数截断。静态指令与 Skill 前缀保持可缓存，动态策略放在请求尾部。Fast 对话仍调用同一模型，不使用预设回复。

Agent 修改教案前提交经过校验的提案；教师确认后，以服务端快照和版本校验执行写入。审批决定、业务交付、助手续答和网络同步分别记录或派生：已保存的结果不会因为刷新失败变回待生成；仅回复失败时恢复回复，不重复写入。审批与续答保留在原消息下。

### Dashi

项目唯一 Skill 位于 `server/agent/skills/dashi-ppt`。上游代码与 Web 适配分离，使用原生 goal、主题、编辑器和完整 PPTX 导出器；必要兼容处理在外部适配层完成。

`npm run dashi:prepare` 从项目内 Skill 生成 `public/dashi` 共享资源及布局目录。生成作品保存内容，不为每份演示复制编辑器；不会执行上游本地预览服务器或在 Cloudflare 启动 Chromium。生成 PPT 不修改 A4 教案。导出器许可证随项目 Skill 保留，使用或分发时需遵守相应条款。

## 本地开发

需要 Node.js `>=24.19.0 <25`、npm，以及支持当前环境的 Wrangler 本地运行依赖。

```bash
npm ci
npm run dashi:prepare
npm run db:migrate:local
```

在项目根目录创建不提交的 `.dev.vars`，覆盖生产配置中的本地运行值：

```dotenv
NODE_ENV=development
LESSONUP_PERSISTENCE=d1
APP_ORIGIN=http://127.0.0.1:5173
```

根据需要补入下节的模型和服务配置，然后启动：

```bash
npm run dev
```

- 前端：`http://127.0.0.1:5173`。
- Worker API：`http://127.0.0.1:8787`；Vite 将 `/api` 和 `/mcp` 转发到它。
- Wrangler 本地 D1/R2 与生产数据隔离。首次启动前须完成本地迁移。
- 登录依赖 D1 中已有账号；当前没有自动创建本地管理员的启动步骤，也不要假设存在默认账号。账号初始化需另行完成。
- `LESSONUP_DEV_AUTH=1` 仅供测试，不是开发或生产环境的登录开关。
- 未配置模型时，Agent 不可用；未配置嵌入服务时，不能完成资料索引。不会用模拟回复替代真实服务。

`npm run dev:api` 是保留的 Node 入口，不等同于上述 Worker 开发链路；不要用它替代 `dev:cloudflare`。

## 配置

配置校验以 `server/config.ts` 为准，Cloudflare 资源绑定见 `wrangler.jsonc`。Worker 本地配置使用 `.dev.vars`；Node 工具可能读取 `.env`，不要混用为线上配置。

| 配置 | 用途 |
| --- | --- |
| `MODEL_BASE_URL`、`MODEL_ID`、`MODEL_API_KEY` | 模型服务地址、模型名和凭据 |
| `MODEL_API` | `openai-completions` 或 `openai-responses` |
| `MODEL_CONTEXT_WINDOW`、`MODEL_MAX_TOKENS` | 模型上下文窗口与输出上限 |
| `AGENT_STATE_ENCRYPTION_KEY`、`MCP_TOKEN_SECRET` | Agent 状态加密与 MCP 签名；使用独立的至少 32 字符密钥 |
| `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS` | 资料索引使用的嵌入服务 |
| `TAVILY_API_KEY` | 可选联网搜索 |
| `APP_ORIGIN` | 前端来源地址 |

六项 `MODEL_*` 配置须一起提供；四项 `EMBEDDING_*` 配置同样须成组提供。生产环境要求 D1、关闭测试身份、配置 MCP 密钥；启用 Agent 时还须配置状态加密密钥。任何服务密钥都不得写入 `VITE_*` 变量或提交到仓库。

## 验证

```bash
npm run typecheck
npm run typecheck:cloudflare
npm test
npm run test:legacy
npm run build
```

- `npm test` 包含业务单元测试、React 状态/组件测试和原生 Pi 集成测试；不等同于真实供应商在线评测。
- `npm run test:e2e:agent` 使用 Playwright Chromium 和确定性测试服务，自动启动独立端口；运行前需安装相应浏览器。
- `npm run eval:agent` 用于配置真实模型后的评测；`eval:agent:release` 额外执行配置的性能预算检查。
- `npm run check` 依次运行类型检查、Vitest、编辑器回归、Playwright 和前端构建；Cloudflare 类型检查需单独执行。

临时构建和 QA 输出不要提交或长期保留在项目目录。

## 部署

新环境先配置 Cloudflare 账号、D1、R2、Durable Object 绑定及生产 Variables/Secrets。迁移与发布分开执行：

```bash
# 仅在存在待应用迁移且已确认目标数据库时执行
npm run db:migrate:remote

# 准备 Dashi 资源、构建前端并发布 Worker
npm run cloudflare:deploy
```

发布脚本使用 `--keep-vars`，不从本地 `.env` 覆盖生产模型配置，也不自动执行 D1 数据迁移。发布后核对 `/api/health`、前端资源及所改功能。

账号运维工具 `d1:provision-admin` **只操作远程 D1**，不是本地初始化命令。使用时显式指定 `--user-id` 和 `--login`；省略用户 ID 会尝试从旧 Supabase Docker 环境读取。不要将数据迁移工具作为日常启动步骤。

## 代码导航

- `cloudflare/`：Worker 入口、Durable Object、资源装配和定时任务。
- `server/agent-runtime/pi/`：原生 Pi 协调、模型协议、工具、Session 与上下文。
- `server/conversation/`：会话业务规则与公共审批投影。
- `server/presentations/`、`src/lib/dashi-browser/`：作品交付及浏览器适配。
- `server/repositories/`、`server/platform/`：持久化、认证和存储适配器。
- `server/knowledge/`、`server/mcp/`、`server/curriculum/`：资料处理、检索和教材目录。
- `src/features/`：备课本、教案、学期框架、助手、演示等前端功能。
- `d1/migrations/`、`data/curriculum/`：数据库迁移与教材平台数据。
- [AGENTS.md](AGENTS.md)：编码 Agent 的工作指南，包含常用命令、验证要求、代码位置和项目特有约束；不存放实现日志。
