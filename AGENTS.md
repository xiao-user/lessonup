# LessonUp Prototype Instructions

## Working rules

- Run the local server and open the available browser preview yourself when validating changes.
- Before substantial visual changes, use Product Design `get-context` when the visual source is unclear. Treat an explicitly selected mock as the visual source of truth.
- Record only durable product decisions here; keep temporary implementation plans and issue lists elsewhere.
- Keep reusable shadcn primitives in `src/components/ui`, notebook features in `src/features/notebooks`, lesson workspace features in `src/features/lesson-files`, shared helpers in `src/lib`, design tokens in `src/styles/design-system.css`, and runtime media in `public/assets`.
- Do not retain builds, caches, browser logs, or transient QA captures in the project tree.

## Visual system and collection

- Treat `/Users/liuxiao/Desktop/vibe-coding/Writing/design.md/design.md` and `/Users/liuxiao/Desktop/vibe-coding/Writing/design.md/design.dark.md` as the light and dark theme sources of truth.
- Use Geist Sans for interface and prose, Geist Mono for metadata, the Geist 4px spacing scale, named typography tokens, semantic color aliases, documented radii, focus, elevation, and 150/200/300ms motion tiers.
- Use shadcn/ui Base Nova and Lucide for general controls and feedback. Keep folder artwork, paper materials, and GSAP spatial transitions purpose-built.
- Keep the application and collection as a fixed-height, clipped viewport stage. Vertical wheel/touch input controls the horizontal collection track and must not fall through to document scrolling.
- Resting folders remain full size. Hover changes only cover/paper transforms; it must not change layout width or material. Opening and closing follow one reversible spatial path without a visible intermediate hover phase or vertical folder movement.
- Focused papers remain interactive. The back button, folder cover, and document-level outside hit testing return to the collection; do not use a full-page dismissal overlay.
- Keep the focused folder/paper composition centered when it fits and left-clamped when it does not. Preserve compact mobile gaps and trailing collection padding.
- Keep the collection background free of video or gradient overlays. Use “备好课” as the collection `h3` with no subtitle.
- Preserve LessonUp's own collection shell, background, and single action header. Reuse only the center book scene from `/Users/liuxiao/Downloads/Kimi_Agent_Deployment_ed07f5c/index.html` as an isolated, data-driven `BookCarousel`: stacked books, side metadata, floating title index, scroll indicator, wheel/touch/keyboard switching, cover/page shading, and reversible GSAP choreography. The active book cover itself is the open control; do not render a separate central open button. The carousel must not own page chrome or duplicate create actions. Covers show only notebook title and file count; pages use paper rather than lesson-file images and retain previous/next controls plus the detail-view transition origin. During close, keep the page block and cover back rendered until the moving cover conceals them naturally, then clear selection state.
- Treat the carousel's active notebook as the target of collection-level file creation. Creation dialogs must serialize their mutation, expose a truthful submitting state, and prevent duplicate submission while the request is pending.

## Lesson-file workspace

- Use one left/center/right workspace: lightweight section anchors, one editable A4 lesson-plan document, and one unified contextual assistant. Collapse side rails into drawers on narrow screens.
- The center document is the only strong visual object. Keep side rails free of enclosing cards, elevation, decorative headers, and dense chrome.
- Model every page as `210mm × 297mm` with `20mm` vertical and `16mm` horizontal insets, yielding a `178mm × 257mm` content box.
- Render the lesson plan as one semantic, editable table across consecutive pages. Rows are content-driven; never shrink, clip, overlap, or assign section-specific heights.
- Derive pagination from a hidden real table with the same geometry and typography as the visible document. Rebuild pages greedily from the canonical document so growth pushes forward and deletion pulls content back.
- Preserve leading/trailing blank lines. Use auto-sizing plain-text textareas with browser-owned caret state; coalesce measurement during typing and flush on blur or composition end.
- Keep undo/redo above pagination as complete lesson-plan transactions. Merge nearby typing, keep paste separate, clear redo after new edits, and route restored plans through normal pagination and persistence.
- Keep document scrolling inside the center workspace. Derive the active anchor from that one scroll container and hold the clicked anchor during navigation.
- Knowledge uploads are asynchronous: enqueue private objects, claim jobs with `SKIP LOCKED`, preserve stable chunks, batch BGE-M3 embeddings, and publish only after all chunks commit.

## Agent architecture and security

- Supabase is canonical for notebooks, lesson files, documents, threads, branches, runs, approvals, and knowledge metadata. Browser state may hold transient UI state and unsent drafts only.
- Use Supabase password authentication. Seed `admin` / `1234` only against loopback Supabase; never accept it in shared or production environments.
- Keep model and service credentials on the Hono server. The browser receives only the Supabase anonymous key and the signed-in access token.
- Revalidate the complete isolation chain `auth.user → notebook → lesson_file → agent_thread → agent_branch → run`; treat every client-provided ID as untrusted.
- Use `@openai/agents` for the Agent loop, persistent Session, HITL RunState, MCP clients, and tracing. DeepSeek is a custom provider limited to `deepseek-v4-pro` over Chat Completions and `deepseek-v4-flash` over Responses API. DeepSeek Responses remains stateless, so LessonUp's isolated Session stays canonical.
- Use one visible `LessonPreparationManager`; curriculum, learning design, assessment, and critique agents are internal tools. Use Pro for visible/complex work and Flash for bounded routing, titles, memory compression, and lightweight critique.
- Deterministic document access is a Function Tool, knowledge retrieval is Streamable HTTP MCP with five-minute server-signed scope tokens, and teaching methods are versioned platform Skills.
- Never inject another lesson file or a private library by default. Inject verified IDs, document version, active-section and selection hints; let the Agent read canonical document fields and sources on demand.
- Web retrieval must reject private networks, file URLs, and unsafe redirects. Never expose reasoning, provider-native events, raw tool JSON, prompts, credentials, or private source bodies to the browser.

