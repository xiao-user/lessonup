# LessonUp Agent interaction contract

## Scope

The assistant always works within the current whole lesson plan. The section in
view is a focus hint, and an exact text selection is a narrower hint. Neither
changes the authorization boundary or replaces whole-document context.

## Read strategy

- Use `read_section` once when one specific section is sufficient.
- Use `read_document` once with `fields` when comparing two or three sections.
- Use `read_document` once without `fields` for a broad review, completeness
  check, or any task requiring four or more sections.
- Use `read_document_outline` only when structure and content presence are
  sufficient.

The manager owns the final user-visible answer. Specialist agents remain tools;
their internal output is not a separate conversation.

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
