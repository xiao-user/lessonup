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

Optional:

- `LESSONUP_EVAL_BASE_URL` (defaults to `http://127.0.0.1:8787`)
- `MODEL_API` (defaults to `openai-responses`)
- `LESSONUP_EVAL_GRADER_API_KEY`, `LESSONUP_EVAL_GRADER_BASE_URL` and
  `LESSONUP_EVAL_GRADER_MODEL` only when the grader must use a separate
  credential, endpoint, or model. Otherwise the evaluation runner reuses the
  existing generic model configuration.

The runner creates one isolated thread per case, records normalized observable
events, rejects any generated approval so an evaluation never writes the lesson
document, soft-deletes the temporary thread, and writes
`evals/results/latest.json`.

Set `LESSONUP_EVAL_CASE_IDS` to a comma-separated list when rerunning selected
regressions. Lesson-file and semester-framework cases share the same runner but
use their own canonical resource snapshot and isolated thread. If the grader is
temporarily unavailable, execution evidence is still written and the case fails
as `grader_unavailable` instead of losing the whole run.

Automated gates cover required and forbidden tools, approval boundaries,
sources and terminal failures. Every case is also graded by a separately configured
model against the canonical lesson document, lesson metadata, design basis, current
curriculum knowledge and its case-specific `rubric`. Five shared business gates
measure whether the Agent understands the current lesson, understands the current
curriculum when required, fulfills the teacher's actual goal, produces executable
classroom action, and keeps evidence and uncertainty honest. Generic, ungrounded,
non-actionable or unsupported-precision output fails the command and exits non-zero.
Teacher-facing tool names, schema parameters, UUIDs, internal knowledge codes,
validation codes, and technical retry narration are also hard failures.
The rubric is an executable release gate rather than an unscored note in the
result file.

## 性能发布门

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

`npm run eval:curriculum-standards` 直接调用与知识 MCP 相同的已发布课标检索 RPC，使用
`evals/curriculum-standard-cases.jsonl` 检查核心条款排名、共用课程方案召回和跨学科隔离。
结果写入 `evals/results/curriculum-standards-latest.json`。该命令需要 Supabase service role
与 BGE-M3 配置，但不调用生成模型，也不会修改教案或课标索引。