## Agent state, editing, and evidence

- Give each `thread + branch` an isolated Session. Branches inherit exactly the protocol-safe history through the fork message; the parent remains unchanged.
- Keep raw messages durable. Compact only older context into a validated, versioned, untrusted structured summary while retaining recent turns and complete tool call/result groups.
- Persist run, user message, and assistant placeholder before routing or MCP startup. A disconnect or refresh observes the same server-owned run and must not resend the user message.
- Enclose run and MCP initialization in cleanup-safe control flow. Repair Session protocol units before runs and after cancellation or failure.
- Explicit stop is terminal and persists as `cancelled`; only an intentional retry starts a new run.
- Preserve text produced before failure as a durable, visibly failed, untrusted draft. A later continuation reuses same-version complete tool results and analysis, and repeats only stale, incomplete, or current-run evidence reads.
- Flush and await pending document edits before start, retry, approve, or reject. Hydrate the editor from the canonical server document and require new runs to match its visible version.
- Keep `propose_document_patch` available by default but always approval-gated. Consultation does not imply a write.
- Run typed, scope, snapshot, evidence and target validation as an Agents SDK tool input guardrail before any write approval interruption. Return recoverable proposal errors to the Agent for an in-run correction; only a proposal that passes preflight may create a user confirmation item.
- Let the Agent propose any semantically valid change inside the current business resource when it completes the teacher's goal; keep scope, typed fields, CAS, evidence, and approval as the boundary instead of fixed content templates.
- Use direct `propose_document_patch` as the default and only path for ordinary lesson writing, full rewrites, knowledge-informed content, teaching rationale, student difficulties, and assessment evidence. Structured design basis is optional reuse metadata, never a prerequisite for writing teacher-readable content into the A4 lesson plan.
- Expose design-basis write tools only when the teacher explicitly asks to save, correct, delete, or project structured design-basis records. If that request also changes A4, use one atomic approval; never create consecutive approvals for internal modeling.
- Treat design basis as a reusable evidence and decision layer, not as an A4 content restriction. Put teacher-readable knowledge points, review, preparation, difficulties, and assessment evidence into whichever instructional fields serve classroom execution; keep only IDs, relation metadata, confidence, and provenance machinery out of the prose.
- Bind design-basis-to-A4 operations to canonical full-field snapshots on the server. The approval card is the single teacher confirmation; do not require the model to echo source text or ask for a preliminary textual confirmation.
- Treat the global document version as snapshot chronology and the final write CAS, not as a blanket conflict boundary. Rebase approval operations onto the latest canonical document only when server-bound target text and context still identify the same non-overlapping ranges; preserve unrelated teacher edits and reject changed or ambiguous targets as real conflicts.
- Make approval decision, document transaction, RunState continuation, and run/thread settlement recoverable and idempotent. The server-returned lesson-file snapshot is the only post-approval canonical state.
- Persist pending approvals across refresh with encrypted RunState and pinned Agent/Skill versions. Keep each approval and resolved outcome attached to its proposing assistant response.
- Bind attachments to the user message and run. Require direct `read_attached_source` evidence before citing, summarizing, comparing, or judging an attachment; broad search is not equivalent.
- Bind factual patch citations to sources actually observed in the current run. Show sources only on the response that owns them.
- Keep the SmartEdu-derived national textbook catalog as platform data (`curriculum_textbooks` / `curriculum_nodes`, seeded from `data/curriculum`). Expose it through authenticated curriculum APIs for create/context selectors and through on-demand Function Tools (`lookup_curriculum_textbooks`, `read_curriculum_outline`); never inject full catalogs into prompts, and never treat directory trees as textbook body text.
- Bind notebook `subject` to catalog subjects. Bind lesson-file teaching context to an optional `textbookId` / `unitNodeId` (with denormalized `gradeLevel` + `textbookEdition` labels) so Agent tools and UI selectors share one curriculum source.

## Agent experience and verification

- Use the local Craft Agents adapter as the single conversation presentation chain for turns, task activity, Markdown, sources, approvals, attachments, and composer. Use shadcn/Base Nova for ordinary controls.
- Render only normalized real events. Never fake progress or expose chain-of-thought, raw parameters, or private tool output.
- Keep the assistant rail visually lightweight and flush to its edges, with gutters inside header/content/composer. Use the system scrollbar and let responses grow without nested scrollers or shadows.
- Keep title/history/new-thread/actions compact in the assistant header. Preserve thread selection when document versions update.
- Keep composer uploads local until indexing succeeds; block send while uploads are unresolved, snapshot ready files into the sent message, and never restore unsent attachments from project knowledge.
- Create empty threads immediately and generate version-pinned starter suggestions asynchronously. Show truthful loading, unavailable, and retry states; never substitute canned model replies.
- Keep active pending approval controls reachable near the composer and present field-named summaries by default, with an explicit full-diff expansion.
- Verify Agent changes with real Agents SDK integration tests for model/tool protocol, Session, MCP, RunState, approvals, cancellation, and branching. Use the deterministic browser harness for UI/database contracts, not as proof of the real Agent path.
