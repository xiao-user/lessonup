# LessonUp Agent evaluations

`npm run eval:agent` exercises the running LessonUp API through the production
`PiLessonAgentCoordinator`, Pi model/tool loop, scoped business tools and MCP
configuration. The separate Pi grader scores only observable outcomes. This is
intentionally separate from the deterministic Playwright
harness, which remains responsible for UI and database contracts.

Required environment:

- `LESSONUP_EVAL_ACCESS_TOKEN`
- `LESSONUP_EVAL_NOTEBOOK_ID`
- `LESSONUP_EVAL_LESSON_FILE_ID`
- `LESSONUP_EVAL_SEMESTER_FRAMEWORK_ID`（运行学期框架案例时必需）
- `MODEL_API_KEY`
- `MODEL_BASE_URL`
- `MODEL_ID`
- `MODEL_API` (`openai-responses` or `openai-completions`)
- `MODEL_CONTEXT_WINDOW` and `MODEL_MAX_TOKENS`

Optional:

- `LESSONUP_EVAL_BASE_URL` (defaults to `http://127.0.0.1:8787`)
- `LESSONUP_EVAL_GRADER_API_KEY`, `LESSONUP_EVAL_GRADER_BASE_URL` and
  `LESSONUP_EVAL_GRADER_MODEL` only when the grader must use a separate
  credential, endpoint, or model. Otherwise the evaluation runner reuses the
  existing generic model configuration.

The runner creates one isolated thread per case, records normalized observable
events, rejects any generated approval so an evaluation never writes the lesson
document, soft-deletes the temporary thread, and writes
`<系统暂存目录>/lessonup-evals/agent/latest.json` (override with `LESSONUP_EVAL_OUTPUT_DIR`).

Set `LESSONUP_EVAL_CASE_IDS` to a comma-separated list when rerunning selected
regressions. Lesson-file and semester-framework cases share the same runner but
use their own canonical resource snapshot and isolated thread. If the grader is
temporarily unavailable, execution evidence is still written and the case fails
as `grader_unavailable` instead of losing the whole run.

Automated gates require successful completion of required tools, reject forbidden tool attempts, and cover approval boundaries,
sources and terminal failures. Every case is also graded by a separately configured
model against the canonical lesson document, lesson metadata, design basis, current
curriculum knowledge, real classroom feedback and its case-specific `rubric`. Five shared business gates
measure whether the Agent understands the current lesson, understands the current
curriculum when required, fulfills the teacher's actual goal, produces executable
classroom action, and keeps evidence and uncertainty honest. Generic, ungrounded,
non-actionable or unsupported-precision output fails the command and exits non-zero.
Teacher-facing tool names, schema parameters, UUIDs, internal knowledge codes,
validation codes, and technical retry narration are also hard failures.
The rubric is an executable release gate rather than an unscored note in the
result file. `tool-contract.test.ts` checks case requirements against the actual
native tool surface. The feedback case distinguishes observation, explanation,
adjustment and a future check; it cannot prove a learning improvement. Model
grading is a screening measure and still needs calibration against educator
judgment and real student work.

人工专业盲评另见 [教育专业能力验证](../docs/professional-review.md)。`npm run eval:professional` 只处理本地材料与人工评分，不调用模型或发送材料。缺少两位完整独立评审或存在严重问题、大分歧时不能通过。

Conditional cases can set `allowsNoChange`: a successful
`complete_without_change` replaces the proposal/approval requirement, while
required canonical reads and the substantive rubric still apply. A failed or
merely started no-op cannot pass, and a no-op plus approval is a conflict.

## 隔离的真实模型闭环冒烟测试

`npm run eval:learning:smoke` 使用项目已有 `MODEL_*` 配置和原生 Pi，在独立内存仓储中创建明确标注的合成案例，无需登录或真实教案 ID，也不操作 D1/R2。覆盖保留现稿、准备待采用方案、读取前后证据并提出待教师审议的复测建议。断言正文版本不变，不生成文档审批，不由模型代替教师采用、实施或最终审议。

默认使用产品的 `low` 思考强度；`LESSONUP_EVAL_THINKING_LEVEL=high` 或 `max` 可单独测量，仍使用同一配置模型。每案90秒后请求原生取消；供应商中断、失败、未完成或租约过期均不能通过。结果与每次运行记录写到系统暂存目录的 `lessonup-evals/native-learning/`，可用 `LESSONUP_EVAL_OUTPUT_DIR` 改为另一个工作区外路径。记录仅包含合成业务结果、公开工具状态、耗时和 token 使用，不保存凭据或私有推理。

这条命令验证真实工具行为，不评分教育专业水平或真实课堂效果，也不是 p95 延迟结论。跨学科专家盲评和真实学生的延迟、迁移表现仍需独立验证。

## 决策任务与盲评

