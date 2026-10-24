# Plan: implement the structure-only `buildPluginTree` cure + re-validate

**Date:** 2026-06-30
**Category:** perfs
**Status:** **Altitude 2 (fast aggregate algorithm) IMPLEMENTED & validated on the worktree** (not yet on
`singularity`/main — needs a push). Altitude 1 (structure-only hot path + client-derived disabled) and
the follow-ups remain to do.
**2026-07-10 verification: both altitudes landed on main as `978a1d621` (2026-07-02)** — the
"needs a push" notes in this doc are stale. Post-merge re-validation on `singularity` not yet recorded.

## Altitude 2 — IMPLEMENTED & VALIDATED (2026-06-30, worktree `att-1782849943-zcr0`)

The facet-build algorithm was made fast + non-blocking via an async, parallel, read-once in-memory FS
snapshot (`fs-snapshot.ts`) consulted by `parse-utils` `readIfExists`/`walkFiles` through an ambient set
synchronously around each (sync) `extract`/`relate` call; `setImmediate` yields between node chunks and
relate facets. **Output byte-identical** (proven: snapshot-path vs disk-path over all 842 plugins incl.
relate reverse-indexes → same sha256). `./equin build` green.

**The win is the production metric — max contiguous event-loop block:**

| Condition | metric | BASELINE (sync) | AFTER (snapshot) |
|---|---|---|---|
| warm, quiet | max loop block | 2399 ms | **465 ms** |
| cold FS, loaded | max loop block | **49 808 ms** | **~1500 ms** |
| cold FS, loaded | wall | 50 542 ms | ~6–11 s |

**End-to-end victim test (deployed worktree endpoint):** during an **8.15 s** `GET /api/plugin-view/tree`
build, concurrent `GET /api/health/ready` calls stayed **0.6–75 ms** (not queued behind it); worktree
`health.jsonl` event-loop max in the window **~270–309 ms** (the residual = the largest single facet's
`relate` regex CPU, bounded by the yields). Pre-fix those concurrent calls were the ~10–46 s victims.

**Residual & why Altitude 1 is still required:** the hot endpoint is still **uncached and still full-facet**,
so a cold call is ~6–11 s wall and can 502 on the gateway proxy timeout under contention — but it no longer
*freezes other requests*. Altitude 1 (structure-only default + cached accessor) removes the facet work from
the hot path entirely (→ ms) and is unchanged by this. Files changed by Altitude 2: `plugin-tree`
(`fs-snapshot.ts`, `plugin-tree.ts`), `parse-utils` (`helpers.ts`, `index.ts` — new `runWithFsSnapshot` /
`FsSnapshot`), `facets/core/facets.ts` (`ExtractContext.fs?`).

**Caveats (surfaced by the implementing agent):** `ExtractContext.fs` is effectively documentation-only
(facets read via the ambient through the helpers, not `ctx.fs` directly); the snapshot is built
unconditionally (a net build speedup, output-identical) rather than flag-gated; a few cheap direct
`readdirSync`/`existsSync` dir-listing/stat calls (db-schema `findDbFiles`, structure, cross-refs guards)
remain on disk — they are not the 10.6 MB content-read cost.

---

**Predecessors (read these):**
[`2026-06-29-perfs-buildplugintree-eventloop-block-FIX.md`](./2026-06-29-perfs-buildplugintree-eventloop-block-FIX.md) (the design this implements + corrects)
· [`2026-06-29-conversation-load-40s-eventloop-block-HANDOFF.md`](./2026-06-29-conversation-load-40s-eventloop-block-HANDOFF.md)
· [`2026-06-29-perfs-stall-stack-flight-recorder.md`](./2026-06-29-perfs-stall-stack-flight-recorder.md) (the instrument).

---

## Context

