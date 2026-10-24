# Plan: fix the 10–46 s main-thread event-loop block → `buildPluginTree`

**Date:** 2026-06-29
**Category:** perfs
**Status:** Ongoing — hotspot named, **deeper layer found**, fix design revised. No code changed.
The v1 fix below (cache + yield) is **demoted to secondary containment**: profiling the per-call cost
showed the work is **reducible, not irreducible** — `buildPluginTree` over-extracts facets for callers
that need only structure. The recommended cure is now **structure-only extraction** (see the Revision
section). Caching a slow-but-unnecessary computation would hide the waste (the cost-axis escape the
`perfs-investigation` skill warns against).
**Predecessors:**
[`2026-06-29-perfs-stall-stack-flight-recorder.md`](./2026-06-29-perfs-stall-stack-flight-recorder.md) (the instrument)
· [`2026-06-29-conversation-load-40s-eventloop-block-HANDOFF.md`](./2026-06-29-conversation-load-40s-eventloop-block-HANDOFF.md) (the investigation).
This **names** the handoff's hotspot and supersedes its suspect list; the **deeper origin** (why the
hotspot is slow) is in the Revision section below.

## Context

"Loading a conversation on main takes 40+ s." The prior arc proved the symptom is the main
(`singularity`) backend's single event loop being **monopolized by one synchronous CPU op for
10–46 s**, dozens of times a day; the conversation loaders are victims. The exact function was
unnamed, so an on-stall JSC sampling-profiler flight recorder was landed (`debug/health-monitor`).

The recorder went live this session (the *running* main predated the recorder commit; it rebooted
with it at 18:03:35) and captured the block. **Root cause is now confirmed beyond doubt** — three
converging lines:

1. **Profile** (`logs/stall-profiles.jsonl`): `eventLoopMaxMs 9920`, **`sampleRateHz 176`** (≈ the
   ~230 Hz nominal → the sampler thread kept running → a *real in-process JS block*, NOT host CPU
   starvation). topLeaf **`readFileSync` 59.6 %**; topStacks `readFileSync ← parseRawUses ← extract
   ← buildPluginTree` (27.7 %) and `… ← parsePaneDefinitions ← extract ← buildPluginTree` (26.3 %).
2. **System data** (`get_runtime_profile`, singularity): `GET /api/plugin-view/tree` **max 10335 ms**;
   the conversation-load endpoints `allow-files` (10671 ms) and `viewed` (10800 ms) fire at the
   *consecutive* timestamps immediately after it → **victims queued behind the block** (the handoff's
   thesis, now with the block named).
3. **Code:** `buildPluginTree` Step 4b is a fully **synchronous** `node × facet` double-loop of
   `facet.extract(...)` (sync `readFileSync`), run with **zero caching** on every request.

### Why the headline suspects were victims (gate-killed)

