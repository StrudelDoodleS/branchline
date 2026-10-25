# Session Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved time/cost timeline at thousand-agent scale.

**Architecture:** Add a compact, opt-in timeline aggregation to the existing canonical cost-history API and VS Code transport. Replace the old canvas panel with a responsive day/cell grid and paged per-period agents. Data and UI work share the exact typed contract in the spec.

**Tech Stack:** TypeScript, React, existing cost-history hook, Node 22 tests, Playwright, pnpm. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-session-timeline-design.md`

## Global Constraints

- Four local-clock cells per date: 00–06, 06–12, 12–18, 18–24.
- At most 14 dates and 20 agent rows in a response.
- Refresh at 30 seconds while open; no requests while hidden/closed.
- No new pricing table, fabricated working hours, raw transcripts or prompts.
- Existing requests and the VS Code bridge remain compatible.

## Review Focus

- DST and six-hour boundaries must never double count a response.
- Unknown prices and missing cache-write counts must not become measured zeroes.
- Repeated names must remain distinct native agents with period-scoped totals.
- Fast session/cell/page switches must not show another period's stale totals.
- Thousand-agent sessions must use bounded DOM/data, with no timeline canvas or hidden polling.

### Task 1: canonical timeline aggregation and transport

**Files:** create `extension/src/session-timeline.ts`, `scripts/session-timeline.test.ts`; modify `extension/src/cost-history.ts`. Relay/dev/app routes already use cost history; integrate gzip via existing `scripts/http-json.ts` if needed without changing legacy payloads.

**Interfaces:** produces `TimelineOptions`, `TimelineTotals`, `TimelineCell`, `TimelineAgent`, `SessionTimeline`, `buildSessionTimeline`, `normalizeTimelineOptions`, and optional `CostHistory.timeline`, exactly as the spec defines.

- [ ] Write literal fixtures for London DST/6h, mixed known/unknown prices, repeated names, quiet/untimed/out-of-page data, 1,100-agent paging, 21-day navigation, and legacy cost-history compatibility.
- [ ] Run `node --import tsx --test scripts/session-timeline.test.ts`; observe feature-missing failures.
- [ ] Implement aggregation over canonical records, bounded page/agent output, deterministic metric sorting, compact opt-in cost history and option validation.
- [ ] Run the targeted tests, workspace suite and extension types. Expected: all green; legacy costs unchanged.
- [ ] Commit tested aggregation/transport.

### Task 2: responsive heatmap and period drill-down

**Files:** replace `web/components/agent-visualizer/timeline-panel.tsx`; modify `web/components/agent-visualizer/index.tsx` to pass session metadata, stable callbacks and mark graphics covered; create `scripts/check-session-timeline.py`; optional focused UI helper file under `web/lib/` with tests only if it derives behavior.

**Interfaces:** consumes `CostHistory.timeline` and existing `useCostHistory(sessionId, options, refreshMs)`. Props become `{visible,sessionId,sessionLabel,onClose}`. Existing hook supports abort/visibility/stale state; use response selection identity to suppress mismatched totals.

- [ ] Add browser fixture with 1,100 recorded agents, 56 cells and 20-row pages; prove old panel fails new navigation/drilldown/portrait checks.
- [ ] Implement API spend/Responses, local dates and 6h labels, calendar navigation, exact cell selection, source/agent disclosures, paging, empty/partial/error/retry states, focus/Escape, hidden/closed query cleanup.
- [ ] Remove giant canvas drawing and continuous time/entry props. Pause covered graphics and keep overlay above controls.
- [ ] Verify 320/390/1280 widths, partial pricing, duplicate IDs/names, delayed cell/session requests, page selection reset and stopped polling. Run web types and existing phone/cost/power checks. Expected: green, no overflow or timeline canvas.
- [ ] Commit UI and meaningful regression coverage.

### Task 3: review, real-session verification and deployment

**Files:** update `FORK.md`; use existing isolated build/deployment helpers adapted to the timeline build.

- [ ] Run workspace/extension/CLI suites and types; build app and extension in an isolated copy, preserving the running server.
- [ ] Have a fresh reviewer check the whole change against the spec and five Review Focus items; fix meaningful findings with reproducing regressions.
- [ ] Preview the real Explore hybrid session: full recorded usage, >1k agents, bounded cells/agent payload, totals reconcile with canonical costs, no fabricated hour values.
- [ ] Merge into `phone-controls`, push the user's fork, stop preview, deploy tested assets and restart service using existing rollback protections.
- [ ] Verify native session status/names remain correct, heatmap/phone requests work, git clean; report URL, feature and measured limitations.
