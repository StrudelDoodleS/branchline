# Session timeline: time and cost

User approved the three interactive concepts and was viewing **Time & cost**. Implement that concept first. Reference: `/home/max/.codex/visualizations/2026/10/18/01a14db0-67a9-7253-89c5-72f605291145/branchline-timeline-moodboard.html`.

## Intent and approach

Replace the giant, continuously redrawn per-agent canvas with a compact, phone-friendly heatmap. Explore hybrid tabular predictors has 1,073 cost-bearing agents. One row per agent and ten-second ticks across days are unusable at that scale.

Three approaches were shown: activity overview (waves of concurrency), expandable branch lanes (ancestry), and time/cost heatmap (hotspots). The selected heatmap is the current scope. Agent working hours are absent from canonical historical cost records, so the second measure is **recorded responses**. This choice was stated in commentary; never invent working-time measurements.

## Behavior

- Four local-clock cells per date: 00–06, 06–12, 12–18, 18–24. Use the browser's IANA timezone. DST folds and gaps allocate every response once by its real timestamp.
- Show at most 14 dates, including quiet dates, with Older/Newer/Latest navigation. Initial page and selection use the most recent recorded usage. Local day labels, not UTC labels, determine navigation.
- Switch between **API spend** and **Responses**. Show values and a shared intensity scale. A tap selects a period, its source breakdown and its contributing agents. Twenty agent rows per page, distinct native IDs even when names match. Rows may use native details disclosures for source dollars.
- Agent totals belong to the selected period, never lifetime totals. Show the selected period's date, time, response count, distinct cost-bearing agents, priced dollars and unknown-price count. Unknown prices remain unknown; unknown OpenAI cache writes remain explicitly unknown. Preserve untimed usage separately, outside the calendar.
- Dollar figures reuse canonical `CostRecord` pricing and deduplication. No new pricing table. Full tracked histories and saved-session fallback use the existing cost-history transport, including the VS Code bridge.
- No canvas, animation loop or full agent roster in the browser. At most 56 calendar cells and 20 agent rows in a response. No transcript, prompts or tool payloads are sent.
- Fetch only while open and page-visible, using the existing abortable cost-history hook. Refresh at 30 seconds while open; retain identical-response references. Taps keep the grid visible while loading, but hide mismatched old period totals. Session changes clear selection. Closing stops requests and restores focus. Covered graph rendering pauses.
- Phone panel: opaque, readable text, native 44px touch targets, no horizontal page overflow, close and Escape support. Desktop panel remains bounded. Existing tree, graph and other cost views continue to work.

## Shared contract

New module `extension/src/session-timeline.ts` exports:

```ts
interface TimelineOptions {
  timeline?: boolean; timezone?: string; timelineBefore?: string;
  timelineDay?: string; timelineSlot?: number; timelineOffset?: number;
  timelineMetric?: 'cost' | 'responses';
}
interface TimelineTotals {
  records: number; agentCount: number; knownCostUSD: number; costUSD: number | null;
  unpricedResponses: number; cacheWritesUnknown: boolean; breakdownUSD: CostBreakdown;
}
interface TimelineCell extends TimelineTotals { day: string; slot: number }
interface TimelineAgent extends TimelineTotals { agentId: string | null; agentName: string }
interface SessionTimeline {
  timezone: string; metric: 'cost' | 'responses'; firstDay: string | null; lastDay: string | null;
  window: { firstDay: string | null; lastDay: string | null; olderBefore: string | null; newerBefore: string | null };
  days: Array<{ day: string; cells: TimelineCell[] }>;
  totals: TimelineTotals;
  allTime: TimelineTotals & { untimedResponses: number; untimedKnownCostUSD: number };
  selected: null | { cell: TimelineCell; agents: TimelineAgent[]; offset: number; hasMore: boolean };
}
```

`CostHistoryOptions extends TimelineOptions`; `CostHistory.timeline?: SessionTimeline`. When `timeline=true`, `buildCostHistory` returns a compact response: empty legacy points/burnRate, no groups/cacheReuse, timeline populated. Existing requests are unchanged. Options are flat URL/VS Code serializable. Date options are strict ISO dates; slots are integers 0–3, offset nonnegative/capped, invalid timezone falls back to UTC. Unknown session IDs still follow the existing 404 path.

`buildSessionTimeline(source: Iterable<CostRecord>, query: TimelineOptions = {}): SessionTimeline` and `normalizeTimelineOptions(raw: Record<string, unknown>): TimelineOptions` implement the pure aggregation. Selected agents sort by chosen metric descending, deterministic ID ties. Untimed cost affects all-time totals but never fabricates a cell. No agent-hour field.

## Validation and remaining builder choices

Check half-open local six-hour boundaries; London DST on 2026-10-25; mixed/unknown models; duplicate names with different IDs; untimed usage; 1,100 agents; empty and quiet periods; more than 14 days; out-of-page selections; stale/aborted requests; hidden/closed polling; keyboard focus and 320px layout. Root owns integration and deployment. Agent-row styling and disclosure layout are implementation choices, using the existing app palette.
