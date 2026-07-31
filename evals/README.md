# LessonUp Agent evaluations

`npm run eval:agent` exercises the running LessonUp API through the real
`LessonAgentHarness`, model provider, Agents SDK loop, Function Tools and MCP
configuration. It is intentionally separate from the deterministic Playwright
harness, which remains responsible for UI and database contracts.

Required environment:

- `LESSONUP_EVAL_ACCESS_TOKEN`
- `LESSONUP_EVAL_NOTEBOOK_ID`
- `LESSONUP_EVAL_LESSON_FILE_ID`
- `DEEPSEEK_API_KEY`

Optional:

- `LESSONUP_EVAL_BASE_URL` (defaults to `http://127.0.0.1:8787`)
- `DEEPSEEK_BASE_URL` (defaults to `https://api.deepseek.com`)
- `DEEPSEEK_PRO_MODEL` (defaults to `deepseek-v4-pro`)
- `LESSONUP_EVAL_GRADER_API_KEY`, `LESSONUP_EVAL_GRADER_BASE_URL` and
  `LESSONUP_EVAL_GRADER_MODEL` only when the grader must use a separate
  credential, endpoint, or model. Otherwise the evaluation runner reuses the
  existing DeepSeek configuration.

The runner creates one isolated thread per case, records normalized observable
events, rejects any generated approval so an evaluation never writes the lesson
document, soft-deletes the temporary thread, and writes
`evals/results/latest.json`.

Automated gates cover required and forbidden tools, approval boundaries,
sources and terminal failures. Every case is also graded by a separately configured
model against the canonical lesson document and its `rubric`; generic, ungrounded,
or unsupported-precision output fails the command and exits non-zero.
The rubric is an executable release gate rather than an unscored note in the
result file.
