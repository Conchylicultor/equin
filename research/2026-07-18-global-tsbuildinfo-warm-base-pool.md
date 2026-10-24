# Fix type-check cache starvation: a host-global warm-base pool for `.tsbuildinfo`

Status: proposed
Date: 2026-07-18

## Context

`./equin push` spends ~7 CPU-minutes in `type-check` even for diffs containing zero
TypeScript. The suspicion was "the build cache is broken." It is not — the cache is
**correct, and being starved**. This plan fixes the starvation at its origin.

### Root cause: L1 (check-result cache) starves L3 (`.tsbuildinfo`)

There are three cache layers today:

| # | Cache | Location | Scope | Skips |
|---|---|---|---|---|
| L1 | check-result | `~/.singularity/check-cache` | host-global | the *entire check* |
| L2 | closure | `~/.singularity/closure-cache` | host-global | per-file *lint* |
| L3 | tsbuildinfo | `<worktree>/.cache/tsbuildinfo/` | **per-worktree, copy-seeded from main** | per-file *type-check* |

`.tsbuildinfo` is a **byproduct of running the check**, not a tracked output. So:

```
agent worktree pushes
  → type-check EXECUTES at post-rebase tree T, writes tsbuildinfo (in the worktree, discarded)
  → records an L1 PASS under key (T, type-check, sig)
  → ff-merge: main's tree becomes exactly T
  → main's git-watcher fires autoBuild → build → runChecks
  → L1 HIT at tree T → runner.ts:248 "A cache hit runs nothing"
  → check.run() never called → main's .cache/tsbuildinfo NEVER WRITTEN
  → the next new worktree seeds from main's stale cache
```

The seed only refreshes when main's build *misses* L1 — rare and accidental.

**Evidence.** `autoBuild` is enabled (default `true`, resolved `true`); main built
successfully at Jul 17 20:29–23:29 UTC; yet main's buildinfo is stamped Jul 16 23:18 UTC.
Two distinct timestamp groups on disk reveal two different writers — the older group is
the `--skip-checks` fast path (`build.ts:1183`), which runs raw `tsc --incremental`
directly and is filtered to `hasEntrypoint` targets.

**The perverse inversion:** `build --skip-checks` *refreshes* the seed; a full `build`
does **not**, because it cache-hits. Skipping checks maintains the cache better than
running them. And it is self-reinforcing: the better L1's hit rate gets, the faster the
L3 seed decays. The input-keyed outer cache (shipped 2026-07-17) raises L1's hit rate and
therefore actively accelerates this.

### Measured cost of the stale seed

Files each target must revalidate, against a freshly-built worktree (`web-core`, 7615 files —
the wall-clock-dominating target):

| Base used | files to revalidate |
|---|---|
| **main (37h stale) — what we use today** | 368 (4.8%) |
| sibling worktree, ~1h old | 137 (1.8%) |
| sibling worktree, ~2h old | **0 (0.0%)** |
| cold (no base) | 7615 (100%) |

Main is the **worst available base**, and it is the only one the system uses. 122 live
worktrees each hold their own `.tsbuildinfo` (~866 MB total); none are shared.

### Why *content-addressing* is the wrong fix

The obvious move — "make it a content-addressed artifact like `web-artifacts`" — is wrong.
Keying an artifact on its exact input set yields a hit only when inputs are **identical**,
which is precisely when L1 already skips the check entirely. An incremental checkpoint
earns its value when inputs **differ**. It is a *warm base*, not an exact output.

So the correct model is a **recency-selected pool**, not a content-addressed store.
This is the one place where copying `web-artifacts`' design would have been a mistake.

### Feasibility: `.tsbuildinfo` is already fully relocatable (verified)

All 8 real buildinfo files were inspected (regex for any absolute string over raw JSON):

- **Zero absolute paths.** `fileNames` are all relative (`../../node_modules/...`), resolved
  against the buildinfo's own directory. `options.tsBuildInfoFile` is stored as
  `"./cli.tsbuildinfo"`.
- **No paths outside the repo root.** TypeScript's own `lib.*.d.ts` resolve through the
  in-repo `node_modules/.bun/typescript@5.8.3/...`.
- **Validation is content-based**: `fileInfos[].version` are content hashes, so
  `git worktree add`'s mtime reset is irrelevant (this is why the seed works at all).
- `version: "5.8.3"` and `options` are embedded, so an incompatible base **self-invalidates**
  into a full check — "best-effort, never wrong."

**Consequence:** a buildinfo can be moved between worktrees verbatim. Therefore
`copyTsBuildInfoToWorktree`'s `raw.split(repoRoot).join(wtPath)` rewrite
(`worktree.ts:54`) is a **no-op** — `repoRoot` never occurs in the bytes — and its comment
("`.tsbuildinfo` embeds absolute source paths") is factually wrong for TS 5.8.3.

