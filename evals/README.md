# LessonUp Agent evaluations

`npm run eval:agent` exercises the running LessonUp API through the real
`LessonAgentHarness`, model provider, Agents SDK loop, Function Tools and MCP
configuration. It is intentionally separate from the deterministic Playwright
harness, which remains responsible for UI and database contracts.

Required environment:

- `LESSONUP_EVAL_ACCESS_TOKEN`
- `LESSONUP_EVAL_NOTEBOOK_ID`
- `LESSONUP_EVAL_LESSON_FILE_ID`

Optional:

- `LESSONUP_EVAL_BASE_URL` (defaults to `http://127.0.0.1:8787`)

The runner creates one isolated thread per case, records normalized observable
events, rejects any generated approval so an evaluation never writes the lesson
document, soft-deletes the temporary thread, and writes
`evals/results/latest.json`.

Automated gates cover required and forbidden tools, approval boundaries,
sources and terminal failures. The `manualRubric` fields are deliberately not
self-graded by the Agent; a teacher or calibrated external grader must assess
teaching quality, evidence fidelity, minimality and preservation of intent.
