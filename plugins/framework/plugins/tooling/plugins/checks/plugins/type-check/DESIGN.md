# type-check — design

Why the rules in [CLAUDE.md](CLAUDE.md) are what they are. Read before changing or removing one.

## One program, and why there is no target list

Why tsc and lint share programs: type-aware linting is ~99 % TS-program construction — the same work tsc does. Separate `typescript` and `eslint` checks (typescript-eslint via `projectService`) pay the cold cost twice.

Rejected: per-runtime targets (`web-core`, `server-core`, `central-core`, `cli`, `tooling`, `tools`, `test`, one worker each). The belief was that they isolate type environments ("a `window` reference in `core/` fails under the node program"). They do not:

- `lib.dom.d.ts` loads everywhere: the node-side tsconfigs set no `lib`, and the default for target ES2023 is `es2023.full`, which includes DOM.
- `@types/node`, `@types/bun`, `@types/react` load everywhere: a tsconfig with no `types` auto-includes every root `node_modules/@types/*` — exactly the set the test tsconfig named explicitly.
- The one program withholding DOM (`lib: ["ES2023"]`) only covered files that six other programs already checked under DOM.

What the split cost, measured from the pooled `.tsbuildinfo` files:

- 30,649 file instances for 8,252 distinct repo files (3.7×).
- The `test` program alone held 8,053 of them (1,076 test-only), so the single program is that program plus ~2.5 % more files.
- A cold miss ran all seven workers at once: ~740 CPU-s and ~30 GB resident simultaneously. One worker is ~180 CPU-s and ~7 GB.

Trade-off: an editor loads the whole ~11k-file project for any file, where a server-only session could load ~5.4k (web sessions already loaded ~9.8k).

Design and full measurement tables: `research/2026-09-18-global-type-check-one-program.md`.

## Shape

- **Why nothing heavy runs on the runner's thread.** Reading bytes and walking the tree is 70–130 s of synchronous CPU. On the runner's thread it froze every concurrent check — no timer, no socket — so `migration-applies-clean`'s pg connect sat silent past Postgres's 60 s `authentication_timeout` and failed with `ECONNREFUSED`. See `research/2026-09-10-tooling-type-check-prepare-off-thread.md`.
- **Rejected: prepare as a helper process.** The session must survive the worker: the record phase reuses prepare's lint entries, versions and directive flags, which a process would have to serialize.
- **Why the walk engine keys only the walk-base namespace.** A base written by other walk code is simply not found, so the run walks every file (no TypeScript, ~1–3 CPU-s) instead of re-checking any. A change to a key's formula misses by itself; every other walk change is held by `walk-replay`, `dual-check` and the backstop. Putting the walk in `tscEngineFp` would re-check the repo on every walk edit for no soundness gain.

## The input is the git tree plus an overlay, read through one view

Why the tree hash, not a filesystem walk: every walk saw _more_ than the cache key, and each copy of the skip rules drifted.

- A stray `.ts` an agent left under `.cache/scratch/` counted as lintable, matched no tsconfig program, and failed a push over content no commit contains.
- A walk skipped a literal `dist` segment but not `dist.staging.*` / `dist.live.*` / `dist.old.*`, so a build artifact moved the global fingerprint.
- Resolution keys hashed the real `readdir` of every probed directory — the repo root among them, reached by every lookup that walks up to `node_modules`. The root's transient entries (`.install.lock`, `.merge_file_*`, `.check-*`) moved ~6,000 files' keys after unrelated commands (~8 worker CPU-s), and the verdict depended on files no key hashed.
- Four independent walks cost seconds of traversal and held four copies of the deny-list (`node_modules`, `dist`, `.check-*`, `.claude/worktrees`). With git as the enumerator, `.gitignore` is the only rule.

See `research/2026-10-21-global-type-check-prepare-follows-the-change.md` and `research/2026-09-09-tooling-check-file-enumeration-from-git.md`.

Other choices:

- **Why `readText` verifies the blob sha.** The lint and name stores are host-wide; a result recorded under another text's key poisons every worktree that later reads it.
- **Why the tree hash is computed under `--no-cache` too.** A tree hash is a fact, not a cache.
- **Why `ts.matchFiles` (internal API).** The overlay expansion must be EXACTLY tsc's, or the coverage gate and the program disagree on the roots. It is asserted present, so a TypeScript upgrade that drops it fails loudly.
- **Why the snapshot is a value, not a module memo.** A snapshot is of a tree that keeps changing; as a memo its staleness window was silently "the rest of the process".

