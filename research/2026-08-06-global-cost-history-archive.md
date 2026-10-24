# Permanent cost history: own the pricing, archive the tokens

## Context

`plugins/stats/plugins/cost/` derives **every** cost and token statistic by re-parsing
`~/.claude/projects/**/*.jsonl` at read time. Nothing is persisted. Claude Code deletes
those transcripts after `cleanupPeriodDays` (default 30, currently unset on this machine),
and `infra/corpus-index`'s `refreshCorpus` drops vanished paths
(`corpus-index.ts:250-256`). So a deleted transcript retroactively disappears from every
chart.

This is not hypothetical — it has already happened:

| | |
|---|---|
| First commit | 2026-04-07 |
| Oldest surviving transcript | 2026-06-17 |
| Conversations in DB with a `claudeSessionId` | 3,803 |
| Transcript files on disk | 1,765 |

Roughly 2,000 conversations of cost history is **already unrecoverable**. Charts don't show
wrong numbers, they show retroactively truncated ones: the daily chart loses old days, the
cumulative chart restarts lower, KPIs under-report, and old sessions drop out of
top-conversations.

**Outcome:** cost history becomes permanent and independent of the transcript corpus.
Deleting a transcript stops changing the past.

### Why this also means owning the pricing

Today cost is not a property of a file at all. `rollup` (`usage-index.ts:318`) takes
ccusage's **per-project** total and distributes it across that project's files by token
share — an approximation the code admits. Archiving tokens without addressing this would
*break currently-correct numbers*: ccusage's total only covers live files, so dividing it
across a pool that includes archived files dilutes every session.

Measurements that make owning the pricing the right call (all verified on the live corpus):

- ccusage `mode:"auto"` is `costUSD ?? computeFromLiteLLMTable`. Across 5,247 sampled
  entries, **`costUSD` is present in zero of them**. ccusage is already pure arithmetic on
  LiteLLM's table — we are not taking on a new trust dependency, we are removing a layer of
  indirection over the same one.
- A faithful reimplementation matched ccusage on **442 of 449 projects to the cent**; total
  delta **+$56.52 on $13,980.67 (0.404%)**, entirely explained by dedup scope (below).
- All our models (`claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5`)
  resolve by **exact key** in the LiteLLM table — ccusage's substring fallback is never
  needed today.
- ccusage's valibot schema ignores `cache_creation_input_token_cost_above_1hr`, but
  transcripts carry `usage.cache_creation.ephemeral_1h_input_tokens`. **261M of 661M
  cache-creation tokens are 1h TTL**, priced ~1.6× higher. ccusage under-reports by
  **$1,136 (+8.1%)**.

Owning pricing also deletes the 9.8 s / 3.3 GB whole-corpus ccusage subprocess from the
serving path, the 5-minute pricing TTL, and the transient cost-inflation bug that TTL causes
when files vanish mid-window.

### Decisions taken (flag at review if you disagree)

1. **Adopt the 1h-cache correction.** It is the true billed cost. Charts will step up ~8%
   once, and historical figures change permanently. We diverge from ccusage deliberately.
2. **Keep `ccusage` as a dev-only verification script**, off the serving path. It is how the
   0.404% gap was found and is the regression test for future pricing changes.
3. **Accept the 0.404% dedup divergence for now**, documented and re-measurable. See
   "Known divergences".

---

## Design

### 1. Price at rollup, never at parse

The obvious move — price each entry during `parseTranscript` and store dollars — is wrong,
for three reasons: baked dollars can never be re-priced when a pricing bug is found; a
request that lands before the price table loads would permanently bake wrong dollars into
the archive (the fingerprint is unchanged, so the file is never re-parsed); and it forces
mutable module state into corpus-index's `parse` callback, whose contract is
"side-effect-free — token/data only" (`corpus-index.ts:38`).

It is also unnecessary, because **ccusage's per-entry 200k tier is decomposable**. Per token
kind, ccusage computes `t*base` when `t <= 200k`, else `200k*base + (t-200k)*tiered`
(`data-loader-9ESMosno.js:4739-4756`). Summed over entries:

```
Σ f(t_i) = base * Σ min(t_i, 200k) + tiered * Σ max(0, t_i - 200k)
```

