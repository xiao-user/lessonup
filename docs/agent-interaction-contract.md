# LessonUp Agent interaction contract

## Scope

The assistant always works within the current whole lesson plan. The section in
view is a focus hint, and an exact text selection is a narrower hint. Neither
changes the authorization boundary or replaces whole-document context.

## Routing lanes

Routing is deterministic and never calls a model. Acknowledgements and follow-ups
that point back at the conversation itself ("why?", "what did you mean by that?")
take the Fast lane: one model call, no tools, no lesson content. A question about
the lesson, or about facts that need a source, always takes the Agent lane, which
can read the document and retrieve evidence. When in doubt the router chooses the
Agent lane, because a wrong Fast answer is incorrect while a wrong Agent answer is
only slower. A request for a courseware ("课件", PPT, slides) is a presentation
request, whichever of those words the teacher uses.

## Retrieval

Knowledge and curriculum-standard search embed the query when an embedding
service is configured. Standards use vector-plus-text ranking only when every
candidate in the scoped release has a compatible vector; a partly embedded
release uses one text-only scale so unembedded, relevant passages are not buried.
A missing or failing service also degrades to text ranking; it never fails the
tool, and a result ranked without the query vector it should have had is not
cached. Text ranking must work for Chinese that has no spaces between words.

A turn that requires evidence cannot be answered from memory: the run must have
retrieved. What counts differs by outcome. A consultation whose search found
nothing still completes, because the honest answer is that no source was found;
failing it would punish the reply we want. A proposal to change the lesson needs
stored evidence from the run, and a search that came back empty does not back it.

## Diagnostics

The browser only receives a public error code. The real cause of a failed run is
logged server-side as a structured `Agent failure` entry: opaque ids, the code and
the error with its cause chain, never the teacher's message or model output.

## Read strategy

- Use `read_section` once when one specific section is sufficient.
- Use `read_document` once with `fields` when comparing two or three sections.
- Use `read_document` once without `fields` for a broad review, completeness
  check, or any task requiring four or more sections.
- Use `read_document_outline` only when structure and content presence are
  sufficient.

The single native Pi Agent owns investigation and the final answer. Shared
teaching judgment is present in its static policy; only Dashi remains a separate
Skill. There are no nested specialist model calls. Ordinary teaching tools stay
stable for the resource, including curriculum, knowledge and teaching context;
language routing restricts writes and requires evidence without hiding reads.

`read_lesson_design_basis` includes the bound unit, current blueprint, nearby
lessons and real classroom feedback. `read_lesson_class_feedback` returns the
feedback view alone. Reads cover the current lesson and the nearest three
earlier, non-cancelled blueprints in the same unit, with at most eight newest
records per lesson and explicit truncation. No feedback is not proof of mastery.
The same projection includes up to three finalized learning reviews per lesson,
with original baseline, follow-up, intervention, alternative explanation and
limitations. It reads the canonical records instead of duplicating feedback.

## Structured teaching actions and completion

Product actions pass `taskIntent` (`analysis`, `document_write`,
`learning_inquiry`, `learning_review`). The server binds selected evidence,
inquiry, version and write scope; natural-language routing remains a fallback
for ordinary conversation. Learning actions cannot change the lesson document.

`complete_without_change` requires a successful canonical content read and
records either a justified preservation or an evidence gap. It cannot coexist
with a proposal. It completes without an approval or write; external-retrieval
gates for new lesson claims do not force a search merely to preserve existing
content. It must not assert unobserved external facts.

Learning tools must successfully read the selected evidence before saving an
inquiry or review recommendation. These proposals use actual learning evidence
rather than satisfying a language-derived external-search requirement. They
remain hidden until the proposing run completes; cancellation and failed runs
do not produce adoptable drafts. Teacher actions separately record adoption,
implementation and final review, with CAS and idempotency. Agent review cannot
mark a hypothesis verified or create classroom observations.

`read_learning_progress` provides indexed cursor pagination and an exact
server-bound selection even outside the latest window. Follow-up evidence is
immutable, belongs to an implemented inquiry and cannot precede implementation.
An incomparable objective, criterion or group requires an inconclusive review.
Review retains limitations; its follow-up can seed another inquiry without
claiming causality. Network uncertainty is resolved through the original
command receipt or the same command, never a new automatic write.

## Event projection

The server converts SDK run events into a small safe event model: run phase,
text delta, semantic tool label, source, approval, completion, cancellation and
failure. Raw provider events, reasoning, tool arguments and private tool output
never reach the browser.

Every safe public tool call keeps its original call identity, semantic label,
turn, progress, and terminal outcome. The browser may group calls by their Pi
turn, but must not deduplicate or collapse them into a synthetic activity.

## Presentation

The entire agent conversation surface uses local Beautiful UI components:
streamed response text, Tool Chips, Approval Card, sources, attachments and
Prompt Bar. It consumes the safe normalized projection of Pi's actual
Agent/Turn/Assistant/Tool lifecycle rather than a second phase state machine.
General controls remain shadcn/Base Nova.

The UI does not display provider reasoning or fabricate a “thinking” trace.
It can state that an Agent, turn, assistant message, or tool call is active
only when the matching normalized lifecycle event has been observed.

Each Turn has two presentation modes derived from that same event stream:

- While running, show live elapsed time, any safe assistant text already
  emitted, the ordered public tool activity, and a current focus only when it
  can be derived from an active public tool or approval interruption. The
  result is still unknown.
- Once completed, failed, or cancelled, freeze elapsed time and clear every
  active focus indicator. Keep the activity trace available in collapsed form,
  present the durable assistant text as the result summary, then show owned
  artifacts and available actions. Empty artifacts are omitted.

`visible_thinking` is not an alias for provider reasoning. It may contain only
safe assistant-authored text or a server-projected public activity summary; if
neither exists, it remains empty and the native loading state is shown.

A response to a visible human-in-the-loop interaction is never routed through
Pi's `steer` or `follow_up` queue. It consumes that durable pending interaction
and starts its defined continuation/new Turn. The queue is reserved for an
ordinary user message added while a Turn is already executing.