- ❌ **`stats/cost/*`** (handoff suspect #2): measured directly — `walkPerSession` over the full
  **1.2 GB / 3009 session files** runs in 1.3 s wall with an **18 ms** max event-loop block (chunks
  per file via `await Bun.file().text()`). The boot prewarm of the full `buildBundle` blocked only
  1.36 s. The "8 cost endpoints at 65–77 s simultaneously" is the victim/single-flight signature.
- ❌ **One giant resource serialize:** largest persisted `live_state_snapshot` value is 444 kB — no
  value is remotely large enough for a 40 s serialize.
- ❌ **Host CPU starvation:** killed by `sampleRateHz 176` (a real JS stack dominated; starvation
  would starve the sampler thread too → near-zero samples).

## Root cause (rate × cost)

- **Cost (per occurrence):** `buildPluginTree` (`plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts:277`)
  Step 4b (lines ~363–371) synchronously iterates every plugin node × 9 facets; each `facet.extract`
  (`facets/core/facets.ts:25,36` — `extract: (ctx) => T`, **sync**) reads files via sync
  `readFileSync`/`existsSync`/`readdirSync` (`parse-utils/core/helpers.ts:1,14,148`). Steps 1–2 are
  already async; **4b is the unyielded block**. ~10 s warm; 40 s+ post-boot (cold FS page-cache after
  a build + IO contention from ~18 worktrees, loadAvg 12.5/18).
- **Rate (the origin):** `handleTree` (`plugin-view/server/internal/tree-handler.ts:25`) calls it
  **uncached on every request**. Triggered by always-on surfaces: `config_v2/settings/config-nav.tsx:34`,
  **`active-data/plugin-link` chips (every conversation with an inline `<plugin>` chip)**,
  `studio/explorer`, `studio/contributions`. Post-boot the fleet reconnects → a herd of uncached
  rebuilds. A 2nd uncached-ish caller: `composition/server/internal/data-handler.ts:19`.
  **Legitimacy gate fails:** the plugin source tree is immutable between builds; rebuilding per
  request is redundant work. **Sufficiency gate passes:** common surfaces × fleet reconnect reproduces
  "dozens/day, worst post-boot."

### Structural footgun (surface, don't memorize)

`buildPluginTree` is a known *"blocks the event loop for tens of seconds"* primitive. **Three** call
sites independently rediscovered this: `review/plugin-changes` memoizes it (`createGitStateMemo`),
`composition` module-caches it — but the **always-on** consumer, `plugin-view/handleTree`, has no
cache. The durable fix makes the cached, yield-safe accessor the **only** runtime path to a built
tree, so no handler can re-introduce the uncached synchronous call.

## ⚠️ Revision — the deeper layer: the per-call cost is *reducible* (do NOT lead with caching)

The v1 plan below reached for caching before proving the per-call work is irreducible — the exact
cost-axis escape the skill forbids. Decomposing *why one `buildPluginTree` call is 10–46 s* exposes
the real origin:

**Quantified cost.** Step 4b (`plugin-tree.ts:363–371`) is a synchronous `node × facet` loop. Four
facets (`cross-refs`, `contributions`, `resources`, `routes`) each `walkFiles` + `readFileSync` (+
`maskSource`/`stripTypes`) over the plugin's source — **4408 `.ts/.tsx` files, 10.6 MB** total, read
**synchronously** (and partly re-read per facet). Steps 1–3 (`collectCoreFields`: ~4 async barrel /
`package.json` reads per node) are cheap and **absent from every captured stall sample** — 100 % of
samples are under `extract ← buildPluginTree`. So the block IS Step 4b, and it scales with the whole
repo's source size, inflated by cold FS cache + host IO contention on each blocking syscall.

**The work is unnecessary for the hot callers (the origin).** `handleTree` builds *all 9 facets* plus
`classifyEdges`/`disabledClosure` to populate `facets` and `disabled` — but its high-frequency callers
**discard both**:

| Consumer (of `getPluginTree`) | Frequency | Needs |
|---|---|---|
| `studio/explorer` tree | on Studio open | structure only — renders no `disabled` |
| `config_v2/settings/config-nav` | **Settings (always-on)** | structure only — builds its own `facets:{}` |
| `active-data/plugin-link` chips | **every conversation with a `<plugin>` chip** | `description` only |
| `studio/contributions` tab | on Studio open | **all facets, all plugins** (genuine) |
| `plugin-view` detail pane | on plugin click | **facets for ONE plugin** |

Three of five callers — the always-on ones driving the post-boot herd — need only the cheap
structural skeleton. Only Contributions (aggregate) and the detail pane (single plugin) need facets.

### Recommended cure — structure-only by default, facets lazy (origin fix, not containment)

1. **`buildPluginTree(root, { skipBarrelImport, facets? })`** — gate Step 4b (and the barrel import)
   behind `facets` (default **off**). `getPluginTree`/`handleTree` request **structure-only** → Step 4b
   never runs → the 4408-file synchronous walk disappears from the hot path; the endpoint returns the
   cheap async steps 1–3 (no `disabled`/`facets`, which no current tree consumer reads). This is the
   biggest, simplest win and removes the monoblock at the origin.
2. **Per-plugin facets for the detail pane** — a `getPluginFacets(pluginId)` endpoint extracting facets
   for that ONE plugin's files (tiny), so opening a plugin never builds the whole-repo tree.
3. **Aggregate facets for Studio Contributions** — the one consumer that legitimately needs all-plugins
   facets gets a dedicated full-facet build, **low frequency**, where caching + async-read +
   read-once-share + chunked yield (the v1 techniques) now legitimately apply — because that work *is*
   necessary there, having proven it is *not* necessary on the hot path.

Altitudes, ordered: **L3 over-extraction (origin — don't extract facets the caller discards)** →
L2 redundancy (read each file once, share across facets) → L1 sync→async / yield → L0 cache. Lead
with L3; apply L0–L2 only to the residual aggregate build.

> **Open before implementing:** confirm no other `getPluginTree` consumer reads `disabled`/`facets`
> (audited: explorer/config-nav/plugin-link do not); design the detail-pane + Contributions facet
> sources; decide whether `getPluginFacets` reuses single-plugin extraction cleanly. This is a larger,
> cleaner change than v1 — pursue it over the cache-only patch.

---

## v1 fix (SUPERSEDED — containment only; kept for the evolution record) — both altitudes

> Demoted: this caches/yields the *full-facet* build instead of not doing it on the hot path. Its
> techniques (watcher-invalidated memo, `setImmediate` yield, read-once) remain correct **for the
> residual aggregate Contributions build** (step 3 above), just not as the primary cure.

### A. Cure the rate — one shared cached accessor (new `plugin-tree/server` barrel)

`plugin-tree` is core-only today, but a server library barrel is legal and the right home (logic
lives with `buildPluginTree`/`PluginTree`; `host-read-pool`/`git-read-cache` are precedent
server-only library plugins). It exports **one** function; `buildPluginTree` stays in `core` for the
build-time consumers (`tooling/{boundaries,checks,codegen}`, `closure`).

**Invalidation = watcher-driven generation, NOT a git SHA.** A SHA would serve **stale** on an
uncommitted worktree edit (the file changes without moving HEAD) — the exact trap `plugin-tree-cache.ts`
documents (its worktree side switches off SHA to a generation). A debounced `createFileWatcher` on
`PLUGINS_DIR` bumps a monotonic `generation`, fed as the `signatureFn` into `createGitStateMemo`
(reused verbatim for single-flight + per-key coalesce + skip-heavy-slot-on-hit). Push-based (respects
no-polling). The server restarts on every `./equin build`, so the cache is naturally
cold-once-per-boot; the watcher only covers live edits between builds.

`plugin-tree/server/internal/plugin-tree-cache.ts` (new):
```ts
const treeMemo = createGitStateMemo<PluginTree>({ name: "plugin-meta.plugin-tree" });
let generation = 0;
let watcherPromise: Promise<FileWatcher> | null = null;

function ensureWatcher(pluginsRoot: string): Promise<FileWatcher> {
  watcherPromise ??= createFileWatcher({
    dirs: [pluginsRoot],
    ignore: ["**/node_modules/**", "**/.git/**"],
    reconcileMs: null,                       // pure push invalidation, no periodic flush
    onChange: (events) => { if (events.length > 0) generation++; },
  });
  return watcherPromise;
}

export async function getPluginTreeCached(pluginsRoot: string): Promise<PluginTree> {
  await ensureWatcher(pluginsRoot);          // live before first build so no edit is missed
  return treeMemo.get(
    pluginsRoot,
    () => Promise.resolve(String(generation)),
    () => withHeavyReadSlot(() => buildPluginTree(pluginsRoot, { skipBarrelImport: true })),
  );
}
```
`plugin-tree/server/index.ts` (new): purity-compliant barrel — `export { getPluginTreeCached }` +
`export default { description } satisfies ServerPluginDefinition`.

### B. Contain the cost — chunked yield in Step 4b

`buildPluginTree` is already `async` and every consumer `await`s it, so internal yields are
transparent. Yield with **`setImmediate` (macrotask)**, not `Promise.resolve` (microtask) — only a
macrotask lets the queued HTTP victims run. Step 4c `facet.relate({tree})` runs after the whole loop,
and single-flight guarantees no concurrent build mutates `tree`, so yielding between nodes is safe.

`plugin-tree/core/internal/plugin-tree.ts` (Step 4b, ~363–371):
```ts
const YIELD_EVERY = 16; let processed = 0;
for (const node of byDir.values()) {
  const nodeModules = importedModules.get(node.dir) ?? [];
  for (const facet of facets) setFacet(node, facet.def, facet.extract({ dir: node.dir, importedModules: nodeModules }));
  if (++processed % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
}
```

### Route the consumers through it (delete ad-hoc caches)

- `plugin-view/server/internal/tree-handler.ts:25–28` → `const tree = await getPluginTreeCached(PLUGINS_DIR);`
  (drop the `buildPluginTree` + `withHeavyReadSlot` imports).
- `composition/server/internal/data-handler.ts:15–24` → delete the `let cached`; build via
  `getPluginTreeCached(PLUGINS_DIR)` and memoize the *derived* `{graph, allIds}` in a
  `WeakMap<PluginTree, …>` keyed by tree identity (correctly invalidated when the cache returns a new
  tree). Drop its "staleness is a filed follow-up" comment — now invalidated correctly.

## Files

| File | Change |
|---|---|
| `plugin-meta/plugins/plugin-tree/server/index.ts` | **new** barrel — `getPluginTreeCached` + default def |
| `plugin-meta/plugins/plugin-tree/server/internal/plugin-tree-cache.ts` | **new** — memo + watcher generation |
| `plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | chunked `setImmediate` yield in Step 4b |
| `plugin-meta/plugins/plugin-view/server/internal/tree-handler.ts` | use `getPluginTreeCached` |
| `plugin-meta/plugins/composition/server/internal/data-handler.ts` | use `getPluginTreeCached` + WeakMap derived memo |
| `plugin-tree`/`plugin-meta` `CLAUDE.md` prose | note plugin-tree now ships a server cache barrel (autogen blocks refresh on build) |

**Reuse:** `createGitStateMemo` (`infra/git-read-cache/server`), `withHeavyReadSlot`
(`infra/host-read-pool/server`), `createFileWatcher` (`infra/file-watcher/server`), `PLUGINS_DIR`
(`infra/paths/server`). **Precedent to mirror:** `review/plugins/plugin-changes/server/internal/plugin-tree-cache.ts`.

**Out of scope:** the disabled `review/plugin-changes` keeps its own main-vs-worktree two-tree memo
(future consolidation). Herd levers B′ (resubscribe stagger) / C (coalesce auto-builds) from the
handoff are unneeded for this bug — the cache's single-flight already coalesces the post-boot herd
onto one build.

## Risks

- **Reconcile flush** would invalidate every ~30 s and defeat the cache → mitigated by `reconcileMs: null`
  + the `events.length > 0` guard.
- **Watcher FD/scope:** recursive watch of `plugins/` must `ignore` `node_modules`/`.git` (same guard
  that blocks unbounded `find`). Verify the glob form against an existing consumer (`config_v2`, `git-watcher`).
- **Singleton watcher:** module-level `watcherPromise`/`generation` + idempotent `??=` → exactly one
  watcher though two plugins call the accessor.
- **≤1-event mid-build staleness** self-heals on the next `get` (new generation → rebuild) — matches the
  documented git-read-cache staleness-sharing contract.
- **Boundary/registry:** new server barrel must be picked up by `server.generated.ts` via build; run
  `./equin check plugin-boundaries` (legal barrel, no re-export, no cycle:
  `plugin-tree/server → infra/*/server + own core`).

## Verification (end-to-end)

1. `./equin build`; confirm boot (new barrel registers; no boundary/cycle check failure).
2. **Warm latency:** hit `GET /api/plugin-view/tree` twice → `get_runtime_profile` shows max drop from
   ~10 s to ms on the 2nd call, with a `git-memo-hit:plugin-meta.plugin-tree` marker (miss on the 1st).
3. **Cold-build containment:** around a cold build, `stall-profiles.jsonl` / `health.jsonl`
   `eventLoopMaxMs` stays bounded — no contiguous multi-second `buildPluginTree` block.
4. **Victims unblocked:** `allow-files` / `viewed` no longer post consecutive ~10 s timestamps behind
   the tree build.
5. **Invalidation:** edit a plugin file (e.g. a `package.json` description) → re-request the tree →
   the change is reflected (never stale).
6. **Composition:** `GET /api/composition/data` still returns correct `{graph, allIds}` from the shared tree.
7. **Falsifiable prediction:** further recorder captures should keep naming `buildPluginTree` until this
   lands, then stop.
