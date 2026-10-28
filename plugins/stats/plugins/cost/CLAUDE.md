# cost

Token usage and dollar cost across Claude Code sessions. Source data lives in
`~/.claude/projects/<project>/<sessionId>.jsonl`; we parse those files ourselves
and never write to that directory.

Two things shape everything else in this plugin:

- **we own the pricing** — `ccusage` is no longer on the serving path at all;
- **the token history is permanent** — it no longer disappears when Claude Code
  deletes a transcript.

## We own the pricing

`server/internal/price-table.ts` holds our own copy of LiteLLM's
`model_prices_and_context_window.json`, filtered to the Anthropic-relevant slice
and persisted at `COST_USAGE_DIR/price-table.json`. The daily
`stats.cost.refresh` job fetches upstream and merges.

Not a new trust dependency: ccusage's `mode:"auto"` is
`costUSD ?? computeFromLiteLLMTable` and `costUSD` was absent from all 5,247
sampled entries — it was already arithmetic over the same table. Owning it also
removes a 9.8 s / 3.3 GB whole-corpus subprocess from the read path.

**`mergePriceTable` unions and never deletes a key.** The archive spans years;
when BerriAI prunes a deprecated model, mirroring the upstream key set would
silently reprice that model's whole history as unknown. Keeping every rate we
have ever learned *is* the deprecated-model story. `litellm-fallback.json` is the
vendored floor for a machine that has never fetched, loaded lazily by
`litellm-fallback.ts`. Data, not a `.ts` const, on purpose: 154 literal Claude
model ids in a `.ts` file is what `model-provider:no-raw-model-flags` forbids.

`priceBucket()` returns `{ok:true,cost}` or `{ok:false,reason:"unknown-model"}` —
never a silent `$0`, which would be indistinguishable from a genuinely free
bucket.

`ccusage` stays a **dev-only** dependency for exactly one thing:
`scripts/verify-vs-ccusage.ts` (see *Verifying*, below). It is driven as a CLI
(`ccusage claude session --json`): 19.0.0 dropped every library export.

## Tokens are stored, dollars are derived

`parseTranscript` is pricing-free: it emits `(date, model, speed)` token buckets
and nothing else. `rollup` turns buckets into dollars with today's table, so
**every archived bucket is re-priceable forever** instead of freezing whatever
the table said the day it was parsed — a pricing bug fixed tomorrow repairs all
of history on the next read.

What makes that possible is the `below`/`above` tier decomposition in
`buckets.ts`: ccusage applies its 200k tier *per entry*, which naively means cost
can only be computed while you still hold the entries. But both halves are linear,
so storing `Σ min(t,200k)` and `Σ max(0,t−200k)` per token kind reproduces the
exact per-entry-tiered cost from an aggregate. Read `buckets.ts` for the algebra;
`speed` is a whole-entry scalar and so is a bucket *key* dimension, not a rate.

## The archive is permanent and deliberately unbounded

`server/internal/archive.ts` persists one entry per transcript path into
year-sharded `COST_USAGE_DIR/sessions-<YYYY>.json` files. The read path is
`live ∪ archive`; the two write points are the boot warm-up and the daily job.
Sharding bounds a flush to the current year, and old shards become immutable in
practice.

Its error handling is deliberately unlike every sibling cache in the tree,
because **there is no source of truth to rebuild it from**: a schema-version
mismatch never discards (entries are kept verbatim and migrated forward in code),
a corrupt shard throws rather than letting the next flush overwrite it, and merge
is live-wins-*except-on-shrink*.

**The growth bound, stated in prose because it cannot be declared.**
`infra/retention` has exactly three growth-bound constructors — `ttl`, `cascade`,
`rotate` — and no "intentionally unbounded" case, which is correct: unboundedness
should be argued, not declared. The bound here is **O(Claude sessions ever run)**:
~0.9 KB per entry measured on the current corpus, so 1,771 live sessions ≈ 1.6 MB,
and at the observed rate (~3,800 sessions in ~4 months) roughly **5–10 MB/yr**.
Nothing ever reclaims it, and that is the point. (`COST_USAGE_DIR/index.json`, the
corpus index, is equally undeclared and pre-existing — it is rebuildable, this is
not.)

`defineFileSink` is deliberately **not** used: it *is* rotation (128 MB × 3,
dropping the oldest generation), and for an archive whose entire value is its
oldest data, rotation is the failure mode. Whole-file atomic temp+rename
snapshots are what `sink-safety` leaves alone anyway.

## The April→June 2026 gap is unrecoverable

Claude Code deletes transcripts after `cleanupPeriodDays` (default 30) and the
corpus index drops vanished paths, so before this archive existed the charts were
retroactively truncated. On this machine: first commit 2026-04-07, oldest
surviving transcript 2026-06-17, 3,803 conversations carrying a `claudeSessionId`
against 1,765 transcript files on disk. **Roughly 2,000 conversations' cost is
already gone and cannot be recovered** — nothing in this plugin can bring it back,
so read a chart that starts in June as history, not as a bug.

Raising `cleanupPeriodDays` in `~/.claude/settings.json` widens the window and
reduces future exposure between flushes; the archive is what removes the exposure.

