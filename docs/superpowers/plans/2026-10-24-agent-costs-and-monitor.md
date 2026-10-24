# Per-agent costs and Branchline monitor

**Goal:** Inspect costs at the subagent level and give Codex/Claude small, reusable functions for the information Branchline already has.

**Approach:** Extend the existing cost grouping with native agent identity. Reuse the current source prices, chart filters and comparison requests. Add a portable skill with a standard-library JSON client; keep private history in the local service and direct confirmed gaps to `StrudelDoodleS/branchline`.

**Constraints:** No new daemon or dependencies. Main agents and children contribute only their own charges. Preserve unpriced/untimed usage and unknown write telemetry. Keep default output compact, names current, and source scopes explicit.

- [x] Reproduce missing agent grouping and verify literal source totals, equal-name identities, model changes, filtered spend/burn/comparisons and missing data.
- [x] Add expandable agent costs, graph selection, pagination/search and duplicate-name disambiguation; use existing checks and only the visible chart.
- [x] Add the shared skill and JSON client with fixture tests, source-aware session merging, group/session validation and optional detailed output.
- [x] Review cost and skill changes independently; verify fixes with regression tests.
- [ ] Verify the complete suites and built phone/desktop views, install the skill for both clients, and commit/deploy the tested build with rollback.