`npm run eval:decision:smoke` 使用相同 `MODEL_*` 配置和原生 Pi；两例使用独立内存仓储，分别检查设计对齐候选与缺少学生效果证据时的候选。`LESSONUP_EVAL_CASE_IDS=goal_evidence` 可单独重跑，未知案例 ID 会在调用模型前失败。`LESSONUP_EVAL_REPETITIONS=2` 会预先固定两轮、每轮两例；允许 1–5 轮，每例重建独立仓储。报告在开始时创建、每例结束即更新，包含 `complete`、计划/完成/待执行/通过/失败计数、提案尝试数和工具失败数；失败与中断不会被丢弃。只有整个计划完成且全部通过才返回成功。报告还记录固定原文引用核对、初始证据数量、耗时与 token 使用，输出到系统暂存目录下 `lessonup-evals/native-decision`。它不操作生产库；少量固定案例不证明稳定成功率、延迟分位数、教师可用性或学习效果。

`npm run eval:decision-quality -- export <cases.json> <新目录>` 接受含 `caseId/decisionType/context/baseline/treatment` 的案例数组；`summarize <packet.json> <coordinator-key.json> <新summary.json> <ratings.json>...` 汇总评分。配对映射必须完整，每例恰有两个变体；`reviewed` 仅表示评分覆盖完成，差值方向为描述性的 `higher/lower/equal`。评分为同一常数时 kappa 不可估计，返回 `null`。保管配对密钥，样本指纹不认证标签真伪。详见 [原生模型验证记录](../docs/decision-workspace/06-native-decision-validation.md)。

## 性能发布门

### 前端长文档与流式压力测试

`npm run test:e2e:performance` 先构建生产包，在本地 Chromium 的4倍CPU降速下验证约4,700字、7页教案的草稿生成、输入、采用分页一致性、移动视口与中途取消恢复。传输是明确的确定性夹具，不用于证明模型能力。结果、CPU采样（可选 `LESSONUP_PERF_PROFILE=1`）、截图与追踪写到系统暂存目录；可用 Playwright 的 `--output` 覆盖目录。

记录首次打开耗时、流式期间的输入操作耗时、超过50ms长任务的超额时长之和（blocking time）以及帧间隔。输入耗时含 Playwright 调用与状态确认，不能冒充浏览器 INP。CPU降速结果只比较同一机器与同一夹具，不能推断全部真实设备或供应商延迟。

默认仅记录；发布约束显式设置 `LESSONUP_UI_ENFORCE_BUDGET=1` 和 `LESSONUP_UI_MAX_INPUT_MS`、`LESSONUP_UI_MAX_BLOCKING_MS`、`LESSONUP_UI_MAX_FRAME_GAP_MS` 三项正整数预算。缺失观测或超限不能通过。预算须由产品目标和实际设备基线决定，不与下面的模型延迟预算混为一个数字。

### 模型请求性能

每个案例都会写出实际的 `durationMs`、`firstOutputMs`、`modelRequests`、
`toolCalls` 与 `inputTokens`。普通 `npm run eval:agent` 只记录这些数据，便于
先建立基线；它不会偷偷套用任意阈值。

正式发布使用 `npm run eval:agent:release`，并且必须显式配置以下五个上限，否则
命令会失败而非假装通过：

- `LESSONUP_EVAL_MAX_DURATION_MS`
- `LESSONUP_EVAL_MAX_FIRST_OUTPUT_MS`
- `LESSONUP_EVAL_MAX_MODEL_REQUESTS`
- `LESSONUP_EVAL_MAX_TOOL_CALLS`
- `LESSONUP_EVAL_MAX_INPUT_TOKENS`

这使性能预算和业务质量门都成为可重复运行的发布条件；首次真实基线应由产品方根据
目标模型、网络和课堂可接受等待时间确定，再固化为环境配置。

## 课程标准检索评测

`npm run eval:curriculum-standards` 通过生产使用的 D1 读取仓储检索已发布课标，使用
`evals/curriculum-standard-cases.jsonl` 检查核心条款排名、共用课程方案召回和跨学科隔离。
结果默认写入系统暂存目录下的 `lessonup-evals/curriculum-standards-latest.json`（可用
`LESSONUP_EVAL_OUTPUT_DIR` 指定其他工作区外目录），其中记录评测目标与模式。它不调用生成模型，
也不会修改教案或课标索引；默认读取本地 Wrangler D1（先按 `data/curriculum/standards/README.md`
导入课标），`-- --remote` 读取生产库，`-- --persist-to <目录>` 读取独立的本地状态目录。

- 默认模式先用配置的嵌入服务（BGE-M3）为查询生成向量，与原生 Pi 的 `search_curriculum_standards` 工具在
  配置了嵌入服务时的做法一致，需要 `EMBEDDING_*` 配置。
- `-- --lexical-only` 不带查询向量，对应工具在未配置嵌入服务或嵌入调用失败时退回的纯文本排序，
  用来衡量文本排序本身的质量，不需要嵌入配置。
