# Graph performance implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this repair inline, with one fresh whole-branch review.

**Goal:** Render and position only live graph agents, keeping historical analytics intact and reducing phone rendering work.

**Architecture:** Project canonical simulation into graph collections, batch topology updates, and run a stopped d3 layout with explicit position writes. Retain the existing canvas and interaction hooks.

**Tech Stack:** TypeScript, React, d3-force, canvas, node:test, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-graph-performance-design.md`

## Global constraints

- Preserve historical state and canonical API-price costs; no dependencies.
- Main and unfinished children are eligible; completed children cannot affect live placement, fit, drawing or hit detection.
- Rebuild topology once per consumed batch, with final lifecycle states.
- Cap phone DPR at 2 and keep grid density bounded as zoom decreases.

## Review focus

- Cold replay with many spawn seeds followed by completion seeds: no historical first-frame labels or obsolete layouts.
- A main reply finishes while its children continue: children remain shown.
- Incremental spawn, completion and reactivation: positions settle, pinning persists, no resurrection from old callbacks.
- Session switch/review while graph is open: camera/layout reset correctly and history remains complete.
- Deep/zoomed-out graphs and DPR 2.75: bounded render work, controls and touch remain usable.

### Task 1: Scope graph state and correct force placement

Files: new `web/hooks/simulation/graph-state.ts`, new `web/hooks/simulation/graph-layout.ts`; modify simulation hook/agent lifecycle handlers and canvas; add `scripts/graph-performance.test.ts` and lifecycle tests.

- [ ] Write failing tests for invisible draw work, completed sibling placement, final visible topology, manual layout movement, stable pinned survivors, and history preservation.
- [ ] Reproduce failures against current implementation.
- [ ] Implement projection and stopped force controller; replace per-event layout timers with one dirty flag consumed after each event batch. Cold layouts use final eligible nodes. Reset on session replacement/seek.
- [ ] Run new tests and full root suite; commit.

### Task 2: Bound phone drawing and verify the real screen

Files: canvas, background grid, `scripts/check-phone-graph.py`, `FORK.md`.

- [ ] Add failing browser checks for many finished agents in a cold replay, graph-first replay, state reactivation, cost preservation, mobile pixel count and zoom-out grid work.
- [ ] Cull invisible drawing and cap phone DPR; use screen-size grid spacing at low zoom.
- [ ] Run existing graph/touch, phone controls, timeline and analytics power suites plus type/build checks. Compare native large-session work counts and inspect screenshots.
- [ ] Request one fresh review; repair demonstrated issues. Commit, push and deploy the tested build, then verify service and native sessions.
