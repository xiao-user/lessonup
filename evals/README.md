# LessonUp Agent evaluations

`npm run eval:agent` exercises the running LessonUp API through the real
`LessonAgentHarness`, model provider, Agents SDK loop, Function Tools and MCP
configuration. It is intentionally separate from the deterministic Playwright
harness, which remains responsible for UI and database contracts.

Required environment:

- `LESSONUP_EVAL_ACCESS_TOKEN`
- `LESSONUP_EVAL_NOTEBOOK_ID`
- `LESSONUP_EVAL_LESSON_FILE_ID`
- `LESSONUP_EVAL_SEMESTER_FRAMEWORK_ID`（运行学期框架案例时必需）
- `DEEPSEEK_API_KEY`

Optional:

- `LESSONUP_EVAL_BASE_URL` (defaults to `http://127.0.0.1:8787`)
- `DEEPSEEK_BASE_URL` (defaults to `https://api.deepseek.com`)
- `DEEPSEEK_FLASH_MODEL` (defaults to `deepseek-v4-flash`)
- `LESSONUP_EVAL_GRADER_API_KEY`, `LESSONUP_EVAL_GRADER_BASE_URL` and
  `LESSONUP_EVAL_GRADER_MODEL` only when the grader must use a separate
  credential, endpoint, or model. Otherwise the evaluation runner reuses the
  existing DeepSeek configuration.

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