Both sums are linear. Storing `below = Σ min(t,200k)` and `above = Σ max(0,t−200k)` per kind
reconstructs the exact per-entry-tiered cost from tokens alone, at rollup, forever
re-priceable. The `speed` multiplier is a whole-entry scalar, so it becomes a **bucket key
dimension**, not a baked price.

> **CORRECTED during implementation.** The original claim here — "no Claude model carries
> `*_above_200k_tokens` fields today" — is false: `claude-sonnet-4-5` carries the complete
> set, at 2× the base input rate (and LiteLLM even carries a distinct 1h × >200k rate). What
> is true is narrower: none of the six models present in THIS corpus (`claude-opus-4-8`,
> `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-sonnet-4-6`, `<synthetic>`)
> is tiered, so `tiered` is undefined and the base rate applies throughout. The decomposition
> costs 5 extra numbers per bucket and becomes load-bearing the first day anyone runs a
> tiered model — at which point buckets already archived are still priced correctly.

`DayBucket` becomes keyed `(date, model, speed)` with five kinds × `{below, above}`:
`input`, `output`, `cacheRead`, `cacheCreate5m`, `cacheCreate1h`. Normalize `speed: null →
"standard"` (28% of sampled entries predate the field; none are `"fast"` yet).

For the 1h/5m split, apportion the 200k threshold across the two sub-kinds by their ratio
within the entry — it stays linear and is the closer analogue to what is billed. This is a
deliberate divergence from ccusage, which ignores 1h entirely.

### 2. The price table is merge-only

`plugins/stats/plugins/cost/server/internal/price-table.ts` (new): fetch LiteLLM's
`model_prices_and_context_window.json` via `safeFetch`
(`@plugins/infra/plugins/safe-fetch/server`), filter to Anthropic-relevant keys, persist to
`COST_USAGE_DIR/price-table.json` with the atomic temp+rename shape already used by
`savePricing` (`usage-index.ts:154-161`).

**`mergePriceTable` unions and never deletes a key.** The archive will span years; when
BerriAI prunes a deprecated model, a reprice-at-read design would silently send that history
to $0. Never deleting a learned price is the whole deprecated-model story, and it replaces
ccusage's substring fallback. A vendored snapshot in `litellm-fallback.ts` (a typed `const`,
not a `.json` read, so it survives bundling) covers first boot offline.

`priceBucket()` returns a discriminated result — `{ok:true, cost}` or `{ok:false,
reason:"unknown-model", model, tokens}` — never a silent `$0`. Per the `api-design` decision
rule this is the batch-partial-failure shape; `rollup` accumulates them and `loadBundle`
files one deduped `recordReport` per distinct unpriced model, but **only when `tokens > 0`**
(the `<synthetic>` pseudo-model has all-zero usage and must not report).

### 3. The archive: year-sharded, never deleted

`COST_USAGE_DIR/sessions-<YYYY>.json`, sharded on `lastActivity.slice(0,4)`, one
`ArchiveEntry` per transcript path:

```ts
interface ArchiveEntry {
  schemaVersion: number;          // PER ENTRY, not per file
  partial: FilePartial;           // tokens + (date,model,speed) buckets
  title: string | null;           // snapshotted — see below
  conversationId: string | null;
  isSingularity: boolean;         // fallback if the repo is ever renamed
}
```

Three properties are load-bearing:

- **A version mismatch must never discard.** `loadCorpusFile` treats a mismatch as empty and
  rebuilds (`corpus-index.ts:162-165`) — safe, because disk is the source of truth. The
  archive *has no source of truth to rebuild from*. Unknown or older `schemaVersion` entries
  are kept verbatim and migrated forward in code. Reusing `INDEX_VERSION` here would mean
  the next routine shape change silently destroys years of history.
- **A corrupt shard throws.** `loadPricing` returns `undefined` on `SyntaxError`
  (`usage-index.ts:139-142`) — correct for a cache, catastrophic for an archive, because the
  next flush would overwrite a recoverable file with an empty one.
- **Merge is live-wins-except-on-shrink.** If a live entry has fewer tokens than its archived
  counterpart (in-place truncation), keep the archive value and file a report.

