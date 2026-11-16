# cost

Stats → Cost: token usage and dollar cost of every Claude Code session on this
computer, every equin conversation and every one-shot `claude --print` call.
This plugin only READS — it holds no parse, no price table and no archive of
its own. The one system it reads
([`research/2026-11-16-global-unified-claude-cost.md`](../../../../research/2026-11-16-global-unified-claude-cost.md)):

- **Counting** — conversations/usage's machine half is the one reader of
  `~/.claude/projects`; it files every transcript's tokens into the usage
  ledger (`claude_usage_hours`, infra/claude-cli/usage-ledger) under a source:
  `conv:<conversationId>`, `session:<claudeSessionId>` (a session equin did not
  launch), and the call recorder's `cli:<name>`. Tokens, never dollars, split
  at the 200k tier per entry (usage-ledger's `buckets.ts`).
- **Pricing** — `claude_spend_hours_v` (usage-ledger/pricing) prices each
  ledger hour with the price version in force at that hour: a refresh's new
  rates apply from now on, a correction (a version effective from a past
  instant) re-prices what it covers on every surface. An hour with no rate is
  `cost_usd` NULL — never $0 — and the daily refresh files
  `cost-unpriced-model` for it (pricing/price-table).
- **Permanence** — main's database. A ledger row outlives its transcript; the
  one-shot history import (conversations/usage) brought in what came before
  the ledger, including the legacy year-sharded archive this plugin used to
  write (left read-only in price-table's `costUsageDir`).

## The values and their rollups

`shared/values.ts` declares four `stats.cost.*` values (interim — metrics P2
deletes them), served `"db"` in `server/internal/served.ts` and answered in
`server/internal/answers.ts` from two rollups of the priced view
(`server/internal/tables.ts`), kept by the database (`server/internal/
rollups.ts`, the `stats.cost.rollups` trigger set):

- **`claude_spend_days`** `(day, model, is_repo)` — the day's cost and tokens;
  `is_repo` is the source's `claude_usage_sources.is_repo` (false with no
  row). `daily` (the daily-cost, token-mix, cumulative charts and the KPIs —
  cumulative and the last-7-days sum are derived in the browser,
  `shared/derive.ts`) reads it.
- **`claude_spend_sources`** `(source)` — a source's whole cost, tokens, last
  hour and models. `sessions-daily`, `distribution`, `top-sessions` (top 50,
  by its cost index) and `daily`'s session count read it, joined to
  `claude_usage_sources` for the scope and a title.

Statement-level triggers re-aggregate only the keys a write moved: a ledger
write (its sources and days), a rate write (the hours of its model its version
prices), a version write (the hours from its earliest `effective_from`), a
sources-row write that sets or flips `is_repo` (that source's days) — each
under a per-key advisory lock, with a guarded upsert, so the change feed hears
of a key only when its numbers moved, and every recompute reads a few rows per
day of use and one per session, never the ledger. The by-hand maintenance
mirrors derived-tables (A34) because a `derived-tables` rollup may read only
declared source tables, and this one reads the view — the same choice as the
Cost column's (`conversations/usage` `cost-triggers.ts`).
`reconcileCostRollups`, run by the `stats.cost.rollups-reconcile` warm-up once
per change of `rollups.ts`, is the repair.

- **A session is a ledger source**, `conv:` (a conversation's whole session
  chain and its sub-agents) or `session:`. A `cli:` source is spend, not a
  session: it counts in the per-day cost and tokens, never in the session
  counts, the distribution or the top sessions.
- **Scope.** `repoOnly` (per-worktree config, default `true`) becomes each
  chart's `scope` param (`useScope`); it reads each source's recorded
  `is_repo` (set by its writer with `isRepoProjectDir` when it was first
  counted) — never a `readdir`, which would hide a deleted project's history.
- **A top session's conversation** (title, status, link) is read on the web
  from `stats.cost.conversations`, a lookup-only collection over
  `conversations` by id; a source whose conversation is gone shows its recorded
  title.
- **A worktree's charts show its DB fork**, like every DB surface.

## History that is gone

Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). Before
the legacy archive existed the charts were retroactively truncated: on this
machine the oldest surviving transcript is 2026-06-17 against a first commit on
2026-04-07 — **roughly 2,000 conversations' cost is unrecoverable**, so read a
chart that starts in June as history, not as a bug. Imported archive history
is at day granularity (00:00 UTC) under the `unknown` account.

## Verifying against ccusage

```bash
./equin run plugins/stats/plugins/cost/scripts/verify-vs-ccusage.ts [--fetch] [--top N]
```

The regression gate for a counting or pricing change (`ccusage` stays a
dev-only dependency for exactly this): folds every transcript on disk with the
shipped `foldUsageEntry`, prices each bucket with the held table
(`priceBucket`), and prints the totals beside ccusage's — cost and each token
kind — then the per-project outliers with the kinds that differ. A counting
divergence shows in the one kind it touches; a cost delta with every kind
equal is a rate divergence. The per-kind percentages are the invariant (the
corpus grows).

Known divergences (2026-10-28, ccusage 20.0.45, ~3,800 transcripts: −0.005%,
every kind within 0.013%):

| Divergence | Size | Direction |
|---|---|---|
| Cross-file dedup (ccusage global, we per-file — a `--fork-session` copy counts twice) | lost in the noise | accepted |
| 1h/5m apportioning of the 200k threshold | $0 today | deliberate |

A message counts at its largest output (Claude Code writes one line per
content block, the output final only on the last — `SeenEntry` tops it up),
as ccusage reads it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Token usage and dollar cost across Claude Code sessions, with per-conversation breakdown. Stats → Cost: token usage and dollar cost of every Claude Code session, conversation and one-shot call, read from the priced token ledger (claude_spend_hours_v — each hour at the price in force then) through two database-maintained rollups (claude_spend_days per UTC day, model and repo flag; claude_spend_sources per source), served as the stats.cost.* live values.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "config"
    - `Stats.Chart` "Cost & Tokens" → `CostSection`
    - `Stats.Chart` "Token mix per day" → `TokenMixChart`
    - `Stats.Chart` "Average cost per conversation" → `AvgCostPerConversationChart`
    - `Stats.Chart` "Cost distribution per conversation" → `CostDistributionChart`
    - `Stats.Chart` "Top conversations by cost" → `TopConversationsTable`
  - Uses: 26 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `stats/commits` ×10
    - `config_v2` ×3
    - `primitives/data-view` ×3
    - `stats` ×2
    - `conversations/conversation-view.conversationPane`
    - `network/live/live-state.foldResource`
    - `network/live.useLive`
    - `primitives/css/grid.Grid`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/toggle-chip.ToggleChip`
    - `primitives/pane.useOpenPane`
- Server:
  - Contributes:
    - `ConfigV2.Register` "config"
    - `db-trigger` "stats.cost.rollups"
    - `resource.declare` "stats.cost.conversations:rows"
    - `resource.declare` "stats.cost.daily"
    - `resource.declare` "stats.cost.distribution"
    - `resource.declare` "stats.cost.sessions-daily"
    - `resource.declare` "stats.cost.top-sessions"
  - Uses:
    - `config_v2.ConfigV2`
    - `database.db`
    - `database.DbExecutor`
    - `database/db-triggers.DbTrigger`
    - `database/db-triggers.defineDbTriggers`
    - `infra/claude-cli/usage-ledger._claudeUsageHours`
    - `infra/claude-cli/usage-ledger._claudeUsageSources`
    - `infra/claude-cli/usage-ledger/pricing._claudeModelRates`
    - `infra/claude-cli/usage-ledger/pricing._claudePriceVersions`
    - `infra/claude-cli/usage-ledger/pricing.claudeSpendHoursView`
    - `infra/warmup.defineWarmup`
    - `network/live.serveCollection`
    - `network/live.serveValue`
    - `tasks/tasks-core._conversations`
  - DB schema: `plugins/stats/plugins/cost/server/internal/tables.ts`
  - Register: `defineWarmup('stats.cost.rollups-reconcile')`
  - Resources:
    - `stats.cost.conversations:rows` (keyed, point)
    - `stats.cost.daily` (push, whole: one key per model (or model family) used — the handful of Claude models, never one per session, capped: COST_DAYS_MAX)
    - `stats.cost.distribution` (push, whole: a 1-2-5 ladder over the sessions' cost spread (about 16 buckets for $0.01 – $1k), whatever the number of sessions)
    - `stats.cost.sessions-daily` (push, whole: one key per model (or model family) used — the handful of Claude models, never one per session, capped: COST_DAYS_MAX)
    - `stats.cost.top-sessions` (push, capped: TOP_SESSIONS, whole: one key per model (or model family) used — the handful of Claude models, never one per session)
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/density --space-md`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-caption`
    - `ui/tokens/type-scale --font-weight-medium`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-caption`
- Shared:
  - Exports (types):
    - `CostDay`
    - `CostScope`
    - `CostSessionDay`
    - `CostTopSession`
  - Exports (values):
    - `COST_SCOPES`
    - `costConfig`
    - `costConversations`
    - `costDaily`
    - `costDistribution`
    - `costSessionsDaily`
    - `costTopSessions`
    - `TOP_SESSIONS`
- Sub-plugins:
  - **`format`** — How token counts and dollar amounts read: formatTokens (1,284,512), formatTokensCompact (1.3M) and formatUsdCompact ($12K). A core-only leaf, so a surface showing a token count (the conversation…

<!-- AUTOGENERATED:END -->