Limit: the outer read-set cannot record the overlay, so an overlay-only change on an unchanged tree can replay a PASS. The inner stores key overlay files by content, so no stored result is ever stale for one.

## The coverage gate is set subtraction

- **Why no import-closure walk.** With per-target includes a file could legitimately sit outside every `include` yet be reachable from one, which needed a forward-import walk from each target's roots. Under one blanket include, a lintable file that is not a root is outside `include` by definition — exactly what must fail.
- **Rejected: an unparseable tsconfig as an empty root list.** It reports every lintable file as orphaned — a wall of noise for one broken JSON file. The `unparsed` arm lets tsc report the one real diagnostic.

## Two programs sized by changed names

- **Why R hashes name meanings, not file text.** `f(r: PluginRegistry)` does not change text when `PluginRegistry` does; it moves through its d-edge, and so does every user of `f`. What a file's check reads is its text, the `.d.ts` of what it imports, everything those name, and the global scope — exactly what R hashes.
- **Rejected: a file-level contract Merkle hash** (re-check every importer of a file whose `.d.ts` moved). Name-level keys move only the files using the names that moved. See `research/2026-10-18-global-tsc-recheck-follows-contracts.md`.
- **Why no globals in `.ts` source.** A global source file is in `global`, so every edit of it re-checks the repo. The incident: a 1,128-line e2e script around a 4-line `interface Window` block. `declaresGlobals` still handles a source global the way tsc does — the lint, not the engine, is the guard.
- **Why cycles settle per file.** Import cycles here are large (the `check/` registries, the lint rules, the exhibits: 100–175 files each). Keying the whole cycle as one unit re-checks all of it for a body edit in one member.
- **Why inference edges exist.** `export const x = foo()` prints `foo`'s return type, so an edit of `foo` changes `x`'s `.d.ts` while `x`'s file is unchanged. JSX elements are skipped (always `JSX.Element`), as are bodies and initializers a written type makes irrelevant.
- **"Made against"** is `depM` for a stored result; for one program 1 just made, it is what program 1 was served. A re-checked file counts as served its previous result; a file served a `.d.ts` it no longer has counts as moved and joins program 2 itself.
- **Why a MISS does not throw in check/build.** A failed run records nothing, so every later run would fail the same way. The whole-program rerun gives the right verdict and the report surfaces the miss. The backstop, `dual-check` and tests throw because a miss is what they look for.
- **Rejected: `isolatedDeclarations`-clean generated registries** (contract-first, to break registry cycles). Needed only when a file waits for another's contract; here each program holds all its sources at once.
- **Why importers get the RAW `.d.ts`.** Serving the sorted canonical text changes how tsc prints a type in an importer's diagnostics (measured).
- **Why import-binding types are canonicalized.** Emit copies `import("s").Rank` from a served `.d.ts` but prints `Rank` when it infers from source; without it the same declarations hash differently.
- **Why every exported value needs a nameable type.** Every checked file's `.d.ts` is emitted and its canonical text per name keys its users; that is what lets a body edit stop at the file.
- **Why in-use entries are rewritten after 3 days.** So the 14-day age bound means "unused", not "old".

Design: `research/2026-10-21-global-type-check-two-programs.md`.

## No program holds more than K files

Motivation: a cold run as one program over ~12.7k files cost 213–327 CPU-s and 26–30 GB in one process. See `research/2026-10-23-global-type-check-bounded-batches.md`.

- **Why a type is spelled by its declaring file.** Emit names a type through whichever module path its program resolved it by — a barrel in one program, the file behind it in a batch served the barrel's `.d.ts`. Without `declaringOf`, 12 of 12.8k signatures diverged from the one-program result.
- **Why a just-emitted `.d.ts` is not "served".** It shows what holding the file as source shows, so it is no stale read in phase 1; a batched run checks, keys and reports what one program does.
- **Rejected: building batch programs one after another in the worker.** It kept 11–15 GB resident; only a fresh process is bounded by K.
- **Rejected: parallel batches.** Every program re-pays the environment (lib, `@types`, npm types: ~10–15 CPU-s); three at once cost +54–125 % CPU.
- **Why linting before the key exists is safe.** A typed result is a function of its key, so linting early and deciding later gives the same outcome.