## Known divergences from ccusage

Measured 2026-10-28 against ccusage 20.0.45 over ~3,800 transcripts: −$0.99
(−0.005%), every token kind within 0.013%, 1,298 of 1,305 projects to the cent
(the rest are transcripts being written while the two sides read them).

| Divergence | Size | Direction |
|---|---|---|
| Cross-file dedup (ccusage global, we per-file) | lost in the noise | accepted |
| 1h/5m apportioning of the 200k threshold | $0 today | deliberate |

**A message counts at its largest output.** Claude Code writes one transcript
line per content block of a message (a `thinking` line, then a `text` or
`tool_use` line), every line carrying the same `message.id` + `requestId` and
its own `usage`: identical input and cache counts, but an `output_tokens` that
is only final on the LAST line (8 on the thinking line, 3,778 on the text line
after it). `foldUsageEntry` keeps what it counted per hash (`SeenEntry`) and
tops a repeat's extra output up into the same bucket — ccusage's reading. Until
2026-10-28 it kept the first line, under-counting output by 16.5% (−1.4% of
cost); `INDEX_VERSION` 4 re-parses the corpus, the archive takes the grown
counts (live wins on growth), and conversations/usage recounts its legacy rows.
History whose transcripts were already deleted stays under-counted.

**The 1h rate.** 1h cache writes are priced ~1.6× the 5m rate. Up to ccusage 18
its schema omitted the 1h rate (our numbers were ~8% above it on purpose);
ccusage 20 prices it as we do, so the two now agree.

**Dedup.** We dedupe entry hashes *within* a file; ccusage dedupes globally.
Persisting every hash would add hundreds of MB to the index, so we over-count the
rare cross-file duplicate. **This gap grows with `claude --resume
--fork-session`**: a fork copies the parent transcript into a new file, so the
parent's whole history is counted twice, permanently, once archived. If it drifts
above ~0.5%, the fix is to record each file's first-entry `sessionId`/`parentUuid`
in `FilePartial` so a later pass can subtract prefix copies.

**Apportioning.** The 200k tier is defined on an entry's combined cache-creation
count, so the split point is computed on the total and apportioned across 5m/1h by
share. Worth $0 today: none of the six models in this corpus is tiered (though
tiered Claude models exist — `claude-sonnet-4-5` carries the full
`*_above_200k_tokens` set).

## The release gap (known, deferred)

Both archive write points are `isMain()`-gated *by infrastructure this plugin does
not own*:

- `jobs`' `buildCronItems` skips non-`perWorktree` schedules unless `isMain()`
  (`plugins/infra/plugins/jobs/server/internal/worker.ts:66`), so the daily job's
  cron is never installed in a release;
- `warmup`'s executor skips `scope:"host"` warm-ups unless `isMain()`
  (`plugins/infra/plugins/warmup/server/internal/executor.ts:49`), so the boot
  flush does not run there either.

In a release the single backend runs under its composition name, so `isMain()` is
false and **the archive is currently written in dev only**. `captureCostHistory`
itself already gates on `isHostSingleton()`, so the flush is correct wherever it
is reached — the gap is upstream. The fix is moving both gates to
`isHostSingleton()`; it is deferred because that changes behaviour for every
host-scoped warm-up and main-only cron in the repo, not just this one.

## Reports

Two kinds (`server/internal/cost-report-kinds.ts`), both `warning`:

- **`cost-unpriced-model`** — the table could not resolve a model the corpus used,
  so its buckets contributed `$0`. One row per model. Usually means the daily
  refresh has not run yet, or `isAnthropicRelevant` filtered a key out. The tokens
  are not lost: learning the price re-prices that history.
- **`cost-archive-shrink`** — a transcript re-parsed to *fewer* tokens than the
  archive had banked for it, i.e. it was truncated in place. The archived value
  wins; the report is the record that it happened. Transcripts are append-only in
  normal operation, so this is an anomaly worth reading.

## Verifying

```bash
./equin run plugins/stats/plugins/cost/scripts/verify-vs-ccusage.ts
```

