# type-check: why its cache misses, what a miss costs, and a per-target program skip

**Date:** 2026-09-08
**Category:** global (checks infra; affects build, push and the host queue)
**Status:** Part 1 BUILT 2026-09-09 (`att-1788944218-aj1a`) — see "As built" at the foot. Part 2
(last-N outer read-set slots, sidequest A.6) not built.
**Sidequest:** A on the "Build, check, …" page (`block-f0d24b10-d743-409d-bbc1-844ed27db026`); A.0
by `att-1788884187-ak4l`, A.1 + Part 1 by `att-1788944218-aj1a`.

## Context

The page's own numbers say type-check is 68% of a serial check pass (410s of 601s) and that its
outer result cache hits only 23% of the time; a miss costs 83s at best and 284s at the median. The
sidequest asked one question: *why does the outer read-set invalidate on 77% of runs?* This document
answers it from the ledger, then measures what a miss actually costs and why — because the answer
to the first question turns out to cap what any outer-cache fix can buy, and the second question is
where the remaining time is.

Everything below is measured on this host (18 cores, 64 GB) on 2026-09-08, from
`~/.singularity/logs/check-progress/*.jsonl` (121 type-check settles since 2026-09-01), the check
transcripts under `~/.singularity/worktrees/<wt>/check-*.log`, and direct runs of the type-check
worker (`shared/worker.ts`) on this worktree's tree.

## Finding 1 — the outer cache has ONE slot for every worktree

`type-check` declares `inputKeyed: true` and no `cacheSignature()`, so the runner's `sig` is `""`
and its read-set slot is `readSetFile("type-check", "")` in `checks/core/cache.ts` — **a single
host-global file, shared by main and every agent worktree**. The read-set it holds records the
blob SHA of every `.ts`/`.tsx` in the tree (7,724 files today) plus the three membership globs, so
it validates only against a tree with byte-identical TypeScript content. Each worktree is on its own
branch, so:

| type-check settles since 09-01 (n = 121) | count |
| --- | --- |
| main (`singularity`): HIT | 24 of 24 |
| worktree: MISS, slot last written by **another** worktree | 64 |
| worktree: MISS, slot last written by the same worktree | 21 |
| worktree: MISS, no slot yet | 3 |
| worktree: HIT (slot from the same worktree) | 9 |

