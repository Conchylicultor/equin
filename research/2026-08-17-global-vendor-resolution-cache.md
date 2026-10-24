# Vendor resolution: cache the answer, batch the misses

Phase 0 of [`2026-08-17-global-composition-build-serve-model.md`](./2026-08-17-global-composition-build-serve-model.md).

## Context

`artifacts:vendors` is the dominant cost of a warm build. On main, across builds
where `artifacts:build` reported `(0 stale)` — nothing to bundle at all — the
stage took 35.7 s / 110.5 s / 56.4 s / 37.5 s; three more recent profiles in
`~/.singularity/worktrees/singularity/` show 62.7 s / 60.1 s / 26.6 s. In the
most recent one it is 38 % of the entire build's wall clock.

None of that is bundling. On a warm build the vendor set is already in the
store, so the expensive `splitting: true` esbuild pass never runs. The whole
span is **resolution**: `ensureVendorSet` calls `resolveVendorSet` before it
checks the store, and `resolveVendors` walks its request list sequentially,
running a full `esbuild.build()` probe per specifier plus a package.json walk
and one or two lexer passes.

Resolution maps `{specifier, resolveDir}` → `{entryFile, version, cjs, wrapper}`,
and that output is also what the set hash is computed from — which is why it
cannot simply be skipped.

### What the work actually costs (measured)

Replaying the current algorithm over the real 72-specifier set (from
`~/.singularity/web-artifacts/vendors/set.a595fa17…/meta.json`) against the main
checkout, with real per-package `resolveDir`s:

| pass | total | esbuild probes | package.json walks | lexers |
| --- | --- | --- | --- | --- |
| cold page cache | 3 635 ms | 3 210 ms (88 %) | 17 ms | 407 ms |
| warm, sequential | ~530–600 ms | — | — | — |
| warm, one build per `resolveDir`, groups in parallel | ~190–205 ms | — | — | — |

Three things fall out of this:

- **The esbuild probe is ~88 % of the cost, and it is filesystem-latency-bound,
  not CPU-bound.** Cold it is 45 ms/specifier (one outlier at 871 ms); warm it is
  ~7 ms. The 35–110 s seen in real builds is this same work with a cold page
  cache on a contended host — several worktree builds fanning across every core
  while bun's isolated-install tree (`node_modules/.bun/`, 1 312 entries of
  symlinked packages) is re-traversed from scratch.
- **72 separate builds re-traverse the same directories 72 times.** esbuild's
  internal filesystem cache is scoped to one `build()` call, so every probe
  re-stats the same `node_modules` / `.bun` ancestry. Grouping by `resolveDir`
  collapses 72 builds into 20 and lets each group share one cache.
- **On a warm build every one of those answers is already known and unchanged.**
  This is a recompute that produces no change — the fix is to not do it, not to
  do it more cheaply.

There is a second multiplier: `resolveVendorSet` has three call sites —
`pipeline.ts` (the build), and `computeExpectedComposition` +
`readFleetVendorMeta` in `expected.ts` (the `web-artifacts:map-in-sync` check,
which runs at the start of every build unless `--skip-checks`). Those are
**separate processes**, so a build pays the full resolution more than once. Any
cache has to be on disk, not in memory, to fix both.

### Intended outcome

A warm build's `artifacts:vendors` span drops to milliseconds and does zero
esbuild work; a cold one gets the batched/parallel shape; the `setHash` for an
unchanged tree is bit-identical to today's.

## The change

Two independent levers, in `core/internal/vendors.ts`.

### 1. Persist the resolution, validated by its own read-set (the warm path)

