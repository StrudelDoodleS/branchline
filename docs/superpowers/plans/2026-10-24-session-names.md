# Saved session names

> **For agentic workers:** Use superpowers:executing-plans to carry out this bounded change in the existing fork. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the parent session's actual saved name in the chooser and selected-session header for Codex and Claude.

**Architecture:** Resolve names at the existing watcher/catalog boundaries so every consumer receives the same label. Read Codex's `session_index.jsonl`, Claude's `custom-title.json` sidecars, and Claude `custom-title`/`ai-title` transcript records. Manual Claude names take precedence over generated names; prompts remain the fallback.

**Tech Stack:** Existing TypeScript, Node filesystem APIs, node:test, esbuild. No new dependencies.

**Spec:** User request: “when selecting a parent session … It should be the session name … from codex and Claude”.

## Constraints and review focus

- Preserve canonical parent/child identities, active status, activity times and costs.
- Read only metadata for name refresh; cache unchanged files and use existing checks.
- Do not let a child's title rename its parent.
- Ignore invalid/empty titles and incomplete index appends.
- Preserve explicit names on review classification and names beginning with `Codex `.

## Implementation and verification

- [x] Reproduce prompt labels with regression tests against real temporary session files.
- [x] Add `extension/src/session-titles.ts` for cached metadata reads and Claude title precedence.
- [x] Apply names in `transcript-parser.ts`, both Claude watcher paths, `codex-session-watcher.ts` and `session-catalog.ts`.
- [x] Confirm the regression tests pass, including renames without new activity.
- [ ] Run workspace/extension tests, TypeScript checks and live transport coverage.
- [ ] Review the complete change, build in an isolated copy, and verify real saved names.
- [ ] Commit and push the fork; deploy the verified build, restart, and verify production.
