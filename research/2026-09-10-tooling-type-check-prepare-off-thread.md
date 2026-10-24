# type-check: move preparation off the check runner's event loop

## Context

`./equin check` runs every selected check concurrently in ONE process.
`type-check` does 70–130 s of synchronous work on that process's main thread
before it spawns a single tsc worker. For that whole time no other check makes
progress: no promise settles, no timer fires, no socket is serviced.

The visible breakage: `migration-applies-clean` opens a pg connection, the
freeze starts before the client sends its startup packet, Postgres drops the
silent connection after `authentication_timeout` (60 s), and when the loop
resumes Bun reports `ECONNREFUSED`. Since cbf79336e (type-check now awaits a
`git ls-files` before freezing, which lines the freeze up with that connect) it
fails 10/10 on branches that touch migrations. Every per-check duration in a
pass is distorted by the same freeze.

**Decided by the user:** type-check's preparation must not run on the runner's
event loop, whatever it costs. Making the preparation *faster* (61 of the 70 s
is TypeScript's `include` expansion in `parseTargetRoots`) is a separate issue.

## What blocks today (all in `check/index.ts` `run()`)

| Phase | Work | Sync? |
|---|---|---|
| before workers | `discoverTscTargets` | sync, cheap |
| | `readTreeListing` (`git ls-files`) | **async** — fine |
| | `buildImportGraphs` — reads + scans every lintable file | sync, heavy |
| | `recordOuterReadSet` — in-memory snapshot lookups | sync, cheap |
| | `computeClosureFingerprints` — reads + hashes, closure DFS per file | sync, heavy |
| | `parseTargetRoots` — TS include expansion (~61 s) | sync, heaviest |
| | `computeOwnership`, coverage gate | sync, moderate |
| | `openClosureCache` (prune readdir) + `has()` per file | sync, moderate |
| | `materializeWarmBase` (copies `.tsbuildinfo`) | sync |
| | `openProgramKeyContext` + `programKey` per target (hashes every file in each buildinfo, `node_modules` included) + `openProgramPasses` | sync, heavy |
| workers | per-target tsc/eslint **processes** via `spawnCaptured` | async — fine |
| after workers | `publishWarmBase`, `cache.record` per lint file (thousands of writes on a cold run), `programKey` recompute (reuses the prepare-time hash memo), `passes.record` | sync, moderate–heavy |

Also: `index.ts` imports `typescript` at module top only for
`parseTargetRoots`, so loading the check itself evaluates the TS compiler on
the runner thread.

## Approach: one Bun Worker thread per run, holding a two-phase session

The runner thread keeps only what must live there: git reads (already async),
the recording view, the host-grant fan-out, logging, and the verdict. Everything
that reads file bytes or walks the tree moves to a Worker thread.

```
runner thread (check/index.ts)              worker thread (check/prepare-worker.ts)
─────────────────────────────              ───────────────────────────────────────
root, listing  (async git)
recordOuterReadSet(view, listing)
open thread ─────── prepare{root,listing,cacheEnabled} ──▶ discoverTscTargets, graphs,
                                                            fingerprints, roots, ownership,
                                                            coverage gate, closure-cache has,
                                                            materializeWarmBase, program keys
            ◀────────────────────── Plan ───────────────── (session state kept in memory)
log lines; spawn per-target processes
under ctx.grant (unchanged)
            ─────── finalize{outcomes} ─────────────────▶ publishWarmBase, cache.record,
                                                            key recompute + passes.record,
                                                            skipped re-record
            ◀────────────────────── done ──────────────
verdict; finally: terminate thread
```

### Why a Worker thread, not a helper process

The session has state that must carry across the process-worker fan-out: the
per-file closure fingerprints of the files sent to lint, the per-target keys,
and above all `ProgramKeyContext.contentHash`, the memo the post-run key
recompute reuses. Keeping that memo is what keeps the recorded program key
*exactly* what it is today. A Worker holds it in memory for free. A helper
process would need either a long-lived request/response child — which
`spawnCaptured` (the mandated spawn primitive; stdout goes to a temp file)
cannot host — or two spawns with the memo serialized to disk in between. The
sentinel already runs a Bun Worker from source with `@plugins/...` imports
(`plugins/debug/plugins/sentinel/server/internal/worker-host.ts` +
`worker/entry.ts`), so the mechanism is proven in this repo.

### The read-set stays on the runner thread, unchanged in content

`recordOuterReadSet` only ever used `graphs.files`, which is
`listing.files.filter(isLintable)` — a filter, no file reads. So the runner
records the read-set straight from the listing, before the thread starts:

- `recordOuterReadSet(view, listing)` — new signature; it computes the lintable
  set via a new `lintableFiles(listing)` exported from `import-graph.ts`.
- `buildImportGraphs` uses the same `lintableFiles`, so the recorded set and the
  linted set are the same function of the same listing, by construction.
- The recorded facts are identical to today's: the three globs, one content fact
  per lintable file, one per global trigger.

The listing is handed to the worker (structured clone of ~30k strings), so the
worker never re-lists and cannot see a different tree than the one recorded.

### Files (all flat in `check/`)

New files must sit directly in `check/` or `shared/`: `selfSourceHash()`
(`program-key.ts:194`) hashes only top-level `.ts` files there, and that hash
is part of every program key. A subdirectory would silently fall out of it.

- **`check/prepare.ts`** (new) — the synchronous logic, moved verbatim out of
  `index.ts` (`tsconfigPathOf`, `parseTargetRoots`, `computeOwnership`, the
  closure-cache bucketing, warm-base materialize, program keys, the record
  phase). Exports one entry:
  `openPreparation(input): { plan: Plan; finalize(outcomes): FinalizeReport }`.
  Pure in-process code with no thread knowledge, so it can be tested directly.
  - `Plan` is discriminated:
    `{ kind: "uncovered"; uncovered: string[] }` (the coverage gate, returned
    before any cache is opened, exactly as today) or
    `{ kind: "run"; targets; toRun: string[]; lintByTarget: Record<string,string[]>; skipped: string[]; unkeyed: string[]; keysMs: number }`.
  - `finalize(outcomes: { name; clean: boolean; failedLintFiles: string[] }[])`
    does the four record steps in today's order, from the session's in-memory
    state.
- **`check/prepare-worker.ts`** (new) — the Worker entry. `self.onmessage`
  handles `prepare` (calls `openPreparation`, keeps the session) and `finalize`.
  Every request is wrapped so a throw posts `{ type: "error", message, stack }`
  instead of dying silently.
- **`check/prepare-thread.ts`** (new) — the runner-side host.
  `openPrepareThread(): { prepare(input): Promise<Plan>; finalize(o): Promise<void>; close(): void }`.
  One request in flight at a time. A pending call is rejected on an `error`
  frame, on the Worker `error` event, or on the worker closing unexpectedly —
  so a crashed thread becomes a thrown check error, never a hang. Several of
  those can fire for one failure, so each pending call settles once (a guard,
  not a second rejection). The idle worker between `prepare` and `finalize`
  (minutes, while tsc runs) is kept alive by its message listener; nothing
  terminates it but `close()`, which calls `worker.terminate()`. `index.ts`
  calls `close()` in `finally`.
  - Checks only ever run from source: `release` never runs them, and the
    existing per-target worker already spawns `shared/worker.ts` by path. So
    the sentinel's compiled-release workaround (a vendored worker bundle) does
    not apply here.
- **`check/index.ts`** — becomes the thin orchestrator described above. Drops
  its `typescript` import. Keeps `workerBackground`, `mapConcurrent`,
  `runWorker`, `workerCostLine`, the log lines and the verdict assembly as they
  are. Adds one log line per run:
  `type-check: prepared off-thread in <s>s (finalize <s>s)`, so the cost that
  used to be a freeze is still measured — it is the instrument for the separate
  speed issue.
- **`check/outer-read-set.ts`** — signature change above.
- **`check/import-graph.ts`** — export `lintableFiles(listing)`.
- **`check/outer-read-set.test.ts`** — follow the signature change.
- **`type-check/CLAUDE.md`** — replace the "Shape" section with the split (what
  runs where and why), and add the rule: *nothing that reads file bytes or walks
  the tree runs in `index.ts`; it goes in `prepare.ts`, which only the worker
  imports.*

### Invariants that must not move (from `type-check/CLAUDE.md`)

All three live inside `openPreparation`, in today's order, so the split cannot
reorder them:

1. Program keys are computed **after** `materializeWarmBase`.
2. The skip clause is read **after** `lintByTarget` is built.
3. A PASS is recorded from the buildinfo the worker **wrote**, using the same
   `keyCtx` (and its hash memo) the prepare phase used.

Also unchanged: crashed tsc workers record nothing; `--no-cache` disarms the
skip but not the record; the coverage gate returns before any cache is opened.

## Verification

1. **Unit tests.** `./equin test plugins/framework/plugins/tooling/plugins/checks/plugins/type-check`
   — existing `outer-read-set` and `program-key` suites pass after the
   signature change. Add `prepare-thread.test.ts`: over a small fixture repo
   (the `outer-read-set.test.ts` pattern), (a) the Plan from the thread equals
   `openPreparation(...).plan` run in-process; (b) a thrown error in the worker
   rejects `prepare()` with the worker's stack.
2. **The runner's loop stays free, and the real failure is gone.** A temporary,
   uncommitted probe script (run with `./equin run`) that, in ONE
   process: starts a 1 s timer chain recording the largest gap between ticks,
   opens a `pg` connection to the main DB the way `migration-applies-clean`
   does (`plugins/database/plugins/migrations/check/index.ts:112`), and calls
   type-check's `run()` with `cacheEnabled: false` and a real grant. Run it
   once on `main`'s code and once on this branch.
   Before: largest gap ~70–100 s and the connect fails with `ECONNREFUSED`.
   Target: largest gap under ~1 s and the connect succeeds.
3. **The failing pair, for real.** `./equin check type-check migration-applies-clean`
   on a branch that changes `plugins/database/plugins/migrations/data/` (one of
   the two branches named in the issue, rebased onto this change). Before:
   ECONNREFUSED. Target: both pass.
4. **Cache semantics unchanged.** Run `./equin check type-check` twice on
   an unchanged tree: the second run is an outer-cache HIT (no workers). Edit
   one `.ts` file: the run misses, logs `skipped N of 7` with the same N a
   pre-change run gives, and the transcript's `type-check:` lines match the
   old format plus the new "prepared off-thread" line.
5. **Full pass.** `./equin build` (background) — `build-status.json`
   `status: ok`, and the checks section shows type-check green.

## Follow-up (not in this change)

This fixes type-check, not the class. Any check can still freeze the shared
loop, and nothing names the one that did. The structural guard is a
runner-level event-loop stall detector: it measures loop lag during a check
pass and, above a threshold (say 5 s), writes a line naming the checks running
at the time. That would have pointed at type-check on the first failing build.
Worth filing as its own task.
