# Native Pi runtime boundaries

`PiLessonAgentCoordinator` is the public facade used by HTTP, Worker and evaluation
callers. Its constructor and start/cancel/input/approval methods remain the integration
boundary; callers should not construct the internal collaborators independently.

| Module | Responsibility |
| --- | --- |
| `coordinator.ts` | Accept/replay commands, prepare a new turn, orchestrate its result. |
| `run-lifecycle.ts` | Own live cancellation, queued input and heartbeat resources. Both turn paths use an owned `open`/`close` scope. |
| `executor.ts` | Invoke native Pi, restore/checkpoint branch transcripts, bind provider context, compact memory and project safe events. |
| `tool-surface.ts` | Assemble stable resource-scoped teaching tools; Dashi has its own compact surface. |
| `education-policy.ts` | Shared professional judgment in the static prompt, without nested expert calls or teaching Skill reads. |
| `teaching-completion.ts` | Grounded no-change/insufficient-evidence completion, mutually exclusive with proposals. |
| `learning-tools.ts` | Adapt bounded evidence reads and scoped inquiry/review proposals to native Pi; teacher decisions remain business actions. |
| `approval-workflow.ts` | Persist proposals, apply explicit decisions, deliver through business services and request a brief continuation reply. |

## Ownership rules

- Pi owns the model/tool loop and steering/follow-up queues. Do not duplicate them.
- D1 repositories own durable leases, transaction boundaries and terminal states.
  The live scope is not an alternative source of truth or a recovery journal.
- An execution scope closes **after** durable settlement, including initialization
  failure. Cancellation waits for that close; cleanup is idempotent and owner-specific.
- Approval decision, resource delivery and reply completion remain separate facts.
  A failed reply must not repeat or undo successful delivery.
- Branch transcripts and prompt/memory policy belong to the executor. The approval
  workflow uses the same executor and lifecycle as an ordinary turn.
- Keep the public facade stable when moving internal responsibilities. Cover native
  Pi behavior with `coordinator.integration.test.ts`, live ownership with
  `run-lifecycle.test.ts`, and SQL invariants with repository transaction tests.
- `server/lesson-teaching-context.ts` composes canonical planning and feedback;
  tool adapters do not own curriculum/feedback joins or infer learning outcomes.
- `server/learning/service.ts` owns immutable observations, inquiry lifecycle,
  comparable follow-up validation and command recovery. An Agent must read the
  selected evidence before proposing; only a completed run exposes its draft.
  Model recommendations never adopt, implement or finalize teacher judgments.