---

## Design

### Stage 1 — Warm-base pool (the fix)

A host-global pool, written by **every** successful type-check run in **any** worktree, read
by whoever starts next. Main leaves the critical path entirely.

```
~/.singularity/tsbuildinfo/<tsVersion>/<target>/<publishId>.tsbuildinfo
```

- **`<tsVersion>`** — from the resolved `typescript` package. Reuse the existing
  `packageVersion()` helper pattern (`web-artifacts/core/internal/identity.ts`:
  `createRequire` + `resolve("typescript/package.json")` + `readFileSync`, deliberately
  *not* importing the module). This is a cheap directory partition, **not** a correctness
  mechanism — tsc's embedded `version`/`options` self-validation is what guarantees
  correctness, so an imperfect partition can only cost a cold run, never a wrong result.
- **`<publishId>`** — monotonic (timestamp + pid), so selection is "newest wins" by name
  with no stat storm.

Two operations:

- **`publishWarmBase(root, targetName)`** — after a worker completes without crashing,
  copy its local buildinfo into the pool via tmp+rename. Publish regardless of whether
  diagnostics were found: the buildinfo reflects *program state*, which is valid even when
  the check fails. Skip only on worker crash (state may be torn).
- **`materializeWarmBase(root, targetName)`** — before the worker fan-out, if the local
  `.cache/tsbuildinfo/<target>.tsbuildinfo` is absent **or older than** the newest pool
  entry, copy the pool entry in. Copy (not hardlink/symlink) — tsc *writes* this file, and
  a hardlink would corrupt the pool entry. ~7 MB × 8 targets is ~100 ms on SSD.

Pruning: keep newest **3** per `(tsVersion, target)` plus a 14-day age bound → ~21 MB
steady state, versus the 866 MB currently scattered and unusable.

Concurrency is safe by construction: tmp+rename means a torn file is never observable, and
two publishers racing simply produce two pool entries, newest winning.

### Stage 2 — Delete the dead seeding path

With the pool in place, seeding-at-worktree-creation is both redundant and strictly worse
(it captures main's state once, at creation, and decays from there; the pool is re-read at
every check with whatever is freshest). Remove `copyTsBuildInfoToWorktree` and its call —
including the no-op string rewrite and the swallowed `try {} catch {}`.

### Stage 3 — Cap and orphan cleanup

- **Caps are thrashing.** `closure-cache` holds 45,684 entries against
  `MAX_ENTRIES = 50000 → TRIM_TO = 40000`; **every entry was written today**, so nothing
  survives 24h and cross-day reuse is impossible. `check-cache` is 4,682 against
  `5000 → 4000`. Raise both (suggest 4× headroom) and prefer the age bound over the count
  bound as the primary evictor.
- **`~/.singularity/eslint-closure-cache` is orphaned** — 45,581 entries, dead since Jun 12,
  zero code references (renamed to `closure-cache` during the type-check unification; the
  old dir was never swept). Delete it, one-shot.
- **Drift to fix while here:** `vendors.ts` / `global-css.ts` comments claim "same policy as
  the artifact store", but neither implements a count cap — only `pruneStore` does.

### Stage 4 — One shared store primitive

There are five hand-rolled near-copies of the same tmp+rename + age/count-prune dance:
`store.ts`, `cache.ts`, `closure-cache.ts`, `vendors.ts`, `global-css.ts`. That duplication
is *why* the caps drifted apart and why an orphaned directory survived a rename.

New primitive at **`plugins/infra/plugins/artifact-store/core/`** — it must be a `core/`
barrel: `checks` and `web-artifacts` have no `server/` folder and import only other `core`
barrels, and `./equin check` runs in a standalone process that must never load
`db`/`jobs`. Precedent: `infra/plugins/paths/core` uses raw `node:fs` in `core/`, and
`file-sink` is explicitly "Node-only (no db/jobs) so a CLI process can import it".

It must support the union of what the five need:

- both **file-per-key** (`cache.ts`, `closure-cache.ts`) and **dir-per-key** (`store.ts`,
  vendors, css) payloads
- **touch-on-hit** — only `store.ts` has it today; `cache.ts`/`closure-cache.ts` never
  refresh mtime on a hit, so a frequently-*read* entry can silently age out. Folding this in
  fixes a latent bug in two caches for free.
- **async key resolution** — `vendors.ts` must run esbuild resolution before it can hash
- **payload materialization** — `global-css.ts` copies payload files into a staging dir
- `.tmp.*` leftovers aged at 1h regardless of the main age bound

