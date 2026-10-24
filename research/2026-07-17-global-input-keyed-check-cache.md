# Input-keyed invalidation for the `./equin check` pass-cache

**Date:** 2026-07-17
**Category:** global (checks infra + push/build flow + a repo-wide read-guard + an audit job)
**Status:** proposed

## Context

The check pass-cache is keyed on the **whole working tree**. `runChecks`
(`plugins/framework/plugins/tooling/plugins/checks/core/runner.ts`) computes one
`treeHash = computeTreeHash(root)` — a `git write-tree` over a scratch index
seeded from the real index + `git add -A` (tracked + untracked-not-ignored) — and
keys every check's cached PASS on `(checkId, treeHash, cacheSignature)`
(`core/cache.ts`). A single changed byte anywhere flips `treeHash`, so **all ~62
checks cache-miss and re-run a full scan**, each re-doing O(repo) work regardless
of whether the change could affect its verdict.

The pain concentrates on `push`. The push flow rebases the branch onto a moved
`main` before running `./equin check --scope tree` on the post-rebase tree;
any commit that landed on `main` since the last rebase — from *any* other agent,
on *any* unrelated file — changes the tree object, so the rebased check run is a
**guaranteed full cache miss**. Measured over 7 days of recorded profiles: median
**628s** of full re-checking inside the **exclusive push flock**, serializing all
other pushes (lock hold median 4.7 min, p90 18 min; queue waits p90 ~29 min).

**Required property:** a check's cached PASS must **survive a tree change that
cannot affect its verdict** — invalidation keyed on the check's *actual inputs*,
not the whole tree. Soundness constraints:
- New files that newly match a check's candidate predicate **must still
  invalidate** (a new `new WebSocket(` in a fresh file; a new plugin dir lacking a
  `CLAUDE.md`).
- Stale-PASS is the one catastrophic failure mode (a green that lets a broken
  change reach `main`), so the design is **fail-open** (any doubt → run) and
  backed by a **structural guard** + a **continuous audit**.

Precedent already in-repo: `type-check`'s **import-closure fingerprint cache**
(`checks/plugins/type-check/check/fingerprint.ts` + `closure-cache.ts`) is an
input-keyed cache — a content-addressed per-file fingerprint over each file's
transitive import closure + a global-trigger set — but it is an *inner* cache
private to `type-check.run()`; the *outer* whole-tree cache still forces
`type-check` to execute on any tree change. This plan generalizes input-keying to
the outer cache for all checks.

## Core insight

`computeTreeHash` already builds a scratch tree object containing every file, and
`write-tree` has already hashed every blob. **One `git ls-tree -r <treeHash>`
yields `Map<path, blobSha>` for the entire scan surface in a single call**, at
roughly the cost already paid.

That snapshot is a complete, content-addressed view of everything a `tree`-scoped
check may depend on. From it, with **zero further git calls**, we derive:
- **content identity** (blobSha per path),
- **existence** (path present / absent),
- **directory membership** (paths sharing a prefix),
- **glob / pathspec expansion** (paths matching a glob).

So the mental model is **not** "record raw fs reads and replay syscalls." It is: a
check runs against a **snapshot-backed `FileSystemView`** that **logs which
projections of the snapshot it consulted**; validity = replaying those projections
against the *next* snapshot and confirming they are byte-identical. This one
abstraction subsumes the grep choke-point (Group A) and the ad-hoc reads
(Group B), and — decisively — makes **membership** and **negative existence**
first-class recorded inputs, which is what closes the sharp soundness holes.

## Architecture

### The recording view (the single fs seam)
- Extend the AsyncLocalStorage in `core/scan-context.ts` from `{ tree }` to
  `{ tree, view }` (`view` is `null` when uncached). Rename `withScanTree` →
  `withScanView`; keep `currentScanTree()` reading `view.tree`, so `grep-code.ts`
  needs no signature change — only its body records into `view`.
