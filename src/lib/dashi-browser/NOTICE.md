# Notice

This Browser Skill is an adaptation layer designed to interoperate with Dashi PPT visual theme runtime files.

Dashi PPT upstream repository:
https://github.com/chuspeeism/dashi-ppt-skill

The upstream repository states that its main project is licensed under GNU AGPL-3.0 and that `project/packages/html-deck-to-pptx` is separately licensed. The complete original exporter is retained in the vendored Skill; its unmodified browser bundle and runtime dependencies are included in the shared `/dashi/` assets. There is no independent LessonUp PPTX exporter. The separate license is preserved as `DASHI-EXPORT-ENGINE-LICENSE.txt` in those assets.

Run `npm run dashi:prepare` to prepare the shared assets. Review upstream licensing and your distribution/network-use obligations before production deployment.

The vendored Skill remains an unmodified upstream baseline. Shared theme bundles receive one explicit build-time compatibility patch, `deck-owned-runtime-release-v1`: the inactive-slide release selector is scoped to direct children of `#deck`, excluding thumbnail clones. Dashi 0.4.5 ignored roots without React ownership; 0.4.11 clears them, including DOM-only thumbnails. The patch does not disable genuine slide unloading, change thumbnail generation, or modify the editor/export engine. Upstream selector changes fail the build for review instead of silently skipping the patch.
