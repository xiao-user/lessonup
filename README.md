# LessonUp

面向教师的备课工作台：管理备课本和课时文件，编辑 A4 教案，与上下文 Agent 协作，并基于当前教案生成可编辑、可导出的课堂演示。

## 主要功能

- **备课工作区**：备课本、学期框架、教材与单元关联，Tiptap 教案编辑、A4 自动分页和撤销/重做。
- **上下文助手**：独立线程与分支、流式回复、工具活动、资料引用、附件和写入审批。
- **学习验证**：真实学习证据、改进假设与替代解释、教师采用和实施、后续复测与审议；复测可作为下一轮诊断起点。
- **教学决策**：把关键教学判断记录为带证据、选项、反例、不确定性和证伪条件的决策；Agent 只提议，教师确认、实施并记录复测审议。
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

教学判断由同一 Pi Agent 的静态专业规范承担，普通教学任务共享稳定的课程、资料和反馈工具；Dashi 是唯一独立 Skill。产品闭环、精简取舍与后续能力边界见 [教育 Agent 架构](docs/education-agent-architecture.md)。

性能验证使用 `npm run test:e2e:performance` 的生产构建与 CPU 降速长文档场景；人工评审与真实课堂成效的区分见 [教育专业能力验证](docs/professional-review.md)。

当前默认开发和生产链路不依赖 Docker、Supabase 或 Node Container。仓库仍保留部分旧入口和迁移工具，它们不是默认启动方式。

### 会话与审批

原生 Pi 负责模型循环和工具执行；每个 `thread + branch` 的历史隔离。原始消息持续保存，较旧上下文按模型窗口容量后台压缩，不按固定对话轮数截断。静态指令与 Skill 前缀保持可缓存，动态策略放在请求尾部。Fast 对话仍调用同一模型，不使用预设回复。

Agent 生成或修改教案时，Pi 工具参数中的正文增量实时投影到 A4 草稿，不进入自动保存与撤销历史。完整提案通过校验后，教师在 A4 底部采用或放弃；可切换原文继续编辑，采用时仍以服务端快照和版本校验保护其他修改。等待采用不占用 Agent 执行槽，教师可以继续对话；文件决定不另起模型续答，结果留在提出修改的原消息下。刷新恢复已有草稿，不重新发送生成请求。

审批决定、业务交付、助手续答和网络同步分别记录或派生。课堂演示等需要交付的审批仍保留续答流程：已保存的结果不会因为刷新失败变回待生成；仅回复失败时恢复回复，不重复写入。

### 学习验证

在课时右侧切换至“学习验证”，记录目标、学生任务、成功判据、观察群体、实际表现、时间和来源；人数可选。可自行记录调整或让同一 Pi Agent 提出方案与复测建议。助手只能保存待采用方案或待审议建议；教师分别确认采用、实际实施与最终判断。教案正文仍走原有提案与版本审批，保存学习方案不会自动改写 A4。

复测绑定具体实施记录，核对目标、判据和群体；不一致时只能作“证据不足”判断。已审议的基线与后测会进入本课及同单元相邻课时的反馈读取，支持下一轮设计。前后变化不能直接证明因果效果，也不能用采用次数替代学习成效。记录按索引分页读取，写入使用版本校验、幂等请求和保存回执恢复。

产品动作携带结构化 `taskIntent`，避免由按钮提示词猜测写入授权。现稿已足够或证据不足时，Agent 可在读取规范内容后明确完成而不制造修改提案。

### 教学决策

课时右侧“教学决策”把关键取舍写成可检查的记录：问题、至少两个选项与代价、可定位证据、反例、假设、不确定性、置信度、预期信号与证伪条件。教师可以确认采用、拒绝、保留现稿或判定证据不足；实施后必须引用晚于实施时间的真实学习证据完成复测审议。

Agent 只能读取决策上下文并提交候选，不能替教师确认、实施或审议；证据不足时提交 `insufficient_evidence`。决策与教案写入相互独立，采用决策不会自动改写 A4。每次变更保留版本并使用幂等命令；遥测只记录事件类型、决策/证据标识与耗时，不记录自由文本或学生标识。

无教师条件下可运行 `npm run eval:decision-quality` 生成匿名的 baseline/treatment 盲评包，汇总六维评分、配对差值、bootstrap 区间和二次加权 kappa；结果标注为内部专家代理，不代表外部专家共识或课堂学习效果。设计、边界与验证记录见 [决策工作台](docs/decision-workspace/README.md)。

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

## 教材与课标数据

教材目录、知识点网络和国家课标是平台数据，由脚本直接导入 D1，不依赖 Supabase。命令默认写入**本地** Wrangler D1；写入生产库必须显式追加 `-- --remote`。`-- --persist-to <目录>` 使用独立的本地状态目录，不影响日常开发库。先执行 `npm run db:migrate:local`，再按顺序导入：

```bash
npm run curriculum:import            # 教材目录，约 1 分钟
npm run curriculum:knowledge:seed    # 知识点网络样本，依赖已导入的目录
npm run curriculum:standards:import  # 课标切片与向量，需要 EMBEDDING_* 配置
npm run curriculum:standards:publish
```

- 同一教材目录版本可重复导入；生产库若要更换目录版本，需单独设计数据迁移，不能通过远程导入直接覆盖（已有学期框架会引用旧版本）。课标导入可中断后重跑，并会复用已保存的向量。完整流程和文档状态见 [data/curriculum/standards/README.md](data/curriculum/standards/README.md)。
- 对已发布的课标版本重复执行 `import` 只补全缺失的向量和由标题路径派生的学段、年级范围，不改写正文。从旧 Supabase 环境迁入的生产库这两项为空：先用 `npm run curriculum:standards:status -- --remote` 查看，再用 `npm run curriculum:standards:import -- --remote` 补全。补全学段与年级范围后，按学段和年级的过滤才会生效；补全向量后，配置了嵌入服务的检索会用查询向量参与排序，嵌入失败或未配置时退回文本排序。
- `d1:import-supabase` 和 `r2:import-supabase-storage` 是从旧 Supabase 环境一次性迁移业务数据和私有文件的入口；它们连同 `supabase/` 目录，是仓库里主要剩下的 Supabase 相关部分。

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
- `npm run eval:curriculum-standards` 用已导入的 D1 课标数据评测检索；`-- --lexical-only` 只看文本排序（未配置嵌入服务或嵌入失败时的行为）。
- `npm run eval:decision-quality` 导出/汇总教学决策盲评包；需要 baseline/treatment JSON 简报，结果仅作内部代理证据。
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
- `server/decisions/`：教学决策领域、证据卡、生命周期、持久化端口与 API。
- `server/knowledge/`、`server/mcp/`、`server/curriculum/`：资料处理、检索和教材目录。
- `src/features/`：备课本、教案、学期框架、助手、决策、学习验证与演示等前端功能。
- `d1/migrations/`、`data/curriculum/`：数据库迁移与教材平台数据。
- `scripts/`：课程数据导入、Dashi 资源准备和 D1 运维脚本；`scripts/lib/wrangler-d1.ts` 提供本地（进程内 binding）和远程（Wrangler CLI）D1 访问。
- [AGENTS.md](AGENTS.md)：编码 Agent 的工作指南，包含常用命令、验证要求、代码位置和项目特有约束；不存放实现日志。
