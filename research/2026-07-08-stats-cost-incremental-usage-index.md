# stats/cost — incremental, host-global usage index (kill the boot-parse freeze)

## Context

The `stats/cost` plugin re-parses the **entire** `~/.claude/projects` transcript
tree (today ~2,045 JSONL files / **2.3 GB**, growing with every agent session)
in-process, on the serving event loop. This is the dominant cause of the
intermittent "app takes seconds to load while nothing is running" complaint.

Three independent lines of evidence (per the perf methodology):

- **Code path.** `plugins/stats/plugins/cost/server/internal/load-usage.ts`
  builds a bundle from **two** full-tree parses: ccusage's
  `loadDailyUsageData({ groupByProject: true })` *and* our own `walkPerSession`,
  which reads every file whole (`Bun.file(...).text()`) under an **unbounded**
  `Promise.all` and `JSON.parse`s every line on the event loop. A 5-minute TTL
  cache (`TTL_MS`) triggers a *full* re-parse on any miss — there is zero
  incrementality even though virtually every file is finished/immutable history.
- **Trigger.** `plugins/stats/plugins/cost/server/index.ts` `onReady` calls
  `prewarmBundle()` on **every** backend boot with **no `isMain()` guard** — so
  main *and* every worktree agent backend each parse the whole 2.3 GB. N× the
  redundancy per host, and it competes with boot-snapshot / first page-load.
- **System/data.** `logs/health.jsonl` (Jul 7 ~23:32–23:39, main): event-loop
  freezes of 3.6 s / 9.0 s / 9.9 s / 3.1 s, `phys_footprint` spiking ~360 MB →
  2.9–3.4 GB during the churn. `logs/stall-profiles.jsonl`: 52–77 % of samples in
  every freeze attribute to ccusage `JSON.parse` / `processJSONLFileByLine`. The
  unbounded `Promise.all` loads *all* files' text into memory at once — that is
  the memory spike.

The plugin's own comment ("~1k JSONL reads") reveals it was sized for a fraction
of today's corpus; cost grows **linearly with agent usage**, so this only gets
worse.

### Root cause at three altitudes

1. **Rate (origin).** Prewarm fires on every backend, unconditionally → N×
   redundant full parses per host.
2. **Rate (origin — the real cure).** Immutable historical files are re-parsed
   from scratch on every boot and every TTL miss. Re-parsing a file that has not
   changed is *illegitimate work* (perf gate 2): the fix is to **not do it**.
3. **Cost (containment / boundary invariant).** Even a necessary cold parse
   blocks the event loop and spikes memory: unbounded `Promise.all`, whole-file
   reads, `JSON.parse` on the serving loop.

### Decisions (confirmed with user)

- **Full cure** — incremental, host-global per-file index; not just containment.
- **Reuse ccusage's real (online) cost computation, cached once per session** —
  NOT a hand-rolled pricing formula. ccusage's `PricingFetcher` is not publicly
  importable and its bundled *offline* snapshot returns **$0** for current models
  (e.g. `claude-opus-4-8`) — verified against `ccusage@18.0.11` at runtime. So the
  original "exact per-entry cost via ccusage's offline primitive" is impossible.
  Instead: **we** own the incremental token parse (pricing-free), and take the
  **per-session total cost** from ccusage's online loaders, caching it forever in
  the index so each conversation is priced exactly once.

### Cost source (revised — the load-bearing correction)