The regression gate for any pricing or parse change: ~1.5 min, prints our
shipped totals beside ccusage's, cost and each token kind (input / output /
cache create / cache read), then the per-project outliers with the token kinds
that differ. A counting divergence shows in the one kind it touches; a cost
delta with every kind equal is a rate divergence. Both sides key by the
top-level project dir (a subagent transcript belongs to its parent's project).
The dollars grow with the corpus — the per-kind percentages are the invariant
(see *Known divergences*, above).

## Charts

`repoOnly` is a per-worktree config field (defaults to `true`). Each chart
reads it (`useScope`) and passes it as the `scope` param of its live value, so
the chart re-reads when the toggle flips. Scope classification is a pure
predicate over the encoded project-dir name (`classify-projects.ts`) evaluated
over `archive ∪ live` — never a `readdir` of `~/.claude/projects`, which would
resolve a deleted project to "not equin" and hide its archived sessions from
the default view.

**The values (interim — metrics P2 deletes them).** `shared/values.ts` declares
four `stats.cost.*` values, served in `server/internal/served.ts`, each
computed by `server/internal/answers.ts` from ONE memoized bundle
(`loadBundle`): `daily` (the daily-cost, token-mix, cumulative charts and the
KPIs — cumulative and the last-7-days sum are derived in the browser,
`shared/derive.ts`), `sessions-daily` (sessions per day and the average per
conversation), `distribution` and `top-sessions` (top 50). The two per-day
series keep the newest `COST_DAYS_MAX` days (ten years) and say `truncated`
(the charts' note). All are external
`"notified"`: a subscribed tuple holds `watchCostInputs` — a directory watch of
`~/.claude/projects` (any `.jsonl` written), `onPriceTableUpdated` and a
capture. Transcript writes are coalesced at the source into one notify per
30 s window (not by `throttleMs`, which the runtime drains early whenever any
other resource flushes). The bundle is rebuilt once per input change, however
many values read it.

**The read path reads no Postgres.** A session's conversation (title, status,
link) is read on the web from `stats.cost.session-conversations`, a lookup-only
collection over `conversations` keyed by `claudeSessionId` (routed: a rename
reaches the row). Conversation rows are deleted with their tasks, so the
archive snapshots `title`/`conversationId` at capture time (the warm-up and the
daily job, the only paths that read `_conversations`); the live row wins where
it survives, the snapshot fills in where it does not.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Token usage and dollar cost across Claude Code sessions, with per-conversation breakdown. Token usage and dollar cost across Claude Code sessions, priced from our own merge-only LiteLLM table and banked into a permanent year-sharded token archive so deleted transcripts stop rewriting the past.
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
    - `network/live.useLive`
    - `primitives/css/grid.Grid`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/toggle-chip.ToggleChip`
    - `primitives/live-state.foldResource`
    - `primitives/pane.useOpenPane`
- Server:
  - Contributes:
    - `ConfigV2.Register` "config"
    - `report-kind` "cost-archive-shrink"
    - `report-kind` "cost-unpriced-model"
    - `resource.declare` "stats.cost.daily"
    - `resource.declare` "stats.cost.distribution"
    - `resource.declare` "stats.cost.session-conversations:rows"
    - `resource.declare` "stats.cost.sessions-daily"
    - `resource.declare` "stats.cost.top-sessions"
  - Uses:
    - `config_v2.ConfigV2`
    - `database.db`
    - `infra/corpus-index.defineCorpusIndex`
    - `infra/file-watcher.acquireDirWatch`
    - `infra/jobs.defineJob`
    - `infra/paths.CLAUDE_PROJECTS_DIR`
    - `infra/paths.isHostSingleton`
    - `infra/safe-fetch.safeFetch`
    - `infra/warmup.defineWarmup`
    - `infra/worktree.ensureMainWorktreeRoot`
    - `network/live.serveCollection`
    - `network/live.serveValue`
    - `primitives/log-channels.Log`
    - `reports.ReportKind`
    - `reports/engine.recordReport`
    - `tasks/tasks-core._conversations`
  - DB schema: `plugins/stats/plugins/cost/server/internal/price-table.ts`
  - Exports (values):
    - `currentPriceTable`
    - `onPriceTableUpdated`
  - Register:
    - `defineWarmup('stats.cost.usage')`
    - `defineFileWatcher('corpus-index.stats.cost.usage')`
    - `defineJob('stats.cost.refresh')`
  - Resources:
    - `stats.cost.daily` (push, notified, whole: one key per model (or model family) used — the handful of Claude models, never one per session, capped: COST_DAYS_MAX)
    - `stats.cost.distribution` (push, notified, whole: a 1-2-5 ladder over the sessions' cost spread (about 16 buckets for $0.01 – $1k), whatever the number of sessions)
    - `stats.cost.session-conversations:rows` (keyed, point)
    - `stats.cost.sessions-daily` (push, notified, whole: one key per model (or model family) used — the handful of Claude models, never one per session, capped: COST_DAYS_MAX)
    - `stats.cost.top-sessions` (push, notified, capped: TOP_SESSIONS, whole: one key per model (or model family) used — the handful of Claude models, never one per session)
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
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/archive.ts`, `server/internal/price-table.ts`, `server/internal/usage-index.ts` (debt)
- Core:
  - Exports (types):
    - `CountedUsage`
    - `DayBucket`
    - `ModelPrice`
    - `PriceTable`
    - `SeenEntry`
    - `TieredTokens`
    - `UsageBuckets`
  - Exports (values):
    - `emptyUsageBuckets`
    - `foldUsageEntry`
    - `formatTokens`
    - `formatTokensCompact`
    - `formatUsdCompact`
    - `priceBucket`
    - `resumeUsageBuckets`
- Shared:
  - Exports (types):
    - `CostDay`
    - `CostScope`
    - `CostSessionDay`
    - `CostTopSession`
  - Exports (values):
    - `COST_SCOPES`
    - `costConfig`
    - `costDaily`
    - `costDistribution`
    - `costSessionsDaily`
    - `costTopSessions`
    - `sessionConversations`
    - `TOP_SESSIONS`

<!-- AUTOGENERATED:END -->