## The lint cache is keyed on what the rules read, and exemptions apply when it is read

- **Rejected: keying lint on the source of the file's whole import closure.** A body-only edit in a hub re-linted every transitive importer: a median of 470 files per main commit, p90 6,218. A rule reads declarations, never another file's source.
- **Why the engine omits the `.d.ts` files.** A typed part's result key already holds every one the file sees.
- **Why the lockfile digest drops workspace entries.** Workspace-only lockfile changes do not change any rule's behaviour; they would otherwise re-lint everything.
- **Why closures are walked from the lint roots.** ~370 files parsed against the view take 65 ms; reading them off a whole-repo import graph costs 3 CPU-s every run.
- **Why the type-aware group set is stored.** Learning it loads every contribution through the classifier (~1.2 CPU-s); it is reloaded only when a group fp or the typed engine moves.
- **Why typed parts are split per group.** One type-aware rule edit stales only its group's typed part, not every typed result.
- **Why syntactic groups run without a program.** It turns an undeclared type-aware rule into a throw instead of a cached answer that silently read types.
- **Why the directive flag is stored in the entry.** It is a function of the text, so prepare reads only texts with no entry — which are linted anyway.
- **Why keys are ordered by last use.** Two worktrees on two versions of a hub keep each other's results; `finalize` writes an entry only when that order changes.

Design: `research/2026-10-17-global-lint-keyed-on-what-it-reads.md`, `research/2026-10-18-global-typed-lint-key-stops-at-contracts.md`.

## The run base: a run reads only what changed

Motivation: without it every run re-verified every file's lint state on a tree where one file moved — 12.6k per-file entries read and zod-parsed (~2.7 CPU-s), a ~10 MB job shipped to the worker, the verdict assembled over every file.

- **Rejected: `git diff-tree` between base and tree.** The snapshot's versions are already in hand, hashing the listings takes ~10 ms, and it assumes nothing about the base's tree object surviving gc.
- **Why the base is a function of the tree, not a worktree.** Content-addressed and host-wide, so a sibling's run or `main`'s is reusable.
- **Why a prediction-miss run is still recorded.** Its whole-program rerun keyed everything.
- **Why the per-file store stays.** It reuses results by TEXT: an API edit and its revert do not re-lint every user twice.

## The walk base: the walk visits only what changed

Motivation: without it every run read all 12.6k name-record entries and walked every file (~1–3 CPU-s) on a tree where one file moved. See `research/2026-10-21-global-type-check-prepare-follows-the-change.md`.

- **Why `.d.ts` hashes are compared by canonical text in `walks` mode.** tsc prints union members in type-creation order, which follows what its program loaded first, so the same declarations emit in two orders.
- **Why carried shards are touched with their entries, contracts and prediction data.** No fixed file reads them, so nothing else would keep them from aging out.

## Host-wide worker admission — `server/spawnTypeCheckWorker`

- **Why the grant is not the memory bound.** The grant clamps the worker's units to its own size, so a 1-unit holder still runs a whole worker. Up to `B` = 9 holders could each run one. Observed: two to four workers overlapped on a swapping host, each burning 718–2211 CPU-s on a 99.9 %-warm program that takes 29–162 CPU-s alone. The pool slot is the bound.
- **Why the slot is taken before grant units.** A queued worker then holds none of its holder's grant units.
- **Rejected: background-tier workers** (`taskpolicy -b`, on the E-cores). The whole fleet waited out the stretched hold: slot wait median 13.5 min, p90 38 min. The lane picks only the slot window (background's stays 1, so at most 2 foreground workers exist).
- **Rejected: picking the lane by branch.** A push checks the rebased agent branch and is interactive.

Design and the simulation behind the sizes: `research/2026-10-15-global-push-typecheck-lane-priority-and-cap.md`; the foreground holder: `research/2026-10-16-global-scarce-slot-holders-run-foreground.md`; the fleet-thrash bound: `research/2026-07-09-global-type-check-worker-host-budget.md`.

## Reading the transcript

- **Why `cpu`, not wall.** The identical program build measured 105 s at host load 12.8 and 266 s at load 14.0; wall clock on this host measures the neighbours.
- **Why `TYPE_CHECK_WORKER_UNITS` is re-derived from these lines.** It is `ceil(mean peak RSS / PER_UNIT_BYTES)`, and the cost line's `maxRSS` across many runs is that mean.
