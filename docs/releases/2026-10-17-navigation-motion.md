# Navigation motion — 2026-10-17

## Behavior

- Opening a notebook lands directly on the first file. The title page remains reachable with Previous. Book opening takes 360 ms, closing 300 ms, and individual page turns at most 280 ms; reduced-motion skips the motion. Stagger duration is bounded independently of collection size.
- Render preview content only for the current and neighboring leaves, preserving the book's physical layers and forward/back navigation.
- Preload the detail module on file hover or keyboard focus, after book motion settles. Fetch the canonical document when entering the detail; show loading and allow cancellation. Discard late responses after cancellation or navigation changes.
- Replace the detail's fixed-position paper morph, per-page stagger, shadow/background animations and scroll-to-top exit with a 160 ms opacity entry and direct return. Document geometry stays stable.
- Before returning, flush edits and await pending saves. A failed save keeps the editor and restores the detail route so the teacher can retry. Successful return restores focus to the file.

## Validation

Typecheck, production build, 7 carousel unit tests, 29 legacy editor tests and all 36 browser interaction tests passed. After the final navigation refinements, the 9 affected browser cases passed again. Browser tests use a local production build and isolated test data. They cover responsive sidebars, document editing/approval, learning workflows, real page turns, deep-link reload, cancelled loading, late responses, save failures and retry.

The previous source-text test requiring a paper morph was removed with that implementation. Navigation and save behavior are verified in browser tests instead.

With animations enabled and 4× CPU throttling: previous-release baseline versus the median of three final-build runs:

| Operation | Previous release | Updated build |
| --- | ---: | ---: |
| Open notebook | 923 ms | 439 ms |
| Enter detail | 1,726 ms | 876 ms |
| Return from scrolled detail | 1,347 ms | 63 ms |
| Close notebook | 1,345 ms | 352 ms |

These are test-scenario timings including browser automation/assertion overhead, not field INP or a guarantee across devices. The final three runs had detail frame gaps of 165–192 ms and total blocking time of 108–126 ms (an earlier final-build run reached 224 ms / 154 ms). Notebook opening had no >50 ms long tasks in the final three runs; frame gaps were still 74–84 ms. Editor initialization remains a separate optimization opportunity. Opening the document does not imply that the Agent connection has completed.

Authenticated production Computer Use remains unverified: the tool reports `Local browser use is disabled in Work settings`. Automated local browser checks and inspected screenshots do not substitute for authenticated production acceptance.

## Release and rollback

- Release tag: `v2026.10.17-navigation-motion`.
- Previous Git commit: `95048bcdcd6d4d973ac332d7d7adcf449c0a993e`.
- Rollback Git tag: `rollback/2026-10-17-before-navigation-motion`.
- Previous production Worker version: `c1320f9d-6c6d-408d-9267-d40d233f9cc5`.
- No database migrations or production configuration changes. Deploy using `npm run cloudflare:deploy`, which retains runtime variables with `--keep-vars`.

Restore the previous Worker version if needed:

```bash
npx wrangler rollback c1320f9d-6c6d-408d-9267-d40d233f9cc5 --config wrangler.jsonc --message "Rollback navigation motion release"
```

For a persistent source rollback, revert the commit identified by the release tag, push the revert, then run the deployment command. Do not reset published Git history or restore the database for this frontend-only release.
