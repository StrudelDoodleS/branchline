# Branchline fork notes

Branchline is maintained by StrudelDoodleS and derives from Agent Flow by Simon Patole, under Apache 2.0. It is independent of the upstream maintainers.

## Base and branches

- Upstream: https://github.com/patoles/agent-flow
- Base: v0.9.2, commit `1d821aff72547f07b2836f62c28ef4bcfee9eef2`
- Fork: https://github.com/StrudelDoodleS/branchline
- Default branch: `phone-controls`

## Changes carried by this fork

- Main-session selection and a file tree for agents and nested subagents, with remembered Active/Done/All status filters.
- Portrait layouts, stronger control contrast, keyboard-safe buttons, and reading-position preservation in activity logs.
- Codex thread ancestry and lifecycle aggregation: a working descendant keeps its main session active, and resuming it restores completed ancestors.
- Bounded replay history with retained agent identities, per-session snapshots, sequence waterlines, stream-aware live-event buffering, and explicit reset handling.
- Claude saved titles, latest cache-inclusive context usage per agent, replay-safe response tracking, and normalized context-bar/ring composition.
- Cumulative API usage and per-request list-price estimates for main sessions and subagents, including cache categories, Codex compaction calls, replay deduplication, and completed-agent retention.
- A touch-friendly cumulative cost history graph, using original response dates and loading only while the cost panel is open.
- Dollar burn rate from raw response charges, with shared input/output/cache overlays, idle intervals, and Claude compaction iteration accounting.
- Per-agent model and reasoning effort in the phone tree and details, restored from session logs and updated as turn settings change.
- Per-response analytics grouped by model or model + reasoning, with graph filtering, Total/Last 1h/Last 2h views independent of resolution, matching burn units and bounded chart data.
- Custom trailing hours, synchronized pinch zoom and horizontal pan on both cost graphs, and explicit uncertainty when Codex logs zero cache writes alongside cache reads.
- Cache reuse analytics per agent in the selected time/model view: weighted hit rates, uncached-input costs, measured write charges, and costly usage after long gaps, without inferring cache expiry or missing writes.
- Larger burn-rate lines with individual source selection and a today/yesterday comparison using equal elapsed time, a shared dollar scale, and matched partial hours.
- Root, extension, and browser regression coverage for these behaviors.
- Separate Branchline package identities and branding; telemetry defaults off with no collector configured.

Modified source files carry a Branchline fork notice. Git history records their full diffs.

## Compatibility

Existing hook installations and configuration remain usable. The `AGENT_FLOW_*` environment variables, `agentVisualizer.*` command and setting identifiers, and `~/.claude/agent-flow/` and `~/.agent-flow/` paths are retained as technical compatibility identifiers.

An existing deployment can keep its checkout path and service name. Build and install its assets through the existing deployment process; repository setup does not require moving session data or changing Claude authentication.

Package versions reflect the upstream base; the repository and commit identify the fork. No npm or marketplace package is published by this repository setup.

## Attribution

The original [LICENSE](LICENSE), [TRADEMARK.md](TRADEMARK.md), [CLA.md](CLA.md), and upstream history are retained for provenance. Branchline uses its own project name and branch icon. Original product logos and screenshots are not used for fork branding.