"Loading a conversation on main takes 40+ s." Prior sessions peeled the symptom past DB-pool
exhaustion, the git heavy-read gate, and the fan-out herd (all victims/triggers) to its real layer:
the main (`singularity`) backend's **single event loop monopolized by one synchronous CPU op for
10–46 s**, dozens of times a day; the conversation loaders are victims queued behind it. The on-stall
JSC flight recorder named the hotspot: **`buildPluginTree`** — a synchronous `node × facet`
`readFileSync` walk over **4408 source files / 10.6 MB**, run **uncached** on `GET /api/plugin-view/tree`.

**Re-validated live this session (not inherited):**
- `get_runtime_profile` on `singularity`: `GET /api/plugin-view/tree` **max 15 635 ms, workMs 8247**
  (~100 % work, negligible waits) — a real in-process block.
- Stall recorder (`logs/stall-profiles.jsonl`, 93 captures): most recent = `readFileSync ←
  parsePaneDefinitions ← extract ← buildPluginTree`, `eventLoopMaxMs 14 564`, `sampleRateHz 164`
  (real JS block, not CPU starvation). Aggregated, the buildPluginTree family
  (`extract`/`relate`/`maskSource ← buildPluginTree`) is **13 blocks, up to 54 s** — the largest
  per-occurrence stall.

**Why not just cache it (cost-axis escape).** Caching makes the 15–46 s op *sometimes not run*; it
still runs cold on every boot (main restarts ~20×/day), eviction, and edit. The work itself is
**unnecessary on the hot path**, so the cure is to not do it — not to cache it.

**The over-extraction (the origin).** `handleTree` builds **all 9 facets** (4 of which `readFileSync`-
walk every source file) **plus `classifyEdges`/`disabledClosure`**, but its hot callers discard the
result:

| Consumer of `getPluginTree` | Frequency | Actually needs |
|---|---|---|
| `active-data/plugin-link` chips | every conversation with a `<plugin>` chip | `description` + id resolution only |
| `config_v2/settings/config-nav` | Settings (always-on) | structure only — builds its own `facets:{}` |
| `apps/studio/explorer` tree | Studio open | structure **+ `disabled` cascade badge** |
| `apps/studio/contributions` tab | Studio open (rare) | **all facets, all plugins** (genuine) |
| `plugin-meta/plugin-view` detail pane | plugin click (rare) | **facets for one plugin, incl. `importedBy`** |

Three of five callers — the always-on ones — need only the cheap async structural skeleton (steps
1–3 of `buildPluginTree`). Only Contributions and the detail pane genuinely read facets.

### Two corrections to the prior design (found by re-validation, not inheritance)

1. **❌ "explorer renders no `disabled`."** Wrong. `apps/studio/explorer/plugins/disabled`
   (`disabled-badge.tsx`) renders `node.disabled` / `node.disabledSeed` ("Disabled" / "Disabled
   (cascade)"). The cascade comes from `classifyEdges` (reads the `cross-refs`/`slots`/`contributions`
   facets) → `disabledClosure`. So a structure-only tree that drops `disabled` **breaks the explorer
   badge**. → **Fix:** derive the cascade **client-side** from the composition edge graph (mirrors how
   `explorer/membership` already derives membership via `useEnsureCompositionData`/`useGraph`).
2. **❌ "per-plugin facets for the detail pane."** Wrong. The cross-refs detail section
   (`cross-refs-detail-section.tsx`) reads **`importedBy`**, a reverse index `relate()` builds by
   inverting `apiUses` across **all** plugins. A single-plugin extraction yields `importedBy: []`. →
   **Fix:** the detail pane must read from the **full relate'd aggregate**, shared with Contributions —
   not a per-plugin slice.

---

## Design — structure-only hot path, one cached+yield aggregate for the two facet consumers

### 1. `buildPluginTree` gains a `facets` flag (default off)
`plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`
- `buildPluginTree(root, { skipBarrelImport?, facets?: boolean })`. Gate **Step 4a (barrel import)**,
  **4b (extract)**, and **4c (relate)** behind `facets` (default `false`). Structure-only = steps 1–3
  (`findAllPluginDirs` + `collectCoreFields` + assembly) — all already async, no `readFileSync`.