Optionally register a fifth `GrowthBound` constructor
(`{ kind: "age-count"; maxAgeMs; maxEntries }`) merged into `retention`'s `getGrowthBounds()`
the same one-way way `file-sink`'s `rotate` bounds are — so these caches become *declared*
bounded rather than incidentally bounded. Note `retention` is a `server/` barrel, so the
merge lives there and the `core/` store never imports it.

**Sequencing:** Stage 4 is a refactor of load-bearing caches and should land *after*
Stages 1–3 are verified, not alongside them.

---

## Deliberately deferred: the semantic trigger split

The `license`-field problem is real — `isGlobalTrigger` (`fingerprint.ts:42`) treats root
`package.json` as a global trigger, so editing a `license` string invalidates identically
to bumping the TypeScript compiler. That is what made L1 miss on the docs-only push.

**But it is second-order once the warm base is fresh.** The 7 CPU-minutes came from the
*stale base*, not from the L1 miss itself. With a ~0%-stale base, an L1 miss still spawns 8
workers, but each starts from a program with nothing to recheck; residual cost is program
load and file re-hashing, not typechecking.

It also carries real design cost. The outer read-set validates **path facts** only —
`recordFile`/`exists`/`listDir`/`glob`/`recordQuery`, validated in `read-set.ts:540-575`.
Keying on a *derived* value ("typescript@5.8.3") needs a new fact kind plus a
`recomputeValue` branch in `validate` (mirroring the existing `replayQuery` hook). That is
a clean, additive extension — but it modifies the input-keyed cache that shipped yesterday
and whose read-set slots are still barely populated (8 slots exist).

**Recommendation:** land Stages 1–3, measure, then revisit with real numbers on how much
worker-spawn + program-load actually costs. Doing it now would change two caching systems
at once and make a regression hard to attribute.

---

## Files

**Stage 1**
- *new* `plugins/infra/plugins/artifact-store/core/` — or, if Stage 4 is deferred, put
  `publishWarmBase`/`materializeWarmBase` in
  `plugins/framework/plugins/tooling/plugins/checks/core/warm-base.ts` and export from
  `checks/core/index.ts` (both consumers already import that barrel).
- `checks/plugins/type-check/check/index.ts` — `materializeWarmBase` per target before the
  `mapConcurrent` fan-out (~line 250); `publishWarmBase` alongside the existing closure-cache
  recording loop (~line 287), skipping targets in `crashes[]`.
- `checks/core/discover.ts` — keep `tsBuildInfoPath` as the local path; the pool is a
  separate concern layered above it.
- `cli/bin/commands/build.ts:1183-1200` — the `--skip-checks` raw-`tsc` loop should
  materialize and publish too, so the fast path feeds the same pool.

**Stage 2**
- `plugins/infra/plugins/worktree/server/internal/worktree.ts:40-57, 93-96` — delete
  `copyTsBuildInfoToWorktree` and its call.

**Stage 3**
- `checks/core/cache.ts:20-23`, `checks/plugins/type-check/check/closure-cache.ts:20-25` — caps.
- `web-artifacts/core/internal/vendors.ts:357-373`, `global-css.ts` — count caps to match the
  comments.
- one-shot removal of `~/.singularity/eslint-closure-cache`.

**Stage 4**
- new `plugins/infra/plugins/artifact-store/core/`; migrate the five call sites.

---

## Verification

The failure mode is *silent staleness*, so verification must observe the cache, not just a
green check.

1. **Baseline.** Record `stat -f %Sm` on main's and this worktree's
   `.cache/tsbuildinfo/*.tsbuildinfo`, and the per-target revalidation counts using the
   `fileInfos`-diff method used in this doc (compare `fileNames`→`version` maps between two
   buildinfos; count entries that differ or are new).
2. **Pool is written.** Run `./equin build` in this worktree; assert
   `~/.singularity/tsbuildinfo/5.8.3/<target>/` gains an entry per target.
3. **Pool is read.** Create a second worktree, run its first check, and assert its
   buildinfo's revalidation count against the pool entry is **~0**, versus the ~368
   (`web-core`) it would be against main today. This is the number that proves the fix.
4. **Starvation is broken.** Confirm a *main* build that L1-hits no longer matters — the pool
   entry's timestamp should track the most recent worktree run, not main's last cache miss.
5. **Correctness floor.** Corrupt a pool entry deliberately and confirm tsc falls back to a
   full check and still reports correct diagnostics (the "never wrong" property). Then bump
   a type in a widely-imported `core/` file and confirm the error is still caught with a warm
   base — the base must not mask a real regression.
6. `./equin check` clean; `bun test plugins/framework/plugins/tooling/plugins/checks`
   for the read-set round-trip suite.

**Note on measuring wall-clock:** two pushes contending for the host semaphore will confound
timings (the original report showed ~6 min of a 13.5 min elapsed being queue wait). Measure
CPU-time per worker, or measure on a quiet host.
