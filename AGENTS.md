# LessonUp — Agent guide

React/Vite frontend with Hono on Cloudflare Workers, native Pi Agent, D1 and R2. See [README.md](README.md) for setup, configuration, architecture and deployment.

## Commands and verification

- Use Node.js `>=24.19.0 <25` and npm. Install with `npm ci`.
- Follow README's local configuration and database setup, then run `npm run dev` (Vite + Worker). `dev:api` is a legacy Node entry, not the default.
- For code changes, run `npm run typecheck`, affected tests (`npm test -- <test-file>`) and `npm run build`. Also run `npm run typecheck:cloudflare` for Worker/server changes.
- Agent changes need native Pi integration coverage; deterministic browser tests do not prove real model/tool behavior. Editor changes also need `npm run test:legacy`.
- For UI changes, run the local server and inspect the browser preview. Use `npm run test:e2e:agent` for affected interaction contracts.
- Documentation-only changes need command/link and diff checks, not application builds. Report checks run and any unverified behavior.

## Code placement

- UI features: `src/features/`; reusable controls: `src/components/ui/`; tokens: `src/styles/design-system.css`.
- Pi execution: `server/agent-runtime/pi/`; conversation rules: `server/conversation/`.
- Business services depend on application ports; SQL and Cloudflare bindings belong in `server/repositories/`, `server/platform/` and `cloudflare/`.
- Dashi Web adaptation: `src/lib/dashi-browser/`, `server/presentations/` and preparation scripts; generated assets: `public/dashi/`.

## Project constraints

- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining
- D1 is canonical and R2 stores private objects. Validate user → resource → thread → branch → run ownership. Keep credentials, private reasoning and raw provider/tool data off the client.
- Keep one native Pi coordinator and one configured model; do not add another harness or canned Fast replies. Isolate branch Sessions; reconnect must not resend and cancellation is terminal.
- Preserve raw history and the cacheable static prompt prefix. Compact older context in the background without splitting tool/result groups; wait only when context cannot fit.
- Flush editor changes before Agent actions. Preflight proposals before approval; apply canonical snapshots with version checks and idempotent writes, preserving unrelated edits.
- Keep approval decision, delivery, continuation and synchronization separate. Network/reply failures cannot undo successful delivery; synchronize uncertain outcomes instead of repeating writes. Keep outcomes on the proposing turn.
- Keep one vendored Dashi Skill at `server/agent/skills/dashi-ppt`. Preserve upstream generation, preview, editor, exports and licenses; place Web adaptations outside the baseline. Store generated content separately from shared runtimes. Rebuild assets with `npm run dashi:prepare`, never edit generated files.
- Deploy only when requested, using `npm run cloudflare:deploy`; preserve production configuration. Remote migrations and account provisioning are separate operations.
- Keep transient QA artifacts outside the repository. Do not add implementation logs or temporary issue lists to this file.
