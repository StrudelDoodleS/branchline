# Branchline

A portrait-friendly dashboard for Claude Code and Codex sessions, with a file tree for agents and subagents.

Branchline is an independent fork of [Agent Flow](https://github.com/patoles/agent-flow), originally created by [Simon Patole](https://github.com/patoles). It is not an official Agent Flow release or an endorsed distribution. The fork starts from upstream v0.9.2; [FORK.md](FORK.md) records the changes and compatibility details.

## What this fork adds

- A main-session dropdown instead of a scrolling row of sessions.
- A compact file tree with expand/collapse, Active/Done/All filters, and agent activity below it on phones. Active is the default; your filter choice is remembered.
- Codex subagents grouped under their actual parent conversation, including nested agents.
- Session history loading and reconnect recovery that preserve agent identities and newer live events.
- Readable controls, portrait-safe panels, and activity logs that respect your scroll position.
- Claude context usage from the latest response, including cached tokens, with bars and rings bounded to their tracks.

The original graph view, tool details, transcripts, file activity, and runtime selection remain available.

## Usage and API costs

The header and `$Cost` panel show cumulative recorded usage for the selected main session and its subagents: uncached input, output, cache reads, and cache writes. The panel separates Claude's one-hour writes. Reasoning is included in output, so it is counted once. Finished agents retain their usage.

Open `$Cost` to see cumulative cost over time, including earlier responses in the session logs. Tap the graph or drag its slider to inspect a date and cost. History refreshes every five seconds while the panel is open. Records without timestamps stay in the total and are identified below the graph.

The dollar burn-rate plot shows spend per minute averaged over fixed time buckets, with the bucket width displayed above it. Long sessions use wider buckets; idle buckets have zero spend, and the current bucket fills as responses arrive. Completed sessions keep their recorded time range. Rates are computed from the original charges before chart sampling. The Breakdown button overlays input, output, cache reads and cache writes on both plots and shows their dollar contributions at the selected time. Reasoning stays within output, and one-hour cache writes stay within cache writes.

Compaction consumes model tokens too. Codex response records include those calls. Claude's threshold compaction reports additional sampling calls in `usage.iterations`; the tracker prices each call individually without adding the top-level totals again. See [Claude compaction usage](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold#understanding-usage) and [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction).

Costs use standard API list prices, verified on 20 October 2026, with each request's model and applicable prompt-length tier. Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing). These are API-equivalent token costs; subscriptions, service-tier premiums, and server-side tool fees are outside this estimate. Unknown model rates show as unavailable.

Claude response IDs deduplicate streaming blocks and transcript replays. Codex response usage records include compaction requests; older rollouts use cumulative token counters. Local transcripts restore usage after a server restart. Context bars continue to show current context fill separately.

## Run from source

Use Node.js 22 or newer and pnpm 10. This fork is not published to npm or the VS Code marketplace.

```bash
git clone --branch phone-controls https://github.com/StrudelDoodleS/branchline.git
cd branchline
pnpm install --frozen-lockfile
pnpm run build:app

# Run from the workspace containing the sessions you want to monitor.
branchline_repo="$(pwd)"
cd /path/to/your/workspace
node "$branchline_repo/app/dist/app.js" --no-open --port 3001
```

Open [localhost:3001](http://localhost:3001). The server listens on the loopback interface. The CLI installs the Claude command hooks if needed; Codex sessions are read from local rollout files.

CLI options: `--port <number>`, `--no-open`, `--verbose`, and `--help`.

### Open on a phone over SSH

From Termux or another SSH client:

```bash
ssh -N -L 127.0.0.1:3001:127.0.0.1:3001 user@your-server
```

Open `http://127.0.0.1:3001` in the phone browser. Select a main session, then tap an agent in its tree to read activity. Graph view remains available beside Tree.

### Runtime selection

`AGENT_FLOW_RUNTIME=auto` watches Claude Code and Codex together. Set it to `claude` or `codex` to watch one runtime. For a non-default Codex installation, set `CODEX_HOME`.

The legacy `AGENT_FLOW_*` variables, `~/.claude/agent-flow/` hook directory, and `agentVisualizer.*` extension settings remain compatible with existing installations.

## Development and verification

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm --dir extension test
pnpm --filter branchline run lint
pnpm --dir web exec tsc --noEmit --incremental false
pnpm run build:app
```

`pnpm run dev` starts the development relay and web UI. `pnpm run build:all` builds the VS Code webview and extension. The extension uses the Branchline command category and a separate package identity.

Browser checks exercise portrait navigation, trees, history, reconnects, and context-bar geometry:

```bash
uvx --from playwright==1.63.0 playwright install chromium
uvx --from playwright==1.63.0 python scripts/check-phone-controls.py http://127.0.0.1:3001
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if using an existing Chromium installation. An optional second argument selects check names, separated by commas. The checks use synthetic browser events and do not write to agent transcripts.

## Fork maintenance

The default branch is `phone-controls`. Keep `origin` pointing to this fork and `upstream` pointing to the original project:

```bash
git remote add upstream https://github.com/patoles/agent-flow.git
git fetch upstream
```

Review upstream changes before merging or cherry-picking them. The upstream `main` history is retained separately from this fork's default branch.

## Telemetry

Telemetry is disabled by default and no collector endpoint or key is configured in this fork. Enabling the compatibility flag alone does not send events or create telemetry state. A maintainer would need to configure a separate collector and explicitly opt in.

## Attribution and license

Apache 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Original attribution and upstream trademark information are retained. Fork changes are maintained by [StrudelDoodleS](https://github.com/StrudelDoodleS). See [CONTRIBUTING.md](CONTRIBUTING.md) for fork contributions.