**Sharding, not one file.** `refreshCorpus` already rewrites all of `index.json` (1.29 MB)
whenever anything changes, at up to ~1 Hz while agents are active. A whole-archive rewrite at
that cadence would be a long synchronous `JSON.stringify` — the stall monitor would light up.

> **CORRECTED during implementation:** the "~25 MB/yr" size estimate (repeated in step 10) is
> ~3-5× too pessimistic. Measured on the real parse output, an archive entry serializes to
> ~0.9 KB, so today's 1,771 live sessions are ≈1.6 MB and the observed session rate
> (~3,800 in ~4 months) puts growth at **~5-10 MB/yr**. Sharding is still right — it bounds a
> flush to the current year and makes old shards immutable — just not urgent at year one. Sharding bounds a rewrite to the current year, and
old shards become immutable (cheap to back up, impossible to corrupt with a bug in this
year's writer).

**Flush daily, not on every read.** Transcripts only vanish after 30 days of untouched
mtime, so a daily flush plus one at warmup leaves a 30× safety margin. This also dissolves
the capture-race worry: the window becomes "created and deleted within one day", which a
30-day GC cannot produce.

**Do not add `retainVanished` to `corpus-index`.** Sonata's reconcile explicitly depends on
`entries()` meaning *present on disk* (`reconcile.ts:127-130`); a flag that makes `entries()`
mean two different things is exactly the ambiguity that plugin's CLAUDE.md warns about for
`added` vs `modified`. It would also couple archive lifetime to `INDEX_VERSION` (see above)
and inherit the whole-file rewrite.

`defineFileSink` is also wrong here: it *is* rotation (128 MB × 3, dropping the oldest
generation), and for an archive whose entire value is the oldest data, rotation is the
failure mode. `sink-safety` explicitly leaves whole-file writes alone, so atomic temp+rename
snapshots are lint-clean by construction (same as corpus-index today).

### 4. Two live-corpus assumptions that must die

**`classifyProjects` (`load-usage.ts:208-226`) is a latent bug that the archive would
expose.** It `readdir`s `CLAUDE_PROJECTS_DIR` and any dir not listed resolves to `false` via
`?? false` (`load-usage.ts:141`, `handlers.ts:33`). Since default scope is `"singularity"`
in all eight handlers and `singularityOnly` defaults to `true` (`shared/config.ts:7`), a
deleted project dir would make its archived sessions **silently vanish from the default
view**.

The readdir is gratuitous: the body is a pure string predicate on the directory name
(`d.endsWith("-"+basename) || d.includes("-"+basename+"-")`), and every `projectDir` is
already in `FilePartial`. Extract `isSingularityProjectDir(dir, repoBasename)` and evaluate
it over `archive ∪ live`. This is independently valuable and ships first.

**`loadConvBySession` (`load-usage.ts:177-198`) has the same disease one layer up.** Titles
come from `_conversations` in the per-worktree DB fork; rows are deleted with their tasks, so
`handleSessions` would degrade to bare UUIDs for archived sessions. Snapshot `title` and
`conversationId` into the archive at capture time; keep the live DB join as the override for
rows that still exist.

### 5. `isMain()` is false in a release

`isMain()` is `SINGULARITY_WORKTREE === "singularity"` (`paths.ts:24`), but in a release the
backend's worktree is the composition name — yet that single backend *is* the host singleton
(`paths.ts:29-35`). Every gate in the natural design resolves to `isMain()`:
`computePersist("host", isMain())` (`corpus-index.ts:137`), `defineWarmup({scope:"host"})`,
and `buildCronItems`'s `if (!main && !schedule.perWorktree) continue`
(`jobs/server/internal/worker.ts:66,74`). **So in a release the archive would never be
written and the history loss would continue unchanged.**

Introduce `isHostSingleton() = isMain() || isRelease()` in `infra/paths/core` and gate the
archive writer and refresh job on it. The idiom already exists inline — the cluster sentinel
writes `if (!isMain() && !isRelease()) return;` twice
(`plugins/debug/plugins/sentinel/server/index.ts:26,30`) — so naming it also removes a
drift-prone duplication. Migrate the sentinel to the named helper.

Fixing `corpus-index` / `warmup` / `jobs` fleet-wide is out of scope, but note the finding:
it means `conversations.transcript-touch` never runs in a release either, so retained
conversations' transcripts are being GC'd there.

---

## Implementation steps

**Step 0 — ship alone, first.** `load-usage.ts`: replace `classifyProjects` with a pure
exported `isSingularityProjectDir(dir, repoBasename)`; build `projectIsSingularity` in
`buildBundle` from the dirs in `costIndex.entries()`; drop the `readdir` and its import.
Tests → new `server/internal/classify-projects.test.ts` (bun:test): main-repo dir, worktree
dir, unrelated dir, dir whose directory no longer exists. Independently valuable, zero risk.

**Step 1 — host-singleton predicate.** Add `isHostSingleton()` to
`plugins/infra/plugins/paths/core/internal/paths.ts`, re-export from `core/index.ts` and
`server/index.ts`, migrate `plugins/debug/plugins/sentinel/server/index.ts:26,30`.

**Step 2 — price table.** New `server/internal/price-table.ts` (`parseLiteLlmTable`,
`mergePriceTable`, `loadPriceTable`/`savePriceTable`, `fetchPriceTable`, `priceBucket`) and
`server/internal/litellm-fallback.ts`. Tests (bun:test): tiered vs untiered, `fast`
multiplier, merge-never-deletes, unknown model returns `ok:false` not `0`, zero-token
`<synthetic>` is not reported.

**Step 3 — parse shape.** `usage-index.ts`: inline `createUniqueHash`
(`data-loader-9ESMosno.js:5570-5575`, 5 lines) so the serving path stops importing ccusage;
reshape `DayBucket` to `(date, model, speed)` × 5 kinds × `{below, above}`, reading
`usage.cache_creation.ephemeral_{1h,5m}_input_tokens`; keep the file-level scalar totals
(`handleTokenMix` needs them); bump `INDEX_VERSION` 2 → 3; delete `PricingSnapshot`,
`CostSource`, `PricingHolder`, `PricingDeps`, `loadPricing`, `savePricing`, `ensurePriced`
(`:59-200`). Extend the existing `usage-index.test.ts` with a >200k cache-read entry and a
1h-cache entry, asserting `below`/`above` reconstruct the exact per-entry cost; delete the
four `ensurePriced`/`loadPricing` tests.

**Step 4 — rollup.** `rollup(entries, table)` returns `{daily, sessions, unpriced}`. Delete
the proportional-distribution block (`:325-332`, `:346-351`, `:386-392`) — it just sums now.
Test that two sessions in one project with very different token counts get their own exact
costs rather than a token-share split.

**Step 5 — archive.** New `server/internal/archive.ts`: `loadArchive`, `mergeLive`,
`flushArchive` (group by year, write only changed shards, atomic temp+rename). Tests: a path
in the archive and absent from live survives; unknown `schemaVersion` survives a load/flush
round-trip; a corrupt shard throws; only the touched shard is rewritten.

**Step 6 — wiring.** `load-usage.ts`: module-level price table + archive loaded once;
`buildBundle` = `ensureFresh()` → `mergeLive(...)` → `rollup(merged, table)`, **no archive
write**; `warmAndWatch` flushes once under `isHostSingleton()`. Delete `PRICING_PATH`,
`PRICE_TTL_MS`, `pricingHolder`, `pricingLoaded`, `pricingInflight`, `pricingDeps`,
`ensurePricedOnce` (`:65-126`).

**Step 7 — daily job.** New `server/internal/refresh-job.ts`:
`defineJob({name:"stats.cost.refresh", dedup:"singleton", schedule:{cron:"0 5 * * *"}})` —
fetch + merge + save table, `ensureFresh()`, `flushArchive()`. Register in `server/index.ts`.
Mirror the shape of `plugins/conversations/plugins/transcript-retention/server/internal/touch-job.ts:28-49`.

> **CORRECTED during implementation.** This step originally said the cron does not install in
> a release but "the boot warm-up's flush is the only durability path there". That is false:
> `warmup`'s executor skips `scope:"host"` warm-ups unless `isMain()`
> (`plugins/infra/plugins/warmup/server/internal/executor.ts:49`), exactly like
> `buildCronItems` (`jobs/.../worker.ts:66`). Both write points are `isMain()`-gated, so in a
> release there is **no durability path at all** — the archive is written in dev only.
> `captureCostHistory` gates on `isHostSingleton()`, so the flush is correct wherever it is
> reached; the fix is moving those two upstream gates to `isHostSingleton()`, deferred
> because it changes behaviour for every host-scoped warm-up and main-only cron in the repo.

**Step 8 — unpriced-model report.** New `core/index.ts` with the payload schema and
`server/internal/unpriced-model-kind.ts`, following
`plugins/debug/plugins/read-set-shrink/server/internal/read-set-shrink-kind.ts`.

**Step 9 — backup source.** New `plugins/backup/plugins/sources/plugins/cost-history/`,
modelled exactly on `.../sources/plugins/transcripts/`. Nothing currently backs up
`COST_USAGE_DIR`; `singularity-platform` covers only `auth/`, `database.json`, `crashes/`.
Copy `sessions-*.json` and the merged price table (the only record of prices for models
LiteLLM has since dropped); skip `index.json`, which is rebuildable.

**Step 10 — cleanup + docs.** Delete `ccusage-cost-source.ts` and `scripts/bulk-price.ts`;
add `scripts/verify-vs-ccusage.ts` (keeps `ccusage` as a dev-only dep). Rewrite
`plugins/stats/plugins/cost/CLAUDE.md` prose: we own pricing; the archive is permanent and
unbounded at ~25 MB/yr; the April→June 2026 gap is unrecoverable; the divergences below.
Regenerate autogen blocks via `./equin build`.

### Deferred (do not bundle)

- `handleDistribution`'s `bucketStep(maxCost)` (`handlers.ts:267`) scales to the all-time
  max, so one historical $300 session would collapse the histogram to $100 steps. Needs a
  percentile-based step. **This one genuinely gets worse with the archive.**
- `handleAvgPerConversation`'s rolling window (`handlers.ts:345-370`) is O(days²) inside a
  per-family reduce — fine at ~120 days, ~5M iterations per request at 1000+ days. Rewrite as
  a sliding accumulator.
- `handleTotals` semantics shift: `activeDays` and `sessionCount` become all-time, so
  `avgDailyCost` (`handlers.ts:152`) averages over all history. Decide if the KPI wants a
  windowed denominator.
- `isMain()` → host-singleton in `corpus-index.ts:137`, `warmup`, `jobs/worker.ts:66`.

## Known divergences from ccusage (document in CLAUDE.md)

| Divergence | Size | Direction |
|---|---|---|
| 1h cache-creation priced at its real rate | +$1,136 (+8.1%) | deliberate, we are correct |
| Cross-file dedup (ccusage is global, we are per-file) | +$56.52 (+0.404%) | accepted, we over-count |
| 1h/5m apportioning of the 200k threshold | $0 today (no Claude model is tiered) | deliberate |

The dedup gap will **grow with fork usage** — `claude --resume --fork-session` copies the
parent transcript into a new file, so every fork double-counts the parent's whole history,
permanently baked into the archive. If it drifts, the fix is to record each file's first-entry
`sessionId`/`parentUuid` in `FilePartial` so a later pass can subtract prefix copies.

## Verification

1. `./equin build`, then open `http://att-1786017041-srcw.localhost:9000` → Stats.
   Confirm charts render and the cumulative total is ~8% above today's figure.
2. `./equin test plugins/stats/plugins/cost` — both runner buckets.
3. `bun plugins/stats/plugins/cost/scripts/verify-vs-ccusage.ts` — expect the 1h-corrected
   total to exceed ccusage's by ~8%, and the 5m-only control figure to land within ~0.5%
   (the dedup gap). This is the regression gate.
4. Archive durability, the actual point of the change:
   `mv ~/.claude/projects/<a-project-dir> /tmp/`, restart the backend, reload Stats, and
   confirm the historical days and the moved project's sessions are **still present**. Move
   it back.
5. Release gate: confirm the refresh job and flush are reached with
   `SINGULARITY_RELEASE=1` and a non-`singularity` `SINGULARITY_WORKTREE`.
6. `mcp__singularity__query_db` on `_reports` after pointing the price table at a fixture
   missing a model — expect exactly one deduped `cost-unpriced-model` row, and none for
   `<synthetic>`.
7. `./equin check`.