- `collectCoreFields` already populates `disabledSeed` (from `package.json singularity.disabled`) and
  every structural field — so structure-only loses **nothing** the hot callers need.
- Build-time callers that need facets (`tooling/{boundaries,checks,codegen}`, `closure`,
  `composition/data-handler`) pass `{ facets: true }` explicitly — unchanged behavior.

### 2. Hot endpoint → structure-only + cached accessor
`plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts`
- Drop `classifyEdges` + `disabledClosure`. Build structure-only via a new cached accessor.
- **New server barrel** `plugin-meta/plugins/plugin-tree/server/` exporting `getStructureTreeCached()`:
  a watcher-invalidated `createGitStateMemo` (reuse `infra/git-read-cache`) keyed by a monotonic
  generation bumped by a debounced `createFileWatcher` on `PLUGINS_DIR` (`reconcileMs: null`, push-only;
  ignore `node_modules`/`.git`). Single-flight coalesces the post-boot herd onto one cheap build.
  Mirror `review/plugins/plugin-changes/server/internal/plugin-tree-cache.ts`.
  *(Caching is now legitimate: it coalesces **necessary, cheap** structural work — not the eliminated
  facet walk.)*

### 3. Payload: `disabled` becomes client-derived
`plugin-meta/plugins/plugin-view/core/types.ts` + `core/endpoints.ts`
- Remove `disabled` (the cascade) from `PluginNode`/`pluginTreePayloadSchema`; **keep `disabledSeed`**
  (cheap, structural). Removing the always-`false`-on-hot-path field is honest — the cascade is derived
  state, not structural identity (consistent with facets/CLAUDE.md's "structural identity only" rule).
- `apps/studio/explorer/plugins/disabled` (`disabled-badge.tsx`): compute the cascade client-side with
  `disabledClosure(seeds, graph)` (`plugin-meta/closure/core`, browser-safe) where `seeds` = nodes with
  `disabledSeed`, `graph` = the composition edge graph (`useGraph()` + `useEnsureCompositionData()` from
  `plugin-meta/composition/web`). Seed-only "Disabled" still paints before the graph loads.

### 4. Aggregate facet endpoint — **make the path fast (algorithmic root fix), not just chunked**
`plugin-meta/plugins/plugin-view` (server + core) — new `getPluginFacetsTree` endpoint serving the
**full relate'd faceted tree** to the two genuine consumers, cached via the same watcher-generation memo.

**Why this is needed even though the hot path is eliminated:** making the facet build *fast* does NOT
remove the need for structure-only — the hot callers fundamentally don't consume facets, so running even
a 1–2 s build (and shipping the full faceted payload) on every chip mount / herd reconnect still fails
the legitimacy gate. Structure-only (eliminate) and a fast aggregate (do-it-well) are **complementary
root fixes at two altitudes**, not alternatives.

**The current algorithm is the actual root of the per-call cost** — three compounding wastes, all in the
synchronous `node × facet` extract loop:
1. **Redundant re-reads.** Each of the 4 file-walking facets independently `walkFiles` (`readdirSync`) +
   `readIfExists` (`existsSync`+`readFileSync`) + `maskSource`/`stripTypes` over overlapping file sets →
   each source file is walked/read/masked **~4×**.
2. **Blocking syscalls.** All reads are **synchronous** (`parse-utils/core/helpers.ts`) → tens of
   thousands of blocking syscalls, each slow under cold FS cache + host IO contention (the 10 s→46 s swing).
3. **No parallelism.** Sync reads can't overlap; the OS can't prefetch.

**The fix — read-once, async, parallel, in-memory; then sync CPU extract:**
- **Build-scoped in-memory FS snapshot.** Before extraction, one **async parallel** pass reads every
  needed source file once into `{ files: Map<path,string>, dirs: Map<path, Dirent[]> }` via async
  `readFile`/`readdir` + `Promise.all` (OS-saturating, non-blocking, one read per physical file).
- **Thread it via `ExtractContext.fs?`** (facets/core). `parse-utils` `readIfExists` / `walkFiles` consult
  the snapshot when present, else fall back to sync disk — so **build-time callers (codegen/checks) are
  untouched** and facet bodies barely change (they keep calling the same helpers). This is a build-scoped
  read **cache**, which correctly handles `routes` reaching into other plugins' dirs (a per-plugin
  pre-read could not).