Main hits every time because `push` runs the check on the post-rebase tree — which *is* the new
main — and main's auto-build validates against that same tree a minute later. Worktrees miss two
thirds of the time simply because some other worktree wrote the slot in between. That is the whole
answer to the sidequest's question: **not a broken cache, a slot that is overwritten by design**.
The 2026-07-17 input-keyed design anticipated exactly this ("a bounded per-key index of the last N
read-sets can be added later only if divergent-worktree miss rates warrant it"). They do.

### …but the reachable hit rate is bounded

A HIT needs a tree with identical TypeScript content to a previously PASSED tree. For a worktree
that is: a rebuild after a non-TS edit, or a push right after a build with main unmoved. Splitting
the same 97 worktree runs by whether main moved between a worktree's consecutive runs:

| case | HIT | MISS |
| --- | --- | --- |
| previous run green, main unmoved | 9 | 32 |
| previous run green, main moved | 0 | 17 |
| previous run FAILED (any) | 0 | 15 |
| first run of the worktree | 0 | 24 |

Only the first row can ever hit, and today 9 of 41 do. A per-worktree (or last-N) slot recovers
some of the other 32 — those where the agent did not touch TypeScript between the two runs. Realistic
ceiling: roughly 30–40% of worktree runs, up from 9%. Worth doing, cheap, but it is not "the
biggest single win" the page hoped for: the other 60%+ of runs are legitimately new TypeScript
trees and must run tsc. So the question becomes what a miss costs.

## Finding 2 — a miss runs seven programs, most of them unaffected

On a miss `type-check.run()` spawns one worker per tsconfig target and each builds a full program:

| target | roots | program files | repo files | node_modules files | worker maxRSS (from transcripts) |
| --- | --- | --- | --- | --- | --- |
| test | 955 | 10,453 | 7,481 | 2,972 | 3–8 GB |
| web-core | 4,516 | 9,158 | 6,475 | 2,683 | 2.4–9 GB |
| server-core | 3,235 | 5,271 | 3,726 | 1,545 | 1.6–4.8 GB |
| central-core | 1,532 | 5,254 | 3,709 | 1,545 | 1.6–3.4 GB |
| tooling | 542 | 4,361 | 3,378 | 983 | 1.5–3.4 GB |
| cli | 402 | 4,343 | 3,329 | 1,014 | 1.6–3.7 GB |
| tools | 207 | 1,157 | 396 | 761 | 0.8–1.4 GB |

7,673 distinct repo files, checked 39,000 file-times per miss. Every worker runs on every miss:
the orchestrator's own comment says "tsc still runs for every target regardless". An edit under
`plugins/apps/**/web/` cannot change the verdict of `server-core`, `central-core`, `cli`, `tooling`
or `tools`, yet all five programs are rebuilt. The only per-target reuse today is tsc's own
incremental `.tsbuildinfo`, which still parses the whole program to discover nothing changed.

## Finding 3 — what one target costs, by what changed

Direct runs of `shared/worker.ts`, `lintFiles: []`, this tree. CPU time (user+sys of the worker
process, via `Bun.spawnSync().resourceUsage`) is the trustworthy column: wall clock on this shared
host varies 2.5× with load for the identical operation (one hub-revert cost 105s at load 12.8 and
266s at load 14.0).

| target | base state | run | CPU | wall (load) | maxRSS |
| --- | --- | --- | --- | --- | --- |
| web-core | none | cold | 86.6s | 58.7s (5.8) | 7.7 GB |
| web-core | newest pool base from a sibling worktree, at the real depth | first run in a fresh worktree | 85.9s | 58.7s (6.2) | 8.0 GB |
| web-core | own base, same tree | identical | 23.6s | 16.8s (5.4) | 2.4 GB |
| web-core | own base, one leaf `.tsx` edited (new exported type) | leaf edit | — | 18–20s (7–8) | — |
| web-core | own base, `web-sdk/core/index.ts` edited (1,022 direct importers) | hub edit | — | 71–105s (10–13) | — |
| test | none | cold | 94.3s | 61.9s (4.7) | 10.0 GB |
| test | own base, same tree | identical | 22.9s | 13.9s (5.6) | 2.6 GB |

So per target: an identical tree still costs ~23s CPU and 2.5 GB (parse 9–10k files, compare
versions); a leaf edit is free on top of that; a hub edit costs the same as cold; and the warm-base
pool makes a fresh worktree's first run **exactly** as expensive as cold — 85.9s against 86.6s CPU,
and 8 GB against 7.7 GB. The `test` program holds every `*.test.ts` and `e2e/` file, so it imports
nearly the whole app: it is the most expensive worker (94s, 10 GB), the wall-clock floor of every
miss, and it is rebuilt on any edit anywhere. Note the RAM axis: a skipped worker is not just 23–94s
of CPU saved, it is 2.5–10 GB of resident set that never exists — on a box the fleet notes show
swapping under duress.

Why the pool cannot help much: every base in `~/.singularity/tsbuildinfo/6.0.3/<target>/` carries
real declaration signatures for only 54–143 of ~6,400 repo files; the rest are the placeholder tsc
stores on a `noEmit` cold run (signature = version). A base is only "warm" for files whose
signature is real; for everything else the first change re-checks the whole importer closure,
which for a fresh worktree (sibling delta + main drift) is the whole program. An experiment that
forced signatures via `emitDeclarationOnly` made a leaf edit no cheaper (25s vs 20s), so populating
signatures is not a lever either. (That experiment's first run reported ~40k error lines; they were
6,471 `TS6059` "file is not under rootDir" errors from setting `outDir` without `rootDir` — an
artefact. With `rootDir` set to the repo root, declaration emit is **clean: 0 errors on web-core and
server-core**, measured 2026-09-09. That matters for Finding 6, not here.)

### Method notes (two wrong turns worth recording)

- `.tsbuildinfo` paths are relative to the **buildinfo file's own directory**. My first two
  "sibling base" rounds copied the pool entry into a scratch dir one level deeper than
  `.cache/tsbuildinfo/`, so every path resolved to nothing and tsc re-signatured 6,209 files — an
  artefact of the experiment, not of the pool. Only the depth-correct round (216s) counts.
- Wall clock on this box varies 2.5× with load for the identical operation. Any per-target cost
  claim needs either a quiet host or CPU time (`Bun.spawnSync(...).resourceUsage.cpuTime`).

## Finding 4 — what past commits would have saved (the sample that sizes the skip)

274 commits on main over the last 30 days, each commit's changed `.ts`/`.tsx` files classified by
the programs that contain them today (`program-lists.json` in the analysis scratch dir, from `ts.createProgram`
per target). A commit is a coarser unit than a build — it bundles a whole task's edits — so this
slightly understates what intermediate builds would save.

| programs a commit affects | commits |
| --- | --- |
| 0 (no TypeScript touched) | 16 (6%) |
| 1–2 (one runtime: web+test, or a test-only edit) | 49 (18%) |
| 4 (a shared `core/`: web, server, central, test) | 15 (5%) |
| 6–7 | 194 (71%) |

Mean CPU the per-target skip saves on a commit's tree: **18%; median 2%.** What pushes 71% of
commits to six or seven programs: a file that sits in ≥ 5 programs (168 commits — the top ones are
`server.generated.ts`, `web-tiers.generated.ts`, `check.generated.ts`, `paths/core`), a
`bun.lock`/`package.json` change (83 commits, every plugin addition), and a lint-rule change (51).
The "web-only edit skips 5 programs" case is 13% of commits, not the common case.

Fan-out through importers, same sample (changed files ∪ transitive importers, over 7,659 lintable
files): p25 1%, median 10%, p75 24%, p90 61%. So a quarter of commits are true leaf edits, a
quarter reach more than a quarter of the codebase, and the median edit invalidates a tenth of it.
This is what per-file incremental checking (tsc's own, inside a program) already re-checks; the
rest of a miss is fixed parse cost and duplication.

## Finding 5 — the same file is checked 3.7 times per miss

Program membership over the 7,673 distinct repo files: 947 files sit in one program, 3,014 in two
(web + test), 3,079 in **six** and 180 in all seven. The node-side programs (`server-core`,
`central-core`, `cli`, `tooling`, `tools`) are five near-copies of one another — `cli` and
`tooling` pull the whole server plugin registry through `server.generated.ts`, and `central-core`
is `server-core` minus 18 files — and `test` contains everything but 301 files. Per cold miss that
is **28,494 file-checks for 7,673 files**. Two layouts, same compiler options per runtime:

| layout | file-checks per miss | vs today |
| --- | --- | --- |
| today: 7 programs | 28,494 | — |
| 3 programs: node-side union (3,823 files), web-core, test | 17,779 | 38% fewer |
| 1 program: everything under one tsconfig (test already nearly is) | 7,673 | 73% fewer |

The multi-program check is deliberate in one respect (the plugin's CLAUDE.md: shared `core/` files
are checked under every runtime's lib/types, so a `window` reference in `core/` fails under the
node program). Merging keeps that property only if the runtimes' libs still differ per program;
the five node-side programs share the same lib and could merge into one with no loss.

## Finding 6 — zones: what past commits touch, and whether a zone layout is a DAG

Same 30-day sample (257 commits with TypeScript changes), by top-level group touched (a commit can
touch several): framework 66%, primitives 40%, apps 37%, page 25%, conversations 25%, infra 22%,
tasks 16%. **79% touch framework or primitives.** Inside framework the edits land in `tooling`
(418 file-commits) and `cli` (235) — leaf zones that nothing imports — far more than in the true
hubs `web-sdk` (123) and `server-core` (73). Inside primitives: `css` (351), `data-view` (219),
`pane` (118), `adaptive-bar` (102). So zone granularity matters: `framework` as one zone would
rebuild every dependent on every tooling edit; `framework/tooling` as its own sub-zone cascades to
nothing. Only 2% of commits stay inside `plugins/apps/`.

**Does a zone definition exist?** The boundary checker (`tooling/plugins/boundaries`) has the
mechanism: `zone()` / `allow()` / `deny()` in `core/config.ts`, a first-match zone-DAG layer in
`boundary-config.ts`, and zones discovered from the plugin tree with nested dotted names
(`plugin.infra.secrets.central`). What it does not have is a *layered* definition: the only zone
today is `plugin` (every plugin), and the DAG layer allows `plugin.** -> plugin.**`.

**Are the folders a DAG?** No — measured on runtime code only (web/server/central/core/shared,
composition roots and lint/check/e2e/bin/cli excluded), `zone-dag2.ts` in the analysis scratch dir
(the scripts live at `/tmp/att-1788884187-ak4l-scratch/scratch/` on this host until A.1 commits
them under the type-check plugin's `scripts/`; they cannot sit in the worktree's `.cache/` because
type-check's file walk descends into it and fails the coverage gate on any `.ts` there):

| granularity | zones | cycles |
| --- | --- | --- |
| top-level groups | 34 | one cycle of 30 groups (`active-data` → tasks, page, apps, conversations → back) |
| framework/* | 10 | `web-sdk` → `tooling` (collected-dir core) → `web-core` (web-artifacts identity) → `web-sdk` |
| primitives/* | 77 | one cycle of 15 through `css` (its `ui-kit` child is imported by everything while `css` imports 14 zones) |
| infra/* | 33 | `events` ↔ `jobs` (via `jobs/supervised-job`) |

The plugin-level DAG holds (the boundaries check enforces it), but umbrellas are semantic groupings,
not layers. A zone layout therefore has to be cut along the plugin DAG — a condensation into layers,
declared as sets of plugins independent of folder position, then held by `deny` rules in the same
config — and a handful of edges above (tooling → web-core, css umbrella vs ui-kit, events ↔ jobs)
need untangling first.

## The fix, in two parts

### Part 1 (the win) — per-target program fingerprint skip

Give each tsc target a content-addressed key for *its program*, and skip the worker when that key
was already recorded as a PASS — host-globally, so main's pass serves a push whose server programs
are unchanged, and a sibling's pass serves a fresh worktree.

**Why the key is NOT the import-graph closure.** The obvious key — fold each root's closure
fingerprint from `computeClosureFingerprints` — inherits the import graph's blind spots
(`*.generated.ts` are excluded from the graph yet are tsc roots, e.g. `check.generated.ts` under
`tooling/tsconfig.json`'s `plugins/*/core` include; `/// <reference>`, `require()`, computed
`import()`, resolution shadowing by a newly added file). Today those blind spots are harmless
because tsc re-runs on every miss and is the backstop; a skip *removes* that backstop, so the key
must be built from what TypeScript actually loaded, not from an approximation of it.

**Key.** TypeScript already records the exact program of the target's last run: the `fileNames`
array of `.cache/tsbuildinfo/<target>.tsbuildinfo` (paths relative to that file's directory; 4k–10k
entries, repo files and `node_modules` files alike). Call it `L_t`. For target `t`:

```
programKey(t) = sha256(
  "v1"
  + "\n" + selfSourceHash                    // sha256 over type-check/{check,shared}/** + checks/core/discover.ts
  + "\n" + globalConfigFingerprint(root)     // tsconfig*, package.json, bun.lock, *.d.ts, eslint config, lint rules
  + "\n" + tsconfigPathOf(t)
  + "\n" + sha256(sorted(R_t))               // R_t = parsed.fileNames: the tsconfig's include expansion
  + "\n" + sha256(sorted(allTsNames))        // every .ts/.tsx/.d.ts path in the repo, names only
  + "\n" + sorted(L_t).map(f => f + "\0" + contentHash(f)).join("\n")   // repo AND node_modules files
)
```

Soundness argument, in one paragraph: a program is a function of (roots, file contents, compiler
options). `L_t` was the program for these roots on some earlier tree; if every file in `L_t` has
identical content now and the roots are identical, module resolution runs the same and yields the
same program, so the same verdict. Roots are covered by `R_t`; options by the tsconfig contents
(global trigger) and `tsconfigPathOf`; the one way resolution can change without any `L_t` content
changing is a **newly added file shadowing a resolution** (`foo.ts` appearing beside `foo/index.ts`),
which `allTsNames` closes by over-invalidating on any added or removed TypeScript file; `node_modules`
contents are hashed directly (≈3k files per target, memoised across targets, tens of MB — well under
a second) rather than trusted through `bun.lock`, which closes the critique's "hand-patched
dependency" hole; the worker's own behaviour is code, covered by `selfSourceHash`. This is strictly
tighter than the import-graph envelope the lint cache lives in, and it holds regardless of which
worktree produced `L_t` — so a pool base's list is as good an enumerator as a local one.

`L_t` comes from the local buildinfo, which `materializeWarmBase` (already called per target before
fan-out) seeds from the pool when absent — so a fresh worktree can skip against a sibling's or
main's pass on its very first run. No buildinfo anywhere → no skip, cold run, and the key is
recorded afterwards from the buildinfo the worker just wrote. A buildinfo without a `fileNames`
array (format drift) → no skip, never a wrong skip. Content hashes are computed once per path and
shared by all seven keys (the programs overlap heavily).

**Skip condition.** `programPasses.has(t.name, programKey(t)) && (lintByTarget.get(t.name) ?? []).length === 0`,
evaluated **after** `lintByTarget` is built from the per-file closure cache. The ordering is load-
bearing (the critique's point): if the per-file cache ever evicts a file's lint PASS, `lintByTarget`
becomes non-empty again, the skip is defeated, and the worker re-runs and re-records both caches.

**Record condition.** After `runWorker` returns for `t` with `tscErrors === ""`, `lintViolations
=== ""` and no crash: `programPasses.record(t.name, programKey(t))`, with `L_t` re-read from the
buildinfo the worker just wrote (so the recorded key describes the program that actually passed).

**Store.** A sibling of the closure cache, not a namespace inside it: `programPassDir`, a new
`defineDataDir` in `data-dirs/index.ts` (`kind: "cache"`, `reclaim: { kind: "safe" }`), with the
`entryFile` / atomic write-then-rename / 14-day age prune pattern lifted from `closure-cache.ts`
into a small shared `pass-set.ts` both stores use. Separate directory because the two caches are
keyed on different things and the data-dir declaration is the audit's description of what lives
there — the same reason the closure cache and the tsbuildinfo pool are already split.

**Where this sits in the layering** (the critique asked): it is the per-target granularity of the
outer input-keyed read-set, not a third mechanism. The runner's read-set works at check granularity
and cannot express "this check is seven programs"; making checks composite is a runner refactor out
of proportion to the win. So the outer read-set stays the whole-check fast path, this key is the
per-program fast path inside the check, and the per-file closure cache stays lint-only.

**Observation.** One `ctx.log?.()` line per run, e.g.
`type-check: skipped 5 of 7 targets, program unchanged since last pass: central-core, cli, server-core, tooling, tools`,
so the per-target hit rate is greppable in `check-<runId>.log` exactly like the maxRSS lines.

**What does not change.** Coverage gate, ownership, the closure-cache lint filter, worker protocol,
grant accounting (skipped targets spend no unit), `publishWarmBase` and the maxRSS lines (both
iterate `results`, which only holds workers that ran — a skipped target is absent by construction,
and the skip path must never push a synthetic entry into `results`).

**Expected effect, per run** (CPU seconds are load-independent; wall clock on this host is not):

| scenario | today | after | saved |
| --- | --- | --- | --- |
| nothing changed (push after build, rebuild after a docs/CSS edit) | 7 programs parsed, ~120 CPU-s, 7 × 2.5 GB | key lookups + the graph/fingerprint pass, a few seconds | ~95% |
| edit under a plugin's `web/` | 7 programs, 130–370 CPU-s | `web-core` + `test` only | ~40–50% CPU, 5 workers' RAM |
| edit under a plugin's `server/` | 7 programs | `web-core` skipped, the rest run | ~25–35% |
| edit under a shared `core/` or a framework barrel | 7 programs | 7 programs | 0 |
| one build's wall clock | bounded by `test` | still bounded by `test` | little |

Sized on the 30-day commit sample (Finding 4), the per-target skip saves a **mean 18% (median
2%)** of a miss's CPU, because most tasks touch a shared `core/` file or a generated registry that
sits in six programs. Its solid win is the unchanged-tree run (7 of 7 skipped, ~95% saved), whose
share of runs is somewhere between the 9% observed and the 42% ceiling of Finding 1. Blended, this
is on the order of 25–40% of type-check CPU fleet-wide and most of its peak RAM — worth its few
days, but **not the structural fix**. That is Finding 5: the same files are checked 3.7 times per
miss, and merging the five node-side programs alone removes 38% of the work on every miss, edit
mix or not. The key used for the skip drops the lint-only globals (`eslint.config.ts`,
`plugins/**/lint/**`) so a lint-rule commit no longer flips every program's tsc key; lint still
re-runs through `lintByTarget`.

**Rollout in two steps, so before and after are read off the same instrument.** *(NOT how it was
built — the two steps were collapsed into one at the user's direction, and there is no shadow mode
and no `SINGULARITY_TYPECHECK_SKIP` switch in the shipped code. See "As built" at the foot.)*

1. *Instrument + shadow (no behaviour change).* Each worker's transcript line gains its CPU seconds
   (`spawnCaptured` already returns `resourceUsage`), and one line names the targets the key WOULD
   skip. A few days of that gives the true baseline (CPU per run, would-skip histogram) and the
   soundness check: any run where a target would have been skipped but its worker reported a tsc
   error is a bug in the key, caught before the key has skipped anything. Env switch
   `SINGULARITY_TYPECHECK_SKIP=shadow|on`, default `shadow` for this step.
2. *Flip to `on`* (default). Success, over the following week, from the same lines: median CPU per
   worktree miss down ≥ 30%; identical-tree runs skip 7 of 7; zero skipped targets that later fail
   on a tree where their key was unchanged. Secondary, confounded: host-grant wait per op in the
   op ledger, direction only.

### Part 2 (cheap, independent) — last-N read-set slots for the outer cache

In `checks/core/cache.ts`, keep the last `N = 8` read-sets per `(checkId, sig)` instead of one:
`readSetFile(checkId, sig, i)` for `i` in a ring, `loadReadSets()` returning newest-first, and the
runner validating each until one hits (validate is an in-memory replay over the snapshot; 8 × 1.6 MB
JSON reads is ~100 ms). `recordReadSet` writes the next ring slot. This lifts type-check's outer hit
rate from 9% to the 30–40% ceiling in Finding 1 and helps every other input-keyed check the same
way. With Part 1 in place an outer HIT saves the graph/fingerprint pass and the 7 skip lookups,
nothing more — so Part 2 is a nicety, and can ship second or not at all.

## Out of scope, filed as follow-ups (add_task after approval)

- **Program layout (Finding 5).** Merge the five node-side programs into one (38% fewer
  file-checks per miss, 3 workers instead of 7, no loss of the per-runtime lib check), and decide
  what `test` should be — today it is a second copy of the whole app under DOM+node libs. Larger
  than a cache change; separate design, and the one that moves a single build's wall clock.
- **Zone-level project references** (`tsc -b`; sub-sidequest A.3 on the page): checks each file
  once and only re-checks the median 10% an edit reaches. Declaration emit — the precondition — is
  clean once `rootDir` is the repo root (0 errors on web-core and server-core, 2026-09-09). What
  remains is the zone cut along the plugin DAG and the cycle edges in Finding 6, plus a few dozen
  generated tsconfigs (one per zone × runtime, nested zones for framework/* and primitives/*).
  Supersedes the two bullets above if it goes ahead.
- **The warm-base pool is not measurably useful** (Finding 3). Leave it; revisit only with CPU-time
  numbers on a quiet host.
- **Page "Caching" section**: the cross-check cache tree remains aimed at 83s of cheap checks (see
  the fan-out note); nothing here changes that.

## Files

- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts` —
  `computeOwnership` also returns each target's parsed roots (it already parses every tsconfig;
  today it discards `parsed.fileNames` after seeding the ownership walk); compute `programKey`
  after `lintByTarget`, gate `runWorker` on the skip condition, record on a clean return, emit the
  observation line.
- new `check/program-key.ts` — `readProgramFileList(buildInfoPath)` (the `fileNames` read, relative
  to the buildinfo's directory, `null` on absence or format drift), `selfSourceHash()`,
  `programKey(...)` with the memoised content-hash map. Unit-tested.
- new `check/pass-set.ts` — the content-keyed PASS set (`has` / `record` / prune) extracted from
  `closure-cache.ts`, which becomes a thin instantiation over `closureCacheDir`; `program-key.ts`
  instantiates a second one over `programPassDir`.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/data-dirs/index.ts` — add
  `programPassDir`.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/CLAUDE.md` — the "Warm
  paths" bullet gains the per-target skip and its soundness envelope.
- Part 2: `plugins/framework/plugins/tooling/plugins/checks/core/cache.ts` (ring slots) and the
  input-keyed branch of `checks/core/runner.ts` (iterate candidates).
- Tests: `check/program-key.test.ts` over a throwaway tree with a hand-written buildinfo covering
  key stability, a content change of a listed file (repo and `node_modules`), a root-set change, an
  added shadowing file, a missing / malformed buildinfo (no key), and a self-source change;
  `outer-read-set.test.ts` pattern for Part 2's ring.

## Verification

1. `./equin check type-check` twice on an unchanged tree: the second run's transcript
   (`~/.singularity/worktrees/<wt>/check-<runId>.log`) shows `skipped 7 of 7 targets` and the
   check settles in seconds (this also measures the graph + fingerprint floor).
2. Edit one file under `plugins/apps/**/web/`, run again: `skipped 5 of 7` (`web-core`, `test`
   run); revert, run again: `skipped 7 of 7` (content-addressed, so the revert hits the old key).
3. Edit a server-only file: `web-core` is skipped, `server-core`/`central-core`/`test` run (a
   `core/` edit shared by both sides runs everything — correct).
4. Introduce a type error in a skipped-by-default target's file and confirm the check FAILS
   (the key changes because the file's closure fingerprint changes).
5. `./equin test plugins/framework/plugins/tooling/plugins/checks/plugins/type-check` for the
   new unit tests; `./equin check` for the full suite; `./equin build` to deploy.
6. Shadow phase (step 1 above): after a few days, grep transcripts for `would skip` and the
   per-worker `cpu` lines — baseline CPU per run, would-skip histogram, and zero
   would-skip-but-failed cases.
7. After the flip: the same grep gives `skipped N of 7` and CPU per run; compare against the
   baseline with the thresholds above. That before/after pair is what the page's sidequest A box
   gets updated with.

---

## As built (2026-09-09, `att-1788944218-aj1a`)

Part 1 shipped, plus A.1's instrumentation. What differs from the plan above, and why:

- **No shadow phase, no `SINGULARITY_TYPECHECK_SKIP` switch.** The plan staged the skip behind an
  env flag for a few days of observation; the user asked for the flip in one pass instead. The
  instrumentation still shipped alongside it, so before and after are read off the same lines — the
  reason the two-step existed. What is lost is the "would skip but the worker then failed" alarm,
  which only a shadow run can produce; its replacement is the `skipped N of M` line plus the fact
  that any missed invalidation shows up as a check that passes on a tree it should have failed.
- **`spawnCaptured` did NOT already return CPU time.** The plan assumed it did. `resourceUsage`
  carried only `maxRssBytes` — every call site had hand-picked that one field off Bun's rusage
  object, and `cpuTime` (BigInt microseconds) was simply dropped. Fixed at the primitive:
  `ChildResourceUsage { maxRssBytes, cpuTimeMicros }`, produced by ONE `readResourceUsage()` that
  both spawn shapes call, so the two can no longer report different subsets of the same syscall.
- **The key hashes every `package.json` in the repo**, not only the root one the plan's
  `globalConfigFingerprint` reuse would have covered — a nested manifest's `exports` / `imports` /
  `type` can move a resolution. `findFiles(root, predicate)` was extracted in `fingerprint.ts` so
  the lint trigger set and the tsc trigger set are two predicates over ONE walk, and cannot
  disagree about what the repo's files are.
- **Dropping the lint-only globals from the tsc key needs no second mechanism.** A lint-rule edit
  flips `globalConfigFingerprint`, which flips every closure fingerprint, which leaves every
  target's `lintByTarget` bucket non-empty — and a non-empty bucket already refuses the skip. The
  narrowing removes a redundancy, not a guard.
- **A skipped target re-records its key.** Not in the plan. The store ages entries by when they were
  last written, so without this a target that skipped successfully every day would be evicted at 14
  days for being *used*. One tiny write per skipped target makes the age bound mean "unused".
- **`computeOwnership` no longer parses tsconfigs.** `parseTargetRoots` does it once and both
  consumers read the result; a target whose tsconfig will not parse is ABSENT from the map rather
  than present-and-empty, which is what stops a key being minted for a program we could not
  describe.
- **`pass-set.ts` extracted as planned**, and `closure-cache.ts` is now a thin instantiation over
  it. Entry addressing is byte-identical to before (`sha256("<rel>:<fingerprint>")`), so no existing
  closure-cache entry was invalidated by the refactor.

### The envelope, stated exactly

In the key: `L_t` (every file the program loaded, per the buildinfo tsc wrote — repo and
`node_modules` alike, hashed by content), `R_t` (the tsconfig's include-expansion), the tsconfig
path, every `tsconfig*.json` / `package.json` / `bun.lock` / repo `*.d.ts` by content, a name-only
census of every `.ts`/`.tsx` in the repo, and this check's own source (`check/**`, `shared/**`,
`checks/core/discover.ts`, named RELATIVELY — an absolute path would carry the worktree name and
make the host-global store useless while still looking like it worked).

The one edge outside it: a file **added** inside `node_modules` with no lockfile change. Modified
dependency files are caught by their content hash, removed ones become `"-"`, and any real
`bun install` rewrites `bun.lock`. Only a hand-copied file can shadow a resolution invisibly, and
enumerating ~100k dependency paths every run to close that is not a trade worth making.

- **The repo walk is memoised, and that was a fix worth making on its own.** The first
  instrumented run reported `program keys 3837ms` on a COLD tree — where no file content is hashed
  at all, because no target has an enumeration yet. All of it was traversal: a single check pass was
  walking the whole repo FOUR times (the closure fingerprint's trigger set, the outer read-set's
  copy of the same set, the program key's tsc triggers, the program key's name census). The run now
  takes ONE `readTreeListing(root)` and passes it to all four, so they share a traversal and — more
  to the point — one set of traversal RULES, three fewer places for "skip nested worktrees" to drift
  from. It is a VALUE, not a memo behind the function: a snapshot of a changing filesystem needs a
  visible lifetime, and the first attempt (a module-level cache keyed on root) was caught by its own
  unit test, where two readings within one process legitimately had to differ.
- **`readProgramFileList` and `programKey` return discriminated results, not nullables.** The first
  version returned `null` from a bare `catch`, which the repo's own `no-absorbed-failure` and
  `no-bare-catch` rules caught on the first real run — correctly: "no buildinfo yet" (ordinary, cold)
  and "the buildinfo is torn" (worth naming) are different facts, and a nullable flattens them. The
  check now names every target it could not key, and why.

### The cold baseline, measured 2026-09-09

The first run with the instrumentation, on a fresh worktree with no `.tsbuildinfo` at all
(7 targets, 6 concurrent under the host grant, 900s wall):

| target | CPU | maxRSS |
| --- | --- | --- |
| test | 307.6s | 7.3 GB |
| server-core | 228.2s | 3.9 GB |
| cli | 215.8s | 1.6 GB |
| central-core | 203.5s | 795 MB |
| tooling | 174.2s | 745 MB |
| web-core | 167.4s | 2.7 GB |
| tools | 45.8s | 267 MB |

**1,342 CPU-seconds per cold miss**, and `test` is both the most expensive worker and the wall-clock
floor. That is the number every later claim is measured against — and it is the first time this
fleet's cost has been recorded in a load-independent unit at all.

### Verified end to end, 2026-09-09

Four consecutive runs on this worktree. Worker CPU is the sum of the per-worker `cpu` lines; the
orchestrator column is the CLI process's own user time.

| run | tree | line | workers | worker CPU |
| --- | --- | --- | --- | --- |
| 1 | fresh worktree, no `.tsbuildinfo` at all | `skipped 0 of 7` | 7 | 1,342s |
| 2 | same tree, warm bases, keys invalidated by editing the check itself | `skipped 0 of 7` | 7 | 344s |
| 3 | one comment appended to a `web/` component | `skipped 5 of 7: central-core, cli, server-core, tooling, tools` | 2 | 251s |
| 4 | that comment reverted | `skipped 7 of 7` | **0** | **0s** |

Run 3 is the mechanism working exactly as designed: an edit that cannot reach the server-side
programs does not rebuild them. Run 4 is content-addressing working: the revert produced the same
keys run 2 recorded, so nothing ran — and note the outer read-set MISSED on that run (its recorded
content was run 3's), which is the point. **The per-program store rescues precisely the case the
outer cache cannot**: one host-global read-set slot that siblings keep overwriting (Finding 1's 64
of 97 misses) still misses, while the per-program keys hit and no worker starts. That largely
subsumes Part 2 / sidequest A.6 rather than waiting on it.

What run 4 also exposes: with every worker skipped, the run still costs about **85 CPU-seconds in
the orchestrator itself** — the import graph, the closure fingerprints over 7,700 files, the tree
snapshot and the program keys (1.8s of that). That is now the floor of a type-check pass and the
next thing worth attacking; before this change it was invisible under the workers.

### A build skips less than a bare check, and that is not a defect

The `./equin build` immediately after run 4 reported `skipped 1 of 7` (only `tools`), and a
bare `./equin check type-check` on the very next command reported `skipped 7 of 7` again. The
difference is real and worth knowing: **a build regenerates codegen artifacts BEFORE it runs
checks**, so its checks see a tree that just changed. In this build the changed file was a barrel
stub, regenerated because this very change added a type to spawn's barrel — a file six of the seven
programs load, and `tools` does not.

That is Finding 4 restated from the other side: the generated registries and barrel stubs are the
single biggest key-buster, present in six or seven programs, and a build touches them by
construction. So the skip pays off most on `push` and on repeat checks, and least on the first build
after a change that moves a registry. It is a reason to want zone-level projects (A.3), where a
registry edit re-checks the zones downstream of it rather than every program — not a reason to
distrust the key.

### What to read off the transcript now

`~/.singularity/worktrees/<wt>/check-<runId>.log`:

```
type-check: skipped 5 of 8 targets, program unchanged since last pass: central-core, cli, tooling, tools, web-core-node (program keys 900ms)
type-check worker web-core: cpu 86.6s, maxRSS 2.4 GB
```

Success, over the following week, on the thresholds the plan set: median CPU per worktree miss down
≥ 30%; an identical tree skips every target; and zero cases of a target skipped on a tree where it
would have failed. `cpu`, never wall clock — the identical `web-core` build measured 105s at load
12.8 and 266s at load 14.0.
