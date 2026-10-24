# Cost & tokens stats plugin

## Context

Singularity has no visibility into how many tokens it consumes or what it costs to run. The existing `plugins/stats/` umbrella ships `commits` and `tasks` charts but nothing about Claude usage. The user asked for stats showing total tokens / price per conversation so they can answer "how much does Singularity cost me to run?".

Claude Code already records every session as a JSONL file under `~/.claude/projects/<project>/<sessionId>.jsonl`, and the `ccusage` npm package (v18.0.11) parses these files into typed aggregates with pre-computed USD costs. Conversations in our DB store the matching `claudeSessionId` (verified: `findTranscriptPath` globs `*/${sessionId}.jsonl` against the same directory ccusage reads), so we can join ccusage output to our `_conversations` table for per-conversation breakdowns — which is the unique value Singularity can add over plain ccusage.

This plan adds a third sub-plugin under `plugins/stats/` that surfaces machine-wide Claude usage with a Singularity-aware filter and a per-conversation drilldown.

## Approach

New sub-plugin: `plugins/stats/plugins/cost/` — `id: "stats-cost"`, package name `@singularity/plugin-stats-cost`. Mirrors the existing `tasks` sub-plugin shape (server entry + web entry + a few chart components). Auto-discovered by `./equin build` — no codegen edits.

### Data flow

```
ccusage/data-loader → server endpoints → useFetchJson → recharts
                          │
                          └─ join SessionUsage.sessionId
                             with _conversations.claudeSessionId
                             for per-conversation breakdown
```

ccusage is read-only against `~/.claude/projects`. No DB writes, no migrations. Fetched once per page mount via `useFetchJson` (same as `commits`/`tasks`).

### What to surface (v1)

A single Stats.Chart card that hosts a small dashboard, ordered roughly by glance-value:

1. **KPI strip** (top of card) — four headline numbers from `loadDailyUsageData()` totals:
   - Total spent (USD)
   - Total tokens (input + output + cache_creation + cache_read)
   - Last 7 days spent
   - Avg cost / active day
2. **Daily cost stacked by model** — bar chart, one bar per day, segments = Opus / Sonnet / Haiku / other. Sourced from `DailyUsage.modelBreakdowns[].cost`. Most informative single chart: shows trend AND model mix.
3. **Cumulative cost over time** — line chart, running USD total per day. Mirrors the existing `CumulativeChart` pattern from `commits` so it visually rhymes with the rest of the Stats pane.
4. **Token mix per day** — second small bar chart, one bar per day, segments = input / output / cache_creation / cache_read. The cache_read bar will dominate; that itself is the story.
5. **Top conversations by cost** — table, joined client-side, columns: title · status · model(s) · last activity · total tokens · cost. Click row opens the conversation. Limited to top 25 by `totalCost`. This is the killer feature — turns "$X spent" into "and here's where it went".

Each is a separate `Stats.Chart` contribution so the user can see them stacked in the pane (consistent with how `commits` ships two charts: "Commits" and "Lines changed").

### Filtering scope

ccusage returns data for **every** Claude Code session on the machine — including ad-hoc sessions outside Singularity. Default surface = all data (matches ccusage's natural output and the user phrasing "how much singularity cost" since on a dev machine ≈ all usage IS Singularity-driven).

A "Singularity only" toggle (top-right of the card, same UX as the `Filter rebases` toggle in `commits`) intersects the data with `_conversations.claudeSessionId`s known to our DB. Persisted as a config field — see `plugins/stats/plugins/commits/shared/config.ts` for the pattern. **Skip** for v1 if it bloats scope; the join is needed for the Top Conversations table anyway, so it's cheap to add.

## Files

### New

- `plugins/stats/plugins/cost/package.json` — workspace member `@singularity/plugin-stats-cost`, dep `ccusage: ^18.0.11`.
- `plugins/stats/plugins/cost/CLAUDE.md` — autogen reference block placeholder; `./equin build` fills it.
- `plugins/stats/plugins/cost/server/index.ts` — `ServerPluginDefinition` with these routes:
  - `GET /api/stats/cost/daily` → `{ points: { date, byModel: { [model]: { cost, input, output, cacheRead, cacheCreation } } }[] }`
  - `GET /api/stats/cost/cumulative` → `{ points: { date, cost }[] }`
  - `GET /api/stats/cost/totals` → `{ totalCost, totalTokens, last7Cost, avgDailyCost, byTokenKind: {...} }`
  - `GET /api/stats/cost/sessions` → `{ rows: { sessionId, conversationId|null, title|null, status|null, totalCost, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, lastActivity, modelsUsed }[] }`
  - All four read via `loadDailyUsageData()` / `loadSessionData()` from `ccusage/data-loader` (single shared module wrapper that calls ccusage once and computes the four projections).
  - `sessions` route does the join: `SELECT id, title, status, claude_session_id FROM _conversations WHERE claude_session_id IS NOT NULL` then left-join in memory.
- `plugins/stats/plugins/cost/server/internal/load-usage.ts` — thin wrapper around ccusage (handles the fact that ccusage is async + does disk IO).
- `plugins/stats/plugins/cost/web/index.ts` — `PluginDefinition` contributing four `Stats.Chart` entries (daily cost, cumulative cost, token mix, top conversations).
- `plugins/stats/plugins/cost/web/components/`:
  - `cost-kpis.tsx` — top KPI strip (rendered inside the daily-cost card or as its own chart entry "Summary").
  - `daily-cost-chart.tsx` — recharts stacked `BarChart` keyed by model.
  - `cumulative-cost-chart.tsx` — uses the existing `CumulativeChart` pattern; reuse `chart-primitives.tsx` from `commits`.
  - `token-mix-chart.tsx` — stacked bar by token kind.
  - `top-conversations-table.tsx` — sortable table; row click navigates to the conversation pane.

### Existing files to read / reuse (no edits)

- `plugins/stats/plugins/commits/web/components/chart-primitives.tsx` — re-export `useFetchJson`, `ChartState`, axis/tooltip styles. Already exported from that plugin's barrel; import via `@plugins/stats/plugins/commits/web`.
- `plugins/stats/plugins/tasks/server/index.ts` — minimal `ServerPluginDefinition` template.
- `plugins/stats/plugins/tasks/web/index.ts` — minimal `PluginDefinition` with `Stats.Chart` contribution.
- `plugins/tasks-core/server` (`getConversationClaudeSessionId`, `_conversations` table) for the join.
- `plugins/conversations/plugins/conversation-view/web` — open conversation on row click (use the same pane API the sidebar uses; check what the conversations-view plugin exports).

## Open question

**Scope of v1**: ship just KPIs + daily-cost-by-model + top-conversations table (3 contributions, fastest path to value), or include cumulative + token-mix charts as well (5 contributions, completes the dashboard)? Recommend the full 5 — they're cheap once the data loader is in place and the user explicitly asked for "stats/graph**s**" plural.

## Verification

1. `./equin build` from the worktree — confirm new sub-plugin gets picked up by codegen, server restarts cleanly, `plugin-boundaries` check passes.
2. Open `http://<worktree>.localhost:9000/stats` — confirm four new chart sections render below "Commits" and "Lines changed".
3. Eyeball the totals — pick a known-cost session and cross-check against `bunx ccusage` CLI output (which reads the same files); numbers should match exactly since we use the same loader.
4. Confirm the join: at least one row in the Top Conversations table should show a real Singularity conversation title (not a bare session UUID).
5. Click a Top Conversations row — navigates to that conversation's pane.
6. With ccusage's `~/.claude/projects` empty (or no sessions matching), all charts render `ChartState`'s "no data" empty state instead of crashing.