Splitting parse (ours, incremental) from pricing (ccusage's, cached):

- **We parse** every file for token data only — per-session token kinds, per
  `(date, model)` token counts, `modelsUsed`, `lastActivity`. Pricing-independent,
  so immutable files are parsed once and never re-costed even when prices move.
- **ccusage prices per PROJECT, in a throttled off-loop subprocess** (final
  design — the per-file `loadSessionUsageById` path was removed: it re-globs the
  whole 2.3 GB tree per call, ~0.6 s each, and running it on the serving loop on
  every transcript flush caused recurring ~1 s lags — wasted work re-costing a
  mid-stream session):
  - **Pricing subprocess.** `bulkProjectCosts()` spawns a throwaway bun
    subprocess (`scripts/bulk-price.ts`, mirroring the host-semaphore broker)
    that runs ccusage's `loadSessionData({ mode: "auto" })` and writes a
    `Map<projectDir, cost>` to a temp file. ccusage's own parse is unbounded
    (~5 GB, blocks its process for seconds), but it runs entirely in the child —
    the backend event loop is never touched. Result read back, temp file removed.
  - **Throttled (`ensurePriced`, 5-min TTL).** The per-project price map is cached
    on the index (`pricing: { pricedAt, projectCosts }`, persisted main-only) and
    refreshed at most once per TTL, lazily on serve — so at most one pricing
    subprocess per 5 min, never per request/flush. A failed pass still stamps the
    attempt (keeps last-good prices, rethrows) so churn can't re-spawn it.
  - **Cost decoupled from parse.** The token index refreshes live on every change
    (cheap, on-loop); a file's dollar cost is derived at **rollup** from the
    cached price map + its live token count, so a growing session's cost tracks
    without any re-pricing.
  - **Never cache $0-with-tokens.** A project ccusage couldn't price is omitted
    from the map (not stored as 0) → rollup yields 0 and the next pass retries; a
    network blip never bakes in a wrong number.
- **Rollup:** session cost = the cached exact total. Daily cost = distribute each
  session's exact total across its own `(date, model)` token buckets by token
  share. **Daily / cumulative / total costs are exact** (sum of exact session
  totals); only the model split *within a single mixed-model session-day* is
  proportional — strictly finer than today's per-*project* distribution.

This keeps a ccusage dependency at cost-compute time (online, but rare and cached)
and **eliminates the per-request / per-boot full-tree re-parse** that causes the
freeze. We do NOT reimplement ccusage's tiered/cache-aware pricing math.

## Intended outcome

Immutable transcript files are parsed **once, ever, per host**. A backend boot
(main or worktree) never re-parses history; a Cost-pane request pays only for the
handful of files touched since the last refresh. No unbounded memory spike, no
multi-second event-loop freeze — the whole class of bug is removed structurally.

## Design

### 1. Host-global incremental per-file index

The corpus `~/.claude/projects` is **host-global** (shared by every backend), so
its aggregate is identical across worktrees — the cache must be host-global too.
Per-worktree DB tables would each re-parse; a DB is the wrong home. Store the
index under `SINGULARITY_DIR` (`~/.singularity`), the existing host-global root.

**New path constant** — `plugins/infra/plugins/paths/core/internal/paths.ts`
(re-exported from `core`/`server` barrels, matching `ATTACHMENTS_DIR` etc.):

```ts
export const COST_USAGE_DIR = join(SINGULARITY_DIR, "cost-usage"); // host-global
```

**New module** `plugins/stats/plugins/cost/server/internal/usage-index.ts`:

- **Index file** `COST_USAGE_DIR/index.json`, written atomically (temp + rename):
  `Record<filePath, { mtimeMs: number; size: number; partial: FilePartial }>`.
  `FilePartial` is the per-file **token** aggregate plus the cached cost:
  - session-level: `{ sessionId, projectDir, totalTokens, inputTokens,
    outputTokens, cacheCreationTokens, cacheReadTokens, cost, lastActivity,
    modelsUsed }` (one per file); `cost` is the ccusage per-session total, cached
    (see Cost source) — `null`/absent until priced.
  - day-level: `Array<{ date, modelName, inputTokens, outputTokens,
    cacheCreationTokens, cacheReadTokens }>` — this file's `(date, model)` **token**
    buckets. No cost stored here; the daily rollup derives per-`(date,model)` cost
    by distributing the session total by token share.
- **`refreshIndex()`** — the incremental core:
  1. Enumerate files (`readdir` the project dirs as today, or `globUsageFiles`).
  2. `stat` each; diff `(mtimeMs, size)` against the cached fingerprint. Historical
     files are unchanged → **skipped**. A live session's file grows → its one
     entry is re-parsed. Deleted files → dropped from the index.
  3. Parse **only** new/changed files through a **bounded** pipeline (see §3) for
     token data (no pricing). Then price the changed sessions via ccusage online
     (`loadSessionUsageById` per changed session; one `loadSessionData()` for a
     cold seed of many) and store the per-session total in the partial. **Never
     persist a `$0` cost for a session that has tokens** — treat as unpriced, retry.
  4. Write the index atomically. **Only `isMain()` writes**; non-main backends
     compute any delta in-memory for a correct response but never persist (avoids
     cross-process write races — one writer, shared readers).
- **`rollup(index)`** — fold cached partials into `{ daily, sessions }` purely in
  memory. Cheap: aggregation over ~2,000 small records, no I/O, no parsing.

### 2. Refactor `load-usage.ts`

- `loadBundle()` → load index from disk (once per process, then in-memory),
  `await refreshIndex()` (incremental, cheap), then `rollup()`. Assemble
  `{ daily, sessions, projectIsSingularity, convBySession }` as today.
- **Remove** the `loadDailyUsageData` call and the proportional-cost logic in
  `walkPerSession` / `aggregateOneFile`; `daily` and per-session `cost` now come
  from the exact-cost partials.
- Keep `classifyProjects` (cheap `readdir`) and `loadConvBySession` (cheap DB
  read) unchanged.
- **Replace the 5-minute TTL** with a push-based freshness signal (repo rule: no
  polling). A **main-only `@parcel/watcher`** on `CLAUDE_PROJECTS_DIR` (via
  `plugins/infra/plugins/file-watcher`) marks the index dirty; the next
  `refreshIndex()` (on request, or debounced from the watcher) picks up the delta.
  On-demand incremental refresh is the correctness fallback; the watcher just
  keeps it warm without a timer.
- `handlers.ts`: replace the `import type { DailyUsage } from "ccusage/data-loader"`
  with a local `DailyRow` type (same fields the handlers read: `date`, `project`,
  `modelBreakdowns[{modelName,cost}]`, token kinds, `totalCost`). No handler
  *logic* changes — they consume the same bundle shape.

### 3. Never block the event loop (boundary invariant)

Even the cold parse of new files must not wedge the loop or spike memory:

- Bound per-process concurrency to a small K (e.g. `packages/semaphore` or a
  simple pool) instead of `Promise.all` over all files → caps resident memory to
  ~K files' text, killing the 3.4 GB spike.
- Admit heavy reads through `withHeavyReadSlot`
  (`plugins/infra/plugins/host-read-pool`) so N backends don't collectively
  saturate host CPU/IO.
- Yield between batches so request serving interleaves.

This makes it structurally impossible for a large corpus to freeze the loop
again — a bigger corpus just takes longer in the background.

### 4. `server/index.ts` onReady

- Remove the unconditional `prewarmBundle()`. Warm **main-only**, off the
  boot-critical path: `onReady: () => { if (isMain()) prewarmBundle(); }` (import
  `isMain` from `@plugins/infra/plugins/paths/server`). After the first host warm
  the refresh is incremental and trivial, so this no longer competes with boot.

## Critical files

- `plugins/stats/plugins/cost/server/index.ts` — gate prewarm with `isMain()`.
- `plugins/stats/plugins/cost/server/internal/load-usage.ts` — rewrite bundle to
  read the index + incremental refresh + rollup; drop `loadDailyUsageData` and
  proportional cost; replace TTL with watcher-based freshness.
- `plugins/stats/plugins/cost/server/internal/usage-index.ts` — **new**: the
  incremental index (fingerprints, token parse, ccusage-cost caching, atomic
  persist, rollups).
- `plugins/stats/plugins/cost/server/internal/handlers.ts` — swap the ccusage
  `DailyUsage` type for a local `DailyRow`; logic unchanged.
- `plugins/infra/plugins/paths/core/internal/paths.ts` (+ `core`/`server`
  barrels) — add `COST_USAGE_DIR`.

## Reused primitives

- `ccusage/data-loader` for **cost only**: `loadSessionData()` (cold seed — all
  sessions' correct online totals in one call) and `loadSessionUsageById(id,
  { mode })` (incremental per-changed-session). NOTE: `PricingFetcher` is **not**
  publicly exported and its offline snapshot returns `$0` for current models —
  verified at runtime against `ccusage@18.0.11`; do not attempt to import it.
- `isMain` — `@plugins/infra/plugins/paths/server`.
- `withHeavyReadSlot` — `@plugins/infra/plugins/host-read-pool/server`.
- `@parcel/watcher` via `@plugins/infra/plugins/file-watcher` — push-based
  freshness (replaces the TTL poll).
- `SINGULARITY_DIR` — host-global root, `@plugins/infra/plugins/paths/*`.

## Nuances / correctness to preserve

- **Token dedup.** Our own token parse should match ccusage's counting (Claude
  occasionally writes duplicate message records). Cost totals come from ccusage
  directly (already deduped), so only our *token* buckets need care; dedup within
  a file is the dominant case. Minor cross-file token-dup divergence is acceptable
  since cost (the headline number) is authoritative from ccusage.
- **Cost mode.** Use `"auto"` (ccusage default, online) for `loadSessionData` /
  `loadSessionUsageById`. Guard against the silent-`$0` result: never persist a
  session cost of 0 when its tokens are > 0.
- **Empty/corrupt lines.** Keep the existing `SyntaxError`-tolerant per-line
  parse; a malformed line is skipped, not fatal.
- **Index schema version.** Stamp the index with a `version` field; on a version
  bump, ignore the old file and rebuild (one-time full parse).

## Verification (end-to-end)

1. `./equin build` from the worktree; open
   `http://att-1783506813-hvhk.localhost:9000` → Stats → Cost pane; confirm all
   charts render and totals are sane (exact cost will differ *slightly* from the
   old proportional numbers — expected).
2. **Cold vs warm.** Delete `~/.singularity/cost-usage/index.json`, restart main,
   hit the Cost endpoints once (cold warm — full parse, but bounded/yielding),
   then again (incremental — should be sub-100 ms). Confirm via `runtime-profiler`
   / a temporary timing log, or the `benchmark_boot` MCP tool.
3. **No freeze.** After a main restart, tail `logs/health.jsonl` and
   `logs/stall-profiles.jsonl`: `phys_footprint` should stay bounded (no 3 GB
   spike) and there should be **no** multi-second event-loop freeze attributed to
   ccusage/`JSON.parse`.
4. **No worktree redundancy.** Boot a worktree backend and confirm its
   `logs/health.jsonl` shows **no** cost-parse memory/CPU spike (prewarm is
   main-only; the worktree reads the shared index).
5. Add a focused `bun:test` for `usage-index.ts` against a tiny fixture dir:
   assert (a) unchanged fingerprint → 0 files re-parsed, (b) a grown file →
   exactly 1 re-parsed, (c) rollup totals match a from-scratch parse.

## Follow-ups (surface, don't memorize)

- The unconditional prewarm was a footgun (an `onReady` that does heavy host-wide
  I/O with no `isMain()` guard). Consider a lint/check that flags heavy I/O in
  `onReady` without an `isMain()` gate, so the class can't recur in other plugins.