- New module `core/read-set.ts`: the snapshot loader
  (`loadTreeSnapshot(root, treeHash) → Map<path, blobSha>` via one `git ls-tree
  -r`, built once per run and shared across all checks with a `prefix → members`
  index for O(1) membership/glob projections), the recording `FileSystemView`
  (`readFile` / `exists` / `listDir` / `glob` / `recordQuery`), plus
  `fingerprint(readSet)` and `validate(readSet, snapshot) → { hit: true } | { hit:
  false, reason }`.

### Recorded read-set (stored one JSON per PASS, in an evolved `check-cache/`)
```
{
  checkId, sig,
  sourceHash,                                 // sha256 over the check's own import-closure blobShas
  treeHashAtRecord, recordedAt,
  files:   [ { path, blobSha } ],             // positive content reads
  absent:  [ path ],                          // negative existence probes  (H1)
  dirs:    [ { dir, members: [name] } ],      // directory membership       (H1/H3)
  globs:   [ { glob, matches: [path] } ],     // glob/pathspec expansion     (H3)
  queries: [ { grepArg, fixed, pathspecs, matches: [path], pathspecFp } ],  // Group-A selection + new-matcher guard (H9)
  declared?: { globs, files }                 // H5 escape (opaque subprocess) only
}
```

### Validate-by-replay, not lookup-by-key
The read-set is only known *after* running the body, so lookup cannot pre-compute
a key (unlike `type-check`'s statically-derivable closure fingerprint). The outer
cache therefore becomes **validate-by-replay**:
1. `sourceHash` still matches (check logic unchanged) — else miss.
2. every `files[i].blobSha` matches the snapshot; every `absent[i]` still absent;
   every `dirs[i].members` equals the snapshot-derived members; every
   `globs[i].matches` equals the re-expansion.
3. every `queries[i]`: recompute `pathspecFp` from the snapshot; if unchanged →
   the `git grep -l` result is provably identical, skip. If changed → **re-run
   `git grep -l`** over the scan tree (which includes untracked files, so a
   brand-new matching file is seen) and compare the match set.

All hold → **HIT (skip body)**. Otherwise run + re-record + overwrite the slot.
Store a **single slot per `(checkId, sig)`** (filename `sha256(checkId:sig)`)
holding the latest read-set — the push-rebase path is monotonic-forward, so one
slot serves it fully; a bounded per-key index of the last N read-sets can be added
later only if divergent-worktree miss rates warrant it. Keep atomic write-then-
rename and the age+count prune from today's `cache.ts`.

### Per-check opt-in (no regression during rollout)
Add an `inputKeyed?: boolean | "declared"` capability to the `Check` interface
(`plugins/framework/plugins/tooling/core/types.ts`), documented alongside `scope`
/ `cacheSignature`. Absent → the existing whole-tree `has()/record()` path,
unchanged. A check flips to input-keying **only** once its *entire transitive read
surface* (including shared library helpers) routes through the view. The runner
reads the flag generically and never names check ids (collection-consumer rule).
Any snapshot/view/validation error → treat as **miss and run** — the cache can
never *cause* a stale PASS via an error path.

### Reconciliation with `type-check`
- Its **inner** per-file closure cache (`fingerprint.ts` + `closure-cache.ts`)
  stays **exactly as-is** — orthogonal.
- It gains an **outer** input-keyed entry whose read-set = { contents of
  `graphs.files`, contents of the global-trigger set, `tsconfig*`, membership of
  the `findLintFiles` walk }, sourced from its existing
  `buildImportGraphs`/`globalConfigFingerprint` machinery. Today `type-check.run()`
  rebuilds the import graph and **unconditionally spawns the full tsc worker
  fleet** on *any* tree change (even when the inner cache empties the lint batch).
  Outer input-keying turns an unrelated-file rebase into an **outer HIT → zero
  workers** — making `type-check` one of the single biggest beneficiaries.

## Soundness analysis (the crux)

The scheme is sound **iff the recorded read-set is a complete superset of every
filesystem fact the verdict depends on.** A stale PASS occurs exactly when a
verdict-relevant fact is unrecorded. Hazard coverage:

| Hazard | Archetype | Covered by |
|---|---|---|
| **H1** verdict depends on a file NOT read (absence / membership) | `plugins-have-claudemd` (new plugin dir lacking `CLAUDE.md`) | **directory membership** + **negative-existence probes** (both derived from the snapshot) |
| **H2** data-dependent selection query | grepArg computed from a prior read | reduces to read-set completeness: the determining file's blobSha is recorded → its change invalidates → queries re-derived |
| **H3** directory membership, not content | `table-defs-in-schema-glob` (schema-glob set), `type-check` coverage gate (new `.ts` in no tsconfig), `migrations-in-sync` (`readdir` of `data`) | recorded **glob-match set** + **dir listings**, re-expanded on replay |
| **H4** generated-artifact diff vs many inputs | `plugins-doc-in-sync`, `plugins-registry-in-sync`, `barrel-stubs-in-sync` | committed-artifact blobSha **+ the generator's full input set** (membership + contents) — requires the generator to run against the view |
| **H5** opaque external tool + tool version | `migrations-in-sync` spawns `drizzle-kit` | **declared-inputs** (schema glob + `data` dir + `drizzle.config.ts` + `bun.lock` for the tool version) or opt-out; record-then-replay cannot observe a subprocess |
| **H6** git-history / env / DB reads | `migration-hashes-unique`, `conversation-trailer` | already `cacheSignature → null` (never cached) — unchanged |
| **H7** nondeterminism | any impure check | canonicalize (sort) the read-set before hashing; impure checks already opt out |
| **H8** TOCTOU (edit mid-run) | pre-existing | recorded against run-start snapshot; a concurrent edit invalidates the *next* run — no worse than today |
| **H9** new file that newly matches a grep predicate | Group-A checks | per-query **pathspec fingerprint**; if it differs, re-run `git grep -l` over the untracked-aware scan tree → new matcher caught |
| **H0** completeness meta-hazard | reads via un-instrumented shared helpers (`buildPluginTree`, `discoverCollectedDirs`, `buildEnrichedTree`, `schemaGlobFiles`) | **the central engineering constraint** — a check is input-keyed only when its *entire transitive read surface* routes through the view; enforced structurally (below) |

## Structural guard (chosen)

H0 is the real risk: record-then-replay is silently unsound if a check reads
through a path the view doesn't observe. Enforce completeness **structurally**:

- A repo-wide **lint/boundary rule** forbidding raw filesystem access
  (`fs` / `node:fs` / `Bun.file` / `readdirSync` / `readFileSync` / `existsSync`,
  spawning `git`/tools for reads) inside `checks/plugins/*/check/**` and inside the
  check-facing paths of the sanctioned shared helpers — reads must go through the
  recording seam. Co-locate the rule with the other tooling lint rules
  (`plugins/framework/plugins/tooling/plugins/lint/`), consistent with how the
  repo enforces its own conventions.
- A check whose closure escapes the seam fails the guard at **lint/load time** —
  loud, not a silent stale PASS at cache time.

## Verification story (chosen)

- **Continuous sampled cached-vs-uncached audit:** a scheduled job (repo
  jobs+reports infra) re-runs a random sample of cache-HIT checks with
  `SINGULARITY_CHECK_NO_CACHE=1` and files a **report** on any verdict divergence
  (a divergence = a stale PASS = a soundness bug). Runs through all stages; a check
  advances a stage only after a clean audit window.
- **Shadow mode** during each flip: compute both the old whole-tree decision and
  the new input-keyed decision, log divergences (`validate` returns a discriminated
  `{ hit, reason }` so the log says *why*) — key on `treeHash` until the shadow
  window is clean.

## Staged rollout (each independently shippable, biggest-win-first, safe)

**Stage 0 — infra, no behavior change.** Add `core/read-set.ts` (snapshot loader,
view, fingerprint, validate). Extend `scan-context.ts` to `{ tree, view }`. Extend
`cache.ts` to persist/load the read-set and expose `validate`. Add the
`inputKeyed?` capability (default absent → whole-tree keyed). Wire the runner to
load the snapshot once and branch per check. *Everything still whole-tree keyed;
new path dormant.*

**Stage 1 — Group-A choke-point, automatic, zero per-check edits (lowest risk).**
Instrument `readCandidates` in `grep-code.ts` to record `queries` (+ `pathspecFp`)
and per-candidate `files`. Ship shadow-mode first, then flip pure-grepCode checks
(canonical first: `no-raw-websocket`). Establishes the seam and the audit loop on
the cheapest checks.

**Stage 2 — `type-check` outer key + mixed Group-A (biggest per-check win).** Give
`type-check` an outer read-set from its existing graph/fingerprint machinery
(kills the unconditional worker fan-out on unrelated rebases). Route the few extra
raw reads of mixed Group-A checks (`table-defs-in-schema-glob`:
`imperative-tables.ts` content + `schemaGlobFiles` glob-set) through the view; flip.

**Stage 3 — generated-artifact / discovery checks (highest aggregate savings).**
Thread the view into the shared helpers `codegen/core`
(`buildEnrichedTree`, `discoverCollectedDirs`, `buildRegistryGenContext`,
`renderCompactDoc`/`renderDetailsDoc`, `renderCollectedDirRegistry`),
`plugin-meta/plugins/plugin-tree/core` (`buildPluginTree`), and
`database/plugins/migrations/core` (`schemaGlobFiles`), so membership + contents
are logged. Add negative-probe recording for the `existsSync` artifact/`CLAUDE.md`
checks. Flip `plugins-doc-in-sync`, `plugins-registry-in-sync`,
`barrel-stubs-in-sync`, `plugins-have-claudemd`. On a push-rebase these stop
re-walking and re-rendering the whole plugin tree.

**Stage 4 — declared-inputs for opaque checks.** `migrations-in-sync`:
`declared` inputs (schema glob + `data` dir membership+content + `drizzle.config.ts`
+ `bun.lock`). Trust it only after a clean audit window; else leave it whole-tree
keyed.

Un-migrated checks at every stage keep whole-tree keying → no stage can regress
soundness.

## Cost analysis

- **Per-run fixed:** `computeTreeHash` (already paid) + one `git ls-tree -r`
  (single spawn, ~few hundred ms) → the shared snapshot + `prefix → members` index
  built **once** (the one O(repo) term, replacing work the old path also did).
- **Per-check HIT:** `sourceHash` + `files`/`absent`/`dirs`/`globs` are in-memory
  map lookups / prefix projections — **no git calls**. `queries` recompute
  `pathspecFp` in-memory; a `git grep -l` fires **only** when a query's inputs
  changed, and even then only the cheap `-l` selection — never the masked re-scan,
  AST parse, generator render, or worker fan-out.
- **Push-rebase (the target):** a rebase moves the tree forward by a *localized*
  file set. For most checks, no input under their pathspecs changed → pure
  in-memory diff, **zero greps, zero body execution** — genuinely O(changed files),
  not O(repo). Worst case (everything changed) is bounded by today's cost + one
  ls-tree.
- **O(repo) sneaking back — audited:** membership/glob derivations must read the
  **shared** prefix index (build once), not re-scan per check. Generator-input
  read-sets (Stage 3) are large but *validated* by map lookups — still far cheaper
  than re-running the generator, which is today's cost.

## Files

**Create**
- `plugins/framework/plugins/tooling/plugins/checks/core/read-set.ts` — snapshot
  loader, recording `FileSystemView`, `ReadSet` shapes, `fingerprint`, `validate`,
  pathspec-fingerprint helper.
- A structural lint rule under
  `plugins/framework/plugins/tooling/plugins/lint/` — bans raw fs in
  `checks/plugins/*/check/**` and the helpers' check-facing paths (H0 guard).
- The sampled cached-vs-uncached **audit job** (jobs+reports infra) + its report
  kind.

**Modify**
- `.../checks/core/scan-context.ts` — carry `{ tree, view }`; `withScanTree` →
  `withScanView` (keep `currentScanTree()`).
- `.../checks/core/grep-code.ts` — `readCandidates`/`listCandidates` record
  `queries` (+ `pathspecFp`) and per-candidate `files` (no public signature
  change).
- `.../checks/core/cache.ts` — persist/load `ReadSet`; add
  `validate(checkId, sig, snapshot)`; keep the legacy `has/record` path for
  un-migrated checks.
- `.../checks/core/runner.ts` — load snapshot once; per check branch on
  `inputKeyed` (validate-by-replay vs legacy `has`); run under `withScanView`;
  record the read-set on PASS; shadow-mode old-vs-new logging.
- `plugins/framework/plugins/tooling/core/types.ts` — add `inputKeyed?`
  (+ optional `declaredInputs?()`), documented like `scope`/`cacheSignature`.
- `.../checks/core/index.ts` — export the read-set/view surface.
- Shared helpers made view-aware (Stage 3): `codegen/core`
  (`buildEnrichedTree`, `discoverCollectedDirs`, `buildRegistryGenContext`,
  `renderCompactDoc`/`renderDetailsDoc`, `renderCollectedDirRegistry`),
  `plugin-meta/plugins/plugin-tree/core` (`buildPluginTree`),
  `database/plugins/migrations/core` (`schemaGlobFiles`).
- Per-check flags (staged): `no-raw-websocket`, `table-defs-in-schema-glob`,
  `type-check/check/index.ts`, `plugins-doc-in-sync`, `plugins-registry-in-sync`,
  `plugins-have-claudemd`, `barrel-stubs-in-sync`, `migrations-in-sync`.

## Verification (end-to-end)

1. **Force a HIT:** clean tree → `./equin build` writes read-sets under
   `~/.singularity/check-cache/`. Re-run `./equin check` with no edits →
   migrated checks log `ok (cached)`; confirm **zero** `git grep -l` spawns for
   checks whose inputs didn't change (log the grep count).
2. **Targeted invalidation:** add `new WebSocket(` in an allowed path, then a
   disallowed one → **only** `no-raw-websocket` re-runs; unrelated checks stay HIT;
   the disallowed edit FAILs (not a stale PASS).
3. **New matching file (H9):** create a brand-new untracked `.ts` with
   `new WebSocket(` in a non-allowed path → `no-raw-websocket` invalidates
   (pathspec-fp differs → grep-l replay finds it) and FAILs.
4. **Absence / membership (H1):** create a new empty plugin dir with no
   `CLAUDE.md` → `plugins-have-claudemd` invalidates (membership change) and FAILs;
   without regenerating, confirm it does not stale-PASS.
5. **Generated artifact (H4):** add a plugin, build to regen docs, record PASS;
   hand-edit `docs/plugins-compact.md` out of sync → `plugins-doc-in-sync`
   invalidates (committed-artifact blobSha changed) and FAILs.
6. **type-check outer HIT (Stage 2):** record PASS; change only a `.md` file →
   `type-check` outer-HITs and spawns **zero** workers (previously a guaranteed
   full fan-out).
7. **Tool version (H5):** with `migrations-in-sync` on declared-inputs, bump the
   drizzle-kit version in `bun.lock` → invalidation.
8. **Push-flock win:** simulate a rebase that moves only unrelated files
   (touch files outside every migrated check's inputs) and run
   `./equin check --scope tree` → confirm the migrated checks HIT and the run
   is dominated only by genuinely-affected checks; compare wall-time to a
   `--no-cache` baseline.
9. **Continuous audit:** the scheduled job re-runs sampled HIT checks with
   `SINGULARITY_CHECK_NO_CACHE=1` and files a report on any verdict divergence;
   confirm a clean window before advancing each stage.