A per-worktree JSON cache at `~/.singularity/web-artifacts/vendor-resolutions/<worktree>.json`,
following the `loadFingerprintCache` / `saveFingerprintCache` idiom already in
[`core/internal/store.ts`](../plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/store.ts)
(same atomic tmp-then-rename write, same "unparseable or wrong version ⇒ treat
as empty").

```ts
interface VendorResolutionRecord {
  entryFile: string;
  version: string;
  cjs: boolean;
  wrapper: string;
  /** Exactly the files this resolution read: abs path → [mtimeMs, size]. */
  files: Record<string, [number, number]>;
}

interface VendorResolutionCache {
  version: number;
  /** Invalidates everything at once when the install or the resolver moves. */
  gate: string;
  /** Key: `${resolveDir}\0${specifier}`. */
  records: Record<string, VendorResolutionRecord>;
}
```

`gate` is `sha256Hex` of the repo's `bun.lock` **contents**, `esbuild.version`,
`BUILDER_VERSION`, and the builder source digest (`plan.identity.sourceDigest`).
Every one of those is already an input to the set hash except `bun.lock`, and
each is load-bearing: the lockfile determines what is in `node_modules`, the
esbuild version determines resolution semantics, and the builder source is where
`cjsNamedExports` / `moduleFormatOf` / the wrapper text are written.

**A record is a hit only when the gate matches and every file in `files` still
stats to the same `[mtimeMs, size]`.** The read-set is captured, not guessed:
thread a recorder through `resolveSpec`'s result, `nearestPackageJson`,
`moduleFormatOf`, and `cjsNamedExports` so `files` is exactly what was read —
measured at ~150 files for the 72-specifier set (71 entry files, their
package.jsons, 12 CJS re-export-chain files). Validating is ~150 `statSync`
calls. `ENOENT` on a recorded file is a miss; any other stat error rethrows.

This is what makes a hand-edited `node_modules`, a `bun link`, or a patched
package fall out of the cache. The one thing stat validation structurally cannot
see is a *negative* probe becoming positive — a nearer copy of a package
appearing where esbuild previously found nothing. That is what the `bun.lock`
gate covers.

Both `resolveVendorSet` and `ensureVendorSet` gain a `root: string` option (all
four call sites already have it) — needed for `basename(root)` as the cache file
name, exactly as `pipeline.ts:105` derives `worktreeName`, and to read
`bun.lock`.

### 2. Batch and parallelize the misses (the cold path)

Replace `resolveSpec(spec, resolveDir)` with `resolveSpecs(specs[], resolveDir)`:
one `esbuild.build()` per distinct `resolveDir`, whose stdin imports every
specifier in that group, with the same capture plugin generalized from
`args.path !== spec` to a `Set` membership test. Everything still returns
`{ external: true }`, so nothing is loaded and the semantics are unchanged —
grouping by `resolveDir` is what keeps `b.resolve`'s `resolveDir`/`kind`
arguments identical to today's.

Run the groups under `Promise.all`. The cost is IO latency, so overlapping is the
right shape; measured 529 ms → 192 ms warm, and the gap widens cold.

Error text must not regress: collect `b.resolve`'s per-specifier errors, and
after the build throw the existing
`vendor: cannot resolve "<spec>" from <dir>[: <errorText>]` for any specifier in
the group that produced no path — so a bad specifier still names itself.

Order of operations in `resolveVendors`: check the cache first, group only the
**misses** by `resolveDir`, batch-resolve those, then run the existing
package.json / lexer / wrapper loop over the misses alone. A warm build does zero
esbuild builds and ~150 stats.

### 3. Say what happened

Extend the existing line in `pipeline.ts`:

```
vendors: 72 specifiers, 72 cached / 0 resolved in 38ms (set a595fa174111)
```

No new profiler spans — the `artifacts:vendors` span already exists in
`build-profile-*.json`. This is the rung that makes a future regression visible
in the build transcript instead of silently costing a minute again.

### Explicitly not doing

**Not** moving the store check ahead of `resolveVendorSet` inside
`ensureVendorSet`. Once resolution is milliseconds there is nothing to save, and
a cheaper speculative pre-key would be a second cache in front of the first with
its own drift risk. `resolveVendorSet` stays the single source of the `setHash`.

## Files

- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/vendors.ts`
  — `resolveSpec` → `resolveSpecs`, cache lookup + read-set recording in
  `resolveVendors`, `root` threaded into `resolveVendorSet` / `ensureVendorSet`.
- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/vendor-cache.ts`
  (new) — the cache shape, load/save, gate computation, and record validation.
  Sits beside `vendors.ts` / `global-css.ts`, which already build their own roots
  on `WEB_ARTIFACTS_DIR` from `store.ts`.
- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/pipeline.ts`
  — pass `root`, extend the vendors log line.
- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/expected.ts`
  — pass `root` at both `resolveVendorSet` call sites. No other change; the check
  inherits the speedup.
- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/vendor-cache.test.ts`
  (new) — pure unit test of the hit/miss rules.

## Verification

1. **The hash must not move.** Note the current set from the build log
   (`vendors: … (set …)`) or `ls ~/.singularity/web-artifacts/vendors`. After the
   change, on an unchanged tree, `./equin build` must report the *same*
   `setHash` and mint no new `set.*` dir. A moved hash means resolution changed —
   stop and diff the resolved records.
2. **Warm win.** `./equin build` twice (background; ~10 min each), then
   compare `artifacts:vendors` across
   `~/.singularity/worktrees/<worktree>/build-profile-*.json`. Second run should
   be milliseconds and log `72 cached / 0 resolved`.
3. **Stat invalidation.** `touch` one vendor package's entry file under
   `node_modules`, rebuild: the log must show exactly one specifier re-resolved,
   and the `setHash` must be unchanged (same bytes ⇒ same wrapper).
4. **Gate invalidation.** Add a dependency (`bun add` in a scratch worktree):
   `bun.lock` changes ⇒ the whole cache drops ⇒ every specifier re-resolves ⇒ new
   `setHash` ⇒ the vendor set genuinely rebuilds.
5. **The check still agrees.** `./equin check web-artifacts:map-in-sync`
   must pass, and now cheaply — it is the second process that was paying the same
   35–110 s.
6. `./equin test plugins/framework/plugins/tooling/plugins/web-artifacts`
   for the new unit test plus the existing `plan` / `hash` / `import-map` suites.
7. Load the app at `http://<worktree>.localhost:9000` — a wrong wrapper or a
   stale `entryFile` surfaces immediately as a browser
   `does not provide an export named 'X'`.

## Results (measured, 2026-08-17)

### Controlled A/B — resolution in isolation

Baseline (`git HEAD`) vs the working tree, in ONE process, same host state, the
real 72-request list and real `builderSource`, baseline arm run first so it warms
the page cache (biased against the change):

```
baseline (git HEAD)   first 2.41s   then [1.85s, 1.35s, 2.05s, 1.81s]   set 5ebf0a482462
working tree          first  388ms  then [6ms, 2ms, 4ms, 7ms]           set 5ebf0a482462
```

| | baseline | working tree | gain |
| --- | --- | --- | --- |
| cold (empty cache) | 2.41 s | 388 ms | 6.2× |
| warm (median) | 1.85 s | 6 ms | ~300× |

**The set hash is byte-identical** — `5ebf0a482462ad02…`, which is also a set
already in the store, confirming the harness fed genuine inputs. The two levers
separate cleanly: batching 72 probes into 33 grouped parallel builds buys
2.41 s → 388 ms; the persisted cache buys 388 ms → ~5 ms.

### End to end — the `artifacts:vendors` span

| build | `vendor pre-bundles` | log line |
| --- | --- | --- |
| main, before (7 readings) | 22.6 – 110.5 s | — |
| this worktree, cold cache | 2.78 s (incl. a real vendor set build) | `72 specifiers, 0 cached / 72 resolved in 297ms` |
| this worktree, warm cache | **42 ms** | `72 specifiers, 72 cached / 0 resolved in 12ms` |

The whole `web artifacts` stage went 317.6 s (cold, 1072 artifacts built) → 6.5 s
(warm, 0 built). The `web-artifacts:map-in-sync` check — the second process that
was paying full resolution — went 4.13 s → 840 ms.

Caveat on the comparison: main's builds are not `darwinbg`-demoted while this
worktree's agent-branch build is, so the end-to-end figures are conservative.
The in-process A/B is the rigorous ratio.

### Verification performed

- Set hash identical across arms with `builderSource` held constant (above).
  The build minted a new set (`fb3368e48ee9`) only because editing
  `web-artifacts/core` changes the builder source digest — the documented
  "builder edits auto-invalidate the fleet" invariant, not a regression.
- Both builds `BUILD OK — deployed`, all checks green (`map-in-sync` and
  `no-vendored-state-inlined` included).
- `./equin test plugins/framework/plugins/tooling/plugins/web-artifacts`:
  117 pass / 0 fail, including 13 new `vendor-cache` cases (read-set hit; mtime,
  size and deletion misses; gate change drops all records; unparseable and
  wrong-version files degrade to empty; per-`resolveDir` key separation).
- App loads at `http://att-1786989598-wcnd.localhost:9000` with no module
  errors — a wrong wrapper or stale `entryFile` would surface as a browser
  `does not provide an export named 'X'`.

## Follow-on

Phase 1 of the composition doc (per-composition vendor sets) is gated on this:
it drops `readFleetVendorMeta` from the compose-serve path so each composition
resolves its own set, which is only affordable once resolution is a warm-cache
read.
