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

Single-section reads include the real section name. Legacy repeated reads are
deduplicated; four or more distinct section reads render as one truthful
whole-document activity.

## Presentation

The entire agent conversation surface uses the local Craft Agents adapter:
turns, execution activity, Markdown, sources, approvals, attachments and
composer. It consumes only normalized LessonUp events. General controls remain
shadcn/Base Nova.

“思考中” describes a run phase only. It never represents or reveals the
provider's chain of thought.