- **Extract stays sync but touches zero disk** → the loop is fast regex-over-memory; a `setImmediate`
  yield every ~16 nodes is now a **CPU safety belt**, not the primary mechanism.
- Net: IO once + parallel + async (sub-second warm, a few seconds cold but **non-blocking**); CPU
  de-duplicated ~4×. Genuinely fast, not merely chunked.
- Migrate **both** facet consumers to the endpoint (they already read `node.facets[id]`):
  - `apps/studio/contributions/web/components/contributions-view.tsx`
  - `plugin-meta/plugins/plugin-view/web/panes.tsx` (detail pane — keeps `importedBy` correct).

### 5. `composition/data-handler` — explicit `{ facets: true }`
`plugin-meta/plugins/composition/server/internal/data-handler.ts` already module-caches; just pass
`{ facets: true }` so `classifyEdges` still has cross-refs. (Optional: route through the shared cached
accessor — keep minimal; out of scope unless trivial.)

### Out of scope (filed, not built) — see Follow-ups
`listActiveWorktreeOps` sync `readdirSync`, stats `aggregateOneFile`, JSONL parse, herd levers B′/C.

---

## Files

| File | Change |
|---|---|
| `plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | `facets?` flag gates 4a/4b/4c; async FS-snapshot pre-read before 4b; `setImmediate` yield in 4b |
| `plugin-meta/plugins/plugin-tree/core/internal/fs-snapshot.ts` | **new** — async parallel `{files,dirs}` reader for the aggregate build |
| `plugin-meta/plugins/facets/core/facets.ts` | `ExtractContext` gains optional `fs?` snapshot |
| `plugin-meta/plugins/parse-utils/core/helpers.ts` | `readIfExists`/`walkFiles` consult `ctx.fs` snapshot when present (sync-disk fallback unchanged for build-time) |
| `plugin-meta/plugins/plugin-tree/server/index.ts` | **new** barrel — `getStructureTreeCached` (+ default def) |
| `plugin-meta/plugins/plugin-tree/server/internal/plugin-tree-cache.ts` | **new** — watcher-generation memo |
| `plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` | structure-only via cached accessor; drop classify/closure |
| `plugin-meta/plugins/plugin-view/server/internal/facets-handler.ts` | **new** — cached+yield aggregate facet tree |
| `plugin-meta/plugins/plugin-view/server/index.ts` | register new endpoint handler |
| `plugin-meta/plugins/plugin-view/core/endpoints.ts` | **new** `getPluginFacetsTree`; structure schema drops `disabled` |
| `plugin-meta/plugins/plugin-view/core/types.ts` | `PluginNode`: drop `disabled`, keep `disabledSeed` |
| `plugin-meta/plugins/plugin-view/web/panes.tsx` | detail pane → `getPluginFacetsTree` |
| `apps/studio/plugins/contributions/web/components/contributions-view.tsx` | → `getPluginFacetsTree` |
| `apps/studio/plugins/explorer/plugins/disabled/web/components/disabled-badge.tsx` | client-side `disabledClosure` from composition graph |
| `plugin-meta/plugins/composition/server/internal/data-handler.ts` | pass `{ facets: true }` |
| `plugin-tree` / `plugin-view` `CLAUDE.md` | note new server barrel + endpoint (autogen blocks refresh on build) |

**Reuse:** `createGitStateMemo` (`infra/git-read-cache/server`), `createFileWatcher`
(`infra/file-watcher/server`), `withHeavyReadSlot` (`infra/host-read-pool/server`), `PLUGINS_DIR`
(`infra/paths/server`), `disabledClosure`/`classifyEdges` (`plugin-meta/closure/core`),
`useGraph`/`useEnsureCompositionData` (`plugin-meta/composition/web`).
**Precedent to mirror:** `review/plugins/plugin-changes/server/internal/plugin-tree-cache.ts`.

## Risks
- **Boundaries:** new server barrel + endpoint must pass `./equin check plugin-boundaries`
  (legal barrels, no re-export, DAG: `plugin-tree/server → infra/*/server + own core`).
- **Type-check:** removing `PluginNode.disabled` is a compile-time fence — every reader surfaces. Audit
  shows only `disabled-badge.tsx` (runtime) reads it; build-time `codegen/disabled-ids.ts`/`docgen.ts`
  read the **core** `PluginNode.disabled` (the seed on the internal tree, unchanged) — verify they
  build with `{ facets: true }` and are untouched by the **payload** type change.
- **Watcher:** singleton via module-level `??=`; `reconcileMs: null` + `events.length > 0` guard so it
  never invalidates idly.
- **disabled cascade timing:** explorer badge now depends on composition data; seed-disabled paints
  immediately, cascade paints when the graph resolves (acceptable; matches membership).
- **FS-snapshot correctness (algorithmic fix):** the snapshot is built per-aggregate-build (invalidated
  by the same watcher generation), so it can't go stale. `parse-utils` helpers must consult `ctx.fs`
  **only when present** — build-time callers (codegen/checks) pass no snapshot and keep the sync-disk
  path byte-for-byte. Verify a facet that reaches cross-plugin (`routes`) reads via the shared snapshot,
  not a per-plugin map. Blast radius: `ExtractContext` + 2 parse-utils helpers; facet bodies unchanged.

## Verification (end-to-end, on `singularity`)
1. `./equin build`; confirm boot (new barrel + endpoint register; no boundary/cycle/type failure).
2. **Block vanishes:** hit `GET /api/plugin-view/tree` → `get_runtime_profile` shows it drop from
   ~15 s to **ms**, ~100 % within steps 1–3 (no `extract`/`relate`).
3. **Recorder clean:** watch `logs/stall-profiles.jsonl` across a cold build — **no new
   `… ← buildPluginTree` stack** (falsifiable prediction: prior captures kept naming it; new ones must
   not).
4. **Victims unblocked:** `allow-files` / `viewed` no longer post ~10 s timestamps right behind a tree build.
5. **Correctness:** explorer "Disabled"/"Disabled (cascade)" badges still correct; Studio Contributions
   tables populated; plugin detail pane shows facets **including "imported by"**; plugin chips + Settings
   config-nav unchanged.
5b. **Aggregate path is fast (algorithmic fix):** cold `GET /api/plugin-view/facets-tree` completes in a
   few seconds **non-blocking** (no contiguous multi-second `eventLoopMaxMs` spike in `health.jsonl`
   during the build); warm/cached = ms. Confirms the build no longer monoblocks even though it does real
   facet work.
6. **Next stall surfaces:** after the fix, the recorder's dominant stack should become
   `listActiveWorktreeOps` (predicted) — confirm and triage via the filed task.

## Follow-ups to file (MCP `add_task`) — NOT in this change
- **`listActiveWorktreeOps` sync `readdirSync` in the flush cycle** — 27 blocks/window, ~6 s avg, 9.3 s
  max; `infra/worktree/server/internal/worktree-op.ts:151,168,182`, via the op-status live-state loader
  (`conversations/.../op-status/server/internal/resource.ts`) inside `flushNotifies`. Predicted #1 block
  post-fix. Make the loader async / off the flush critical path.
- **stats `aggregateOneFile` + JSONL `processJSONLFileByLine`** — mid-tier synchronous parse blocks.
- **Herd de-amplification (levers B′/C)** — reconnect jitter + resubscribe stagger + sub admission cap;
  coalesce/debounce auto-builds (cut ~20×/day main restarts). File under **`issue-cold-boot-fanout.md`**
  (they amplify every post-boot block, not just this one).

---

## Altitude 1 — concrete implementation plan (2026-07-01, worktree `att-1782924979-2mnf`)

Grounded in a full re-read of the live code + an exhaustive caller audit. **Both corrections re-confirmed
at the code level** (disabled-badge reads `node.disabled`/`disabledSeed`; cross-refs detail reads
`importedBy`). Two *new* findings from this session's audit change the plan:

### New finding 1 — a THIRD faceted consumer the design missed
The design lists only Contributions + `plugin-view/web/panes.tsx` as faceted. But
`active-data/plugins/plugin-link/web/panes.tsx` (`pluginConvSidePane`, opened when a `<plugin>` chip is
clicked) renders `<PluginDetail node={node}/>` → `<PluginView.Host>` → **every** `PluginViewSlots.Section`
(cross-refs, contributions, …) which read `node.facets[id]`. If it stays on the structure-only endpoint the
pane's facet sections silently render nothing. → **It must migrate to the faceted endpoint too.** (The inline
plugin-link *chip* — `plugin-link-chip.tsx` — reads only `id` + `description`, so it stays on the hot
structure-only endpoint; that is the frequent path we are protecting.)

### New finding 2 — the `disabled` cascade is served from the composition endpoint, not recomputed client-side
The design says "derive the cascade client-side with `disabledClosure(seeds, graph)`." Refinement (same
altitude — off the hot path — but cleaner): the cascade is **process-invariant, composition-independent**
repo-derived data, and the `GET /api/composition/data` endpoint the explorer *already* fetches (every row
calls `useEnsureCompositionData()` for the membership tint) **already runs `classifyEdges` and already ships
a derived id list (`allIds`)**. So compute `disabledClosure(seeds, classifyEdges(tree))` there once and ship
`disabledIds` alongside `allIds` — one extra line, zero client CPU, no per-row `disabledClosure` recompute,
consistent with the endpoint's existing shape. The badge reads a `Set` from it. This keeps the expensive
work off the hot `/api/plugin-view/tree` path (the audit's real concern) exactly as the doc intends; it just
computes the closure on the already-cached composition endpoint instead of in N tree-row components.
*(Seed-disabled still paints immediately from the kept `node.disabledSeed`; the cascade paints when the
composition fetch resolves — same progressive behavior the doc wanted.)*

### `facets` flag semantics (orthogonal to `skipBarrelImport`)
`buildPluginTree(root, { skipBarrelImport?, facets?: boolean })`, `facets` default **false**:
- **4a** barrel import runs when `facets && !skipBarrelImport` (unchanged condition, now also gated on facets)
- **4b** extract + **4c** relate (incl. `loadFacets` + `buildFsSnapshot`) run when `facets`
- structure-only (`facets:false`) = steps 1–3 only; `tree.facets=[]`, every `node.facets={}`.

### Definitive caller audit → who passes `{ facets: true }`
**NEEDS `facets:true`** (preserve each one's existing `skipBarrelImport`): `checks/composition-closure`,
`checks/apps-paths-from-app-ref`, `codegen/docgen.ts` `buildEnrichedTree` **and** `buildBarrelFreeTree`
(the two shared per-root memo wrappers — gate at the wrapper, *not* per caller; note `buildEnrichedTree`
currently passes **no opts** and so must switch to `{ facets: true }` or docgen breaks),
`cli/bin/commands/build.ts:741`, `closure/core/closure.test.ts`, `composition/server/data-handler.ts`,
`review/plugin-changes` `plugin-tree-cache.ts` (×2) + `handle-plugin-changes.ts` (×2).
**Structure-only is correct (no change, and now cheaper)** — all verified to never read `node.facets`:
`config_v2/check`, `checks/{fix-shared-to-relative, no-reexport-default, plugins-have-claudemd,
plugin-refs-resolve, plugin-boundaries, pre-barrel-manifests-complete}`, `boundaries/core/check.ts`,
`cli/release.ts`, `facets/check`.

### File changes
| # | File | Change |
|---|---|---|
| 1 | `plugin-tree/core/internal/plugin-tree.ts` | add `facets?` to opts; gate 4a on `facets && !skipBarrelImport`; gate 4b+4c (incl. `loadFacets`/`buildFsSnapshot`) on `facets` |
| 2 | `plugin-tree/server/internal/structure-tree-cache.ts` | **new** — one module generation counter + one lazy `createFileWatcher(PLUGINS_DIR, {reconcileMs:null, ignore node_modules/.git})` bumping it; two `createGitStateMemo` instances (`plugin-tree.structure`, `plugin-tree.facets`) keyed on `PLUGINS_DIR`, signature = generation; `computeFn` owns `withHeavyReadSlot`. Exports `getStructureTreeCached()` (structure-only) + `getFacetsTreeCached()` (`{skipBarrelImport:true, facets:true}`) |
| 3 | `plugin-tree/server/index.ts` | **new** barrel — re-export both accessors + `default {description}` |
| 4 | `plugin-view/core/types.ts` | `PluginNode`: drop `disabled` (cascade); keep `disabledSeed` |
| 5 | `plugin-view/core/endpoints.ts` | drop `disabled` from `pluginNodeSchema`; add `getPluginFacetsTree` (`GET /api/plugin-view/facets-tree`, same payload schema) |
| 6 | `plugin-view/core/index.ts` | export `getPluginFacetsTree` |
| 7 | `plugin-view/server/internal/tree-handler.ts` | structure-only via `getStructureTreeCached()`; drop `classifyEdges`/`disabledClosure`; `toApiNode` drops `disabled` |
| 8 | `plugin-view/server/internal/facets-handler.ts` | **new** — `getFacetsTreeCached()` → faceted payload (facets populated, `disabledSeed` kept, no cascade) |
| 9 | `plugin-view/server/index.ts` | register both routes |
| 10 | `composition/core` (endpoints/types) | `CompositionData` + schema gain `disabledIds: PluginId[]` |
| 11 | `composition/server/internal/data-handler.ts` | source tree via `getFacetsTreeCached()` (drops its bespoke module cache, single shared faceted build); compute + ship `disabledIds = disabledClosure(seeds, classifyEdges(tree))` |
| 12 | `composition/web` | add + export `useDisabledClosure(): Set<PluginId> \| null` (from `getCompositionData().disabledIds`) |
| 13 | `explorer/plugins/disabled/web/components/disabled-badge.tsx` | `useEnsureCompositionData()` + `useDisabledClosure()`; show when `node.disabledSeed \|\| set?.has(node.id)`; label from `disabledSeed` |
| 14 | `apps/studio/plugins/contributions/web/components/contributions-view.tsx` | `getPluginTree` → `getPluginFacetsTree` |
| 15 | `plugin-view/web/panes.tsx` | → `getPluginFacetsTree` |
| 16 | `active-data/plugins/plugin-link/web/panes.tsx` | → `getPluginFacetsTree` (**the missed 3rd consumer**) |
| 17 | `config_v2/plugins/settings/web/components/config-nav.tsx` | orphan-fallback `PluginNode`: drop `disabled: false` (type fence) |
| 18 | 10 build-time callers above | add `{ facets: true }` (preserving `skipBarrelImport`) |
| 19 | `plugin-tree`/`plugin-view` `CLAUDE.md` | note new server barrel + endpoint (autogen refresh on build) |

### Verification (on `singularity`, after `./equin build`)
1. Boot green (new barrel + endpoint register; no boundary/cycle/type failure).
2. `GET /api/plugin-view/tree` → `get_runtime_profile` drops ~15 s → **ms**, no `extract`/`relate`.
3. `logs/stall-profiles.jsonl` across a cold build: **no new `… ← buildPluginTree` stack**.
4. Victims (`allow-files`/`viewed`) no longer post ~10 s timestamps behind a tree build.
5. Correctness: explorer "Disabled"/"Disabled (cascade)" still correct; Contributions tables populated;
   plugin detail pane (both `plugin-view` pane **and** the plugin-chip side pane) shows facets incl.
   "imported by"; plugin chips + Settings config-nav unchanged.
6. Faceted path fast+non-blocking: cold `GET /api/plugin-view/facets-tree` a few seconds non-blocking
   (no multi-second `eventLoopMaxMs` in `health.jsonl`); warm = ms.

### Risks / fences
- Removing `PluginNode.disabled` is a **tsc fence** — every reader/constructor surfaces (known: `disabled-badge.tsx` reader, `config-nav.tsx` + `tree-handler.ts` constructors). Grep `disabled:` during impl to confirm none missed.
- Boundaries: `plugin-tree/server` (new) → `infra/*/server` + own `core` only; `composition/server` → `plugin-tree/server`; `disabled` badge → `composition/web` (mirrors `membership`). All legal barrels, DAG preserved.
- Watcher: module-singleton via `??=`; `reconcileMs:null` + `onChange` fires only on real events ⇒ never invalidates idly.

### Altitude 1 — IMPLEMENTED & VALIDATED on the worktree (2026-07-01, `att-1782924979-2mnf`)
Landed via 3 Opus workstreams; `./equin build` green — **all 60 checks pass** (incl. `type-check`,
`plugin-boundaries`, `composition-closure`, `apps-paths-from-app-ref`, `plugins-doc-in-sync`,
`plugins-registry-in-sync`, `facets:render-complete`). Live-validated on the deployed worktree endpoint
(`get_runtime_profile`, in-process handler spans — wall times were inflated by boot-recovery + gateway
queueing under host **load 30–42 / 18 CPUs**, a separate cold-boot-fanout condition):

| endpoint | before | after (cold / warm) | notes |
|---|---|---|---|
| `GET /api/plugin-view/tree` (**hot**) | ~15 s, uncached, full-facet | workMs **382**, max **1.1 s** cold / **3.3 ms** warm | structure-only; **no `extract`/`relate`**; `git-memo-hit` warm |
| `GET /api/plugin-view/facets-tree` (rare) | — | ~13.9 s cold / **0.48 ms** warm | full facets, single-flight, cached; cold 502s under load — rare path only |
| `GET /api/composition/data` | rebuilt tree itself | **84 ms** (`git-memo-hit:plugin-tree.facets`) | reused the shared faceted build — no duplicate walk |
| `GET /api/health/ready` | victim (10–46 s) | max **0.32 ms** *during the 13.9 s faceted build* | non-blocking confirmed (Altitude-2 fs-snapshot holds) |

- **Falsifiable prediction met:** `logs/stall-profiles.jsonl` has **zero captures since boot** — the
  `… ← buildPluginTree` event-loop stall is gone.
- **Correctness (data-level):** structure payload carries `disabledSeed`, **no `disabled` cascade key**,
  `facets:{}`; faceted payload populates facets on all 849 nodes with **`cross-refs.importedBy` on 339 nodes**
  (e.g. `active-data` ← attempt/conv/plugin-link — correction #2 holds); composition ships `disabledIds`=**12**
  = `review.plugin-changes` (the sole `singularity.disabled` seed) + its subtree + its `render-diff` importers
  (correction #1 — cascade correct).
- **Still on the worktree only — NOT `singularity`/main (needs a push the user must approve).** The plan's
  "re-validate on `singularity`" step requires the merge; validated here on `att-1782924979-2mnf` instead.
- **Residual (rare path):** the faceted endpoint's cold build is still multi-second and can 502 the gateway
  proxy under load — acceptable (rare Studio/detail path, cached + coalesced, non-blocking); the hot path is
  now ms. The cold-boot readiness livelock under load-40 is the separate `issue-cold-boot-fanout.md`.

## Docs to keep current (same turn as the fix)
- `research/perfs/CLAUDE.md` — update the buildPluginTree paragraph: cure landed + re-validated; the two
  corrected design errors; the named next stall (`listActiveWorktreeOps`). Keep status `(Ongoing)` until
  numbers move on `singularity`.
- This doc — record re-validation results after step 2–3.
