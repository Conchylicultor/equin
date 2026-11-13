# type-check

Rationale (why each rule is so, rejected alternatives): [DESIGN.md](DESIGN.md) — read before changing or removing a rule.

The unified TypeScript + type-aware-ESLint check:

- tsc diagnostics and type-aware lint run in the SAME programs (typescript-eslint `parserOptions.programs`), in one worker process;
- **at most two programs per run, sized by what changed**;
- against host-wide per-file stores.

## One program, and why there is no target list

There is exactly ONE TypeScript project: the root `tsconfig.json`, `include: ["plugins", "test", "*.config.ts"]` (every tracked `.ts`/`.tsx`), named by `repoProgram(root)` in `checks/core/discover.ts`.

A run's two programs are views of it (files to check as source, the rest as stored `.d.ts`), not targets.

- **Do not reintroduce per-runtime targets** (web/server/cli/test tsconfigs, one worker each).
  - They bought no type-environment isolation — six of seven loaded DOM, `@types/node`, `@types/bun`, `@types/react` alike.
  - They cost 3.7× file instances (~740 CPU-s, ~30 GB per cold run).
  - Runtime isolation is `plugin-boundaries`' job, not tsc's.
  - Read `research/2026-09-18-global-type-check-one-program.md` before proposing any second project.
- **Every file is checked against exactly one project**; within a run at most twice (program 1, then program 2 when a `.d.ts` it was served turned out stale) and linted once, in the last program holding it.
- An editor loads this one ~11k-file project for any file.

## Shape

| Where | Runs | Holds |
| --- | --- | --- |
| `check/index.ts` | the check runner's thread (shared by every check) | only: `ctx.snapshot()`, the outer read-set (from the snapshot's paths), the grant spend, log lines, verdict |
| `check/prepare.ts` (Bun `Worker`; entry `prepare-worker.ts`, host `prepare-thread.ts`) | preparation thread, one per run | reads the input (`shared/repo-view.ts` `readCheckTree`), coverage gate, lint group fingerprints, run base choice, sends the worker only files whose lint state does not carry; after the worker, `finalize` records results, writes the next base, assembles the verdict |
| `shared/worker.ts` | worker **process** | the two-program check (`shared/name-run.ts`) + ESLint `Linter.verify` per file |

- **Nothing that reads file bytes or walks the tree goes in `index.ts`** — it goes in `prepare.ts`. That work is 70–130 s of sync CPU; on the runner's thread it froze every concurrent check (a pg connect elsewhere timed out).
- Prepare is a thread, not a process, because the record phase reuses prepare's lint entries, versions and directive flags in memory.
- The worker is a separate process so TS work gets its own core and its peak RSS is measurable.
- **New files go FLAT in `shared/`** — both derived engine hashes cover its top level only, so a subdirectory throws (`engineSources`), and so does a producer import that leaves `shared/` unless `OUTSIDE_PRODUCER_IMPORTS` (`shared/tsc-engine.ts`) declares why it cannot change a stored result:
  - **producer** (`producerSources()`): the `shared/` import closure of what produces a stored result (`name-check`, `name-store`, emit options). In `tscEngineFp` (moving it re-checks every file) and in lint's typed engine.
  - **walk** (`engineSources()`: every top-level non-test `.ts` but the worker plumbing and the oracle): keys only the walk base store's namespace (`openWalkBaseStore`). Editing the walk, the bases or `name-run` re-checks nothing — at worst a full walk (~1–3 CPU-s).

## The input is the git tree alone, read through one view

The check is `inputKeyed`: the verdict must be a function of `ctx.snapshot()`'s tree hash. Everything reads the input through `RepoView` (`shared/repo-view.ts`).

- **A file's version is its git blob sha.**
  - Stores are keyed on it, so lookups read no file.
  - A file's bytes are its blob's, by construction: `readText` takes the disk's only when they hash to the version, else reads the blob out of git's object store (where `computeTreeHash` wrote it). An edit or a push advancing the checkout mid-run changes nothing the run reads (a result under the wrong key would poison a host-wide store); a blob the store lacks throws.
- **No gitignored file is in the input**, even under the tsconfig `include` — the per-composition `*.composition.*.generated.ts` registries are build output a build rewrites mid-run (they were once an "overlay" beside the tree; DESIGN.md says why it went).
  - `readCheckTree` expands `include` over the tree's listing with `ts.matchFiles` (internal, asserted present, so it is EXACTLY tsc's expansion).
  - The tree crosses to the worker as its hash (`TypeCheckTree`); the worker loads it itself.
- **Every in-repo question is answered by the view** — tsconfig roots, module resolution (`RecordingResolver`), resolution keys (`ProbeFs`).
  - Anything on disk but not in the view (transient root files, build output, a stray file) does not exist for the check.
  - `node_modules` and paths above the root use the real fs, pinned by the lockfile in the engine.
- **Nothing walks the filesystem**, and each side takes the tree once and passes the value around (runner: `ctx.snapshot()`; prepare and worker: load by hash).
  - A value, not a module memo, so the staleness window stays at the call site.
  - `no-adhoc-repo-walk` bans hand-written directory deny-lists.
- The lint predicates spell only what `.gitignore` does not (`*.generated.ts`, `prototypes/**`; rest of eslint's ignore list in `lint/core/build-lint-config.ts`).
  - **Never restate `node_modules` / `dist` / `.check-*` / `.claude/worktrees` there.**
  - The root tsconfig `exclude` is the one legitimate copy (it needs `**/node_modules`, the `dist*` trees and the gitignored composition registries, for an editor's program; dot-dirs never match a wildcard).
- A build skips less often than a bare check of the same tree: build regenerates stubs and registries, which are in the program.

## The coverage gate is set subtraction

`uncovered = lintable − roots` (roots = the tsconfig's include-expansion).

A lintable file outside `plugins/`, `test/` and root `*.config.ts` fails it. Fix it by one of:

- moving it under `plugins/`;
- adding a genuinely new source tree to the root tsconfig `include`;
- if it is not source, deleting or gitignoring it.

A tsconfig that will not PARSE is its own `unparsed` arm (not an empty root list): the gate is skipped and tsc reports the broken config.

## Two programs sized by changed names

`shared/name-run.ts`:

1. **Program 1:** files with no valid stored result as source; every other repo file served as its stored `.d.ts`, a virtual `x.d.ts` beside `x.ts` (`shared/name-host.ts`).
2. **Affected set, no TypeScript** (`shared/name-walk.ts`): files whose key moved given program 1's records, plus every file using a name that can move.
3. **Program 2:** the affected set (plus files whose typed lint must run and no program holds) as source.

A body edit is program 1 alone. A global change (global `.d.ts`, producer engine, dependency, compiler options) misses every key: program 1 is the whole tree, in batches.

**Keys.** Each exported name's record (`shared/name-records.ts`) is its canonical `.d.ts` text hash `t` plus its name-use edges `d` (import bindings, `import("./e").T`, other exports of the file; a barrel name is an alias edge):

```text
# M: a cycle of names gets one hash
M(F#n) = H( t, M of each d-edge target )
R(F)   = H( global, F's path and version,
            (use, M(use)) of every name F's source uses )
```

`global` = `tscEngineFp` (compiler, options, lockfile, the patches the compiler can see — `typeVisiblePatch`: one touching only JS, native code or source maps is out, as tsc reads no `.js` without `allowJs` — `producerSources()`) + every global source file's and global repo `.d.ts`'s version. A stored result is valid iff its R is today's.

A repo `.d.ts`'s reach is read from syntax (`declScope`, checked against the checker):

- a script / `declare global` / augmentation / `/// <reference>` is global;
- a script of only `declare module "pattern"` is AMBIENT — a use by each file whose specifiers it matches (`ambientUses`);
- adding/dropping an ambient module name walks every file.

The rules that follow:

- **No `.ts` source file declares globals** — lint `type-check/no-global-declaration-in-source`.
  - A `declare global` in source makes every edit of that file re-check the repo.
  - Park a value on `window` with a cast at the use site (`(window as Window & { __x?: T }).__x`, or a `…Window` type in a plugin's `core/`).
  - A real augmentation is a declaration-only `.d.ts`.
- **Import cycles SETTLE**: members start on their newest variant, are keyed, invalid variants demoted, until stable. Keys stay per file (a body edit in a cycle checks the file only).
- **Inference edges** (`shared/name-check.ts`) predict, not key.
  - `export const x = foo()` prints `foo`'s return type, so an edit of `foo` can move `x`'s `.d.ts`.
  - Names reachable over d ∪ i edges from a target whose meaning differs from what the result was made against (`depM`) are ⊥; every user of a ⊥ name joins program 2.
  - After program 2 every name predicted stable is compared; one that moved is a **MISS**, handled per the job's `onMiss`:
    - `whole` (check/build) discards the attempt and re-checks everything over an empty-read store; `spawnTypeCheckWorker` files a `type-check-divergence` report (kind `prediction`, `server/internal/miss-reports.ts`) + a `PREDICTION MISSED` line. Do not throw there (a failed run records nothing, so every later run would fail alike).
    - backstop, `dual-check` and tests use `throw`.
- **The store** (`shared/name-store.ts`) is host-wide, content-addressed per file TEXT:
  - `type-check-name-records` (key H(path, version)): imports, resolution record, global flag, up to four results each under its R. Written only for a file checked, or whose resolution key moved while its targets did not — never for one only read (the read promotes it).
  - `type-check-contracts`: raw `.d.ts` by hash, program-level diagnostics per global hash.
  - Entries in use are rewritten after 3 days, so the 14-day age bound means "unused".
- **Every store is a pass set** (`shared/pass-set.ts`): one JSON file per entry, in age generations (`generations/g<N>/`, N = floor(now / (maxAge / generations))).
  - A record goes into the current generation; a read, `has` or `touch` hitting an older one hard-links it forward, so the bound is "unused for maxAge" (kept more than `minLifetimeMs`).
  - An open lists only `generations/` and drops the generations that left the window whole (renamed aside, then unlinked at most 2000 entries per open): O(1) at any store size. The count backstop reads one write counter per generation.
  - The run and walk bases assert at load that a shard outlives every root that can name it (`assertShardsOutliveRoots`).
  - An edit to `pass-set.ts` moves the global hash (it is in `producerSources()` through `name-store.ts`). See `research/2026-10-27-global-type-check-store-generations.md`.
- **Resolutions** (`shared/name-resolve.ts`) are keyed on what they PROBED: each existence question's stem in its directory (`dir/x` answers `x`, `x.ts`, `x.d.ts`, `x/`; in a missing directory, its first missing segment in the nearest existing ancestor) and the version of every repo file read.
  - **Never key on a whole directory listing.** A file added beside a hub's barrel (a `CLAUDE.md`) re-keyed and rewrote every importer's entry — 1,516 on one `.md`, 5,059 record files in 30 s on 2026-11-04 — and the next worktree on the other listing rewrote them back.
  - A moved target puts the file in program 1.
  - A `node_modules` lookup records nothing (the lockfile's).
- **Generated registries need nothing special** (no `isolatedDeclarations` requirement): a program holds all its sources at once and a batch never splits a cycle.
- Importers are served the RAW `.d.ts`; only the CANONICAL form is hashed.
  - `canonicalDeclarations`: properties and union members sorted, an import-binding type spelled as the import type, a type spelled by its declaring file.
  - Serving canonical text changes tsc's printing in importers' diagnostics.
- Requires `skipLibCheck`; throws without it.
- **Every exported value must have a nameable type**: `TS2883` / `TS4023` declaration diagnostics are real errors here — fix with an annotation.
- **An unservable `.d.ts` is never served.** A file whose declaration emit reported a diagnostic gets a forced `.d.ts` naming a type it does not import, so a program served it reads an error type where the source has the real one (the menu-bar `[getAppCatalog.route]` miss).
  - Its stored contract is marked (`storedContract` / `unservableContract`, `shared/name-host.ts`): every program, batch and later run that would serve it HOLDS the file as source instead (not checked; `held as source` in the program line) — as a whole program does.
  - Its names mean what the source does: `t` salted with the file's text, every use of the file a d-edge — an edit of it, or of anything it reads, re-keys its users.
  - Transient by construction: the diagnostic fails the check.
- **Soundness is validated**:
  - `dual` mode (`TscMode`) also runs a full check of a fresh whole program with TypeScript's own host (`shared/full-check.ts`) and compares diagnostics + signatures per file; a divergence rewrites the store cold.
  - By hand: `scripts/dual-check.ts` (`--mode keyed` for the check alone).
  - Daily on main: the `backstop` sub-plugin.

Design: `research/2026-10-21-global-type-check-two-programs.md`.

## No program holds more than K files

`shared/batch-run.ts` (`checkSet`). A set of ≤ K files (`TYPE_CHECK_BATCH_FILES`) is one program; a larger one is checked in **dependency-ordered batches** (`shared/batch-plan.ts`): a batch runs once every set file it imports is done, served everything else's current `.d.ts` (just-emitted or stored).

Batching changes which program a file is checked in, never what it is checked against or keyed on (`name-run.test.ts` repeats every fixture in batches of one).

- An import cycle is one batch whatever K. A global source file counts as an import of every file. Repo sources a repo `.d.ts` root imports go first.
- Imports are followed through files outside the set (their stored `.d.ts` imports what they import).
- **Missing edge = loud**: a batch loading a not-yet-done set file throws, naming it.
- **One process per batch, one at a time** (`shared/batch-processes.ts`, `shared/batch-worker.ts`; job file in, JSON out, `.d.ts` via a spool dir).
  - A fresh process is what K bounds (sequential programs in one process kept 11–15 GB).
  - K stays large and batches serial because each program re-pays the environment (~10–15 CPU-s); three at once cost +54–125 % CPU.
- **Workers and batches run heap-paced** (`packages/heap-pacing`, passed as the spawn `env`): JSC sizes its collection pacing against the machine's RAM, so on a 64 GB host a batch's 4.4 GB live heap grew ~2× before collecting (peak 8.6–10.4 GB); paced against 4 GB the same batch peaks 5.3–7 GB for +0–10 % CPU. `--smol` and `Bun.gc(true)` between phases or lint files did nothing measurable. Measure a batch with `scripts/batch-memory-bench.ts` over a run kept with `EQUIN_TYPE_CHECK_KEEP_BATCHES` (research/2026-11-08-global-type-check-bun-heap-pacing.md).
- **Lint goes with the file**: a batch lints its files inside its program before their keys exist; the worker keeps the typed parts stale under the key it computes (`LintHook.adopt`).

## The lint cache is keyed on what the rules read, and exemptions apply when it is read

A rule reads the file's text and, if **type-aware** (declares `meta.docs.requiresTypeChecking`; `isTypeAwareRule` in `lint/core`), the checker's types — a function of declarations the file can see.

Results are stored per **(file, blob version)** (`shared/lint-results.ts`, `type-check-lint-results-v3`) in parts:

| Part | Key | Re-linted when |
| --- | --- | --- |
| each syntactic group (base + one per contribution) | the group's fp | the file's text, or that group's rules/engine |
| each typed part (`(types) <group>`) | `typedResultKey(typed group fp, result key)` | the text, a declaration it can name, or that group's type-aware rules |
| a directive file's raw typed parts (`(raw) <group>`) | `typedResultKey(raw group fp, result key)` | as its typed part |
| a directive file's verdict (`LINT_GROUP_ALL`), run with **no program** | `typedResultKey(all fp, result key)` | any of the above |

- **Rules half** (`check/lint-groups.ts`): one fp per group, each folding in the **engine**:
  - the RUNTIME import closure of every module that runs ESLint — DERIVED, never listed (`lintEngineRoots`): each module the worker's `shared/` reaches that imports the `eslint` package, plus the config builder (`LINT_CONFIG_SOURCE`) — today the builder and `shared/lint-engine.ts`; root tsconfigs. A lint loop moved into a new module is engine the moment it imports ESLint (a hand-listed `WORKER_SOURCES` once kept naming `worker.ts` after the loop moved to `lint-engine.ts`, so an edit to the `--quiet` filter re-linted nothing). The closure is walked over the plugin-records module graph (`fileSetBindings`: the graph's resolved edges, each with the names its statements bind — this check parses and resolves no import itself), BY NAME through pure barrels: `import { a } from "@plugins/x/core"` reaches the barrel and the module exporting `a`, not every module the barrel re-exports (`import type` edges are erased, so not followed). A module whose mere evaluation could change a message must be reached by a name it exports. Keep the engine's imports to what can change a message — the builder and the lint engine take the manifests' file set (`lint/core/ide-lint-config.ts` lists it) and the stylesheet's `@utility` set (`readDeclaredUtilities`, read by the worker) as data, so the repo-file enumeration, the file reads and the process plumbing under them stay out (a test holds it there: the engine reaches `lint/core`, `exempt/core` and this check's `shared/` and `core/` only);
  - the npm code they LOAD: the packages the closure imports by name (held by `ENGINE_PACKAGES` in `lint-groups.test.ts`), closed over their dependencies in the code checkout's `bun.lock` (parsed once per run, `npmClosureOf` per group), with the patches applied to any of them (`infra/deps/npm/lock-closure`). Not the whole lockfile, not every `patches/` file, not `package.json`: a dependency or patch no rule loads (graphile-worker, @parcel/watcher, a server feature's new package) re-lints nothing;
  - the `@utility` set (`lintDataKey`).

  Groups:

  - Base group = the builder's own rules.
  - Each contribution (`lintContributionPaths()`) = the closure of `plugins/<p>/lint/index.ts` (`lintClosures`, walked from roots only), and the npm code it loads (as the engine's).
  - Rules are versioned in the tree they run FROM (`codeCheckoutRoot`).
  - Groups holding a type-aware rule (`typeAwareLintGroups`, stored under `typeAwareKey`) get a **typed group fp** (`typedGroupFps`) = group fp + the typed engine (`producerSources()`).

  So a syntactic rule edit stales no typed part, and editing the type check's code re-runs no syntactic result.
- **Types half**: the result key R(F) — one key decides both the tsc result and typed lint.
- **Only the worker knows R**:
  - Prepare sends each non-carried file with its stale syntactic groups and its typed parts' `known` keys.
  - The worker runs the parts whose `typedResultKey(fp, R)` is not known, in the program holding the file (a file with a stale typed part but a valid tsc result joins program 2).
  - Carried files whose R moved are decided in the worker (`shared/lint-decisions.ts`).
  - The worker always runs; only the outer read-set replay skips the check entirely.
- **Syntactic groups run with no program** (`typeSource: { none: true }`).
  - A type-aware rule that forgot to declare itself throws in `getParserServices` (and `rule-kind-safety/type-aware-rule-declared` catches lazy ones).
  - Null-id messages (parse failures) belong to the syntactic base part.
- **What needs no program runs before the type check builds one** (`LintDecisions.beforeProgram`): every stale syntactic group, and every carried directive file's verdict whose raw parts are the base's (reused at answer time only for the same raw messages, so a file whose key moved is combined again). A program built in the worker stays alive to its exit — JSC's optimized code of `createProgram`'s inner functions holds its scope, whatever we drop — and heap pacing grows the heap to ~2.6× what is live, so the ~16.5k parses of a syntactic rule edit run after even a 1-source program cost ~1.15 GB of footprint; before it, ~0.6 GB, same results and CPU. Never move such work back after the type check.
- `check/lint-verdict.ts` assembles messages under the CURRENT exemptions: an exemption edit re-lints nothing; an unused file-level exemption is reported.
- **A file with an eslint directive (~4 %, ~470 files) has one verdict, combined with no program** (`shared/lint-engine.ts`). A directive suppresses any rule's problem and is reported when it suppressed none, so the verdict depends on every rule at once. It used to be linted whole in a program on any rule change, which put every directive file into program 2 as source for a one-line syntactic rule edit: 598 sources instead of 132, worker peak 5.2 GB instead of 2.0 GB (research/2026-11-12-global-type-check-worker-memory-split.md). Now it is linted in two steps:
  - **raw typed parts**, one per typed group, in a program like a split file's typed parts (same configs, same decisions): every problem of the part's own rules **before** the directives apply — suppressed ones and warnings included (a warning a directive silences makes that directive used). Another rule's messages ("definition not found" for a rule the part does not register) and null-id ones are dropped;
  - **the verdict**, in the worker's answer phase once R is known, with no program: every syntactic rule for real and every type-aware rule replayed from the raw parts (the config builder's `{ replayed }` type source: a stand-in with the rule's id and `meta` reporting what it answered). ESLint then applies the directives to the same problem set a whole-file run has, so suppression, `eslint-enable` pairing, blanket disables and an unused directive's one message naming its unused rules are ESLint's own code, not a reimplementation.
  - So a syntactic rule edit re-runs ~470 verdicts without types (a few CPU-s), and a typed rule edit re-runs that raw part like any typed part. Parity: `shared/lint-engine.test.ts` (each coupled directive shape) and `scripts/directive-parity.ts` (every real directive file against a whole-file run; 472 files, 0 differ on 2026-11-12).
  - The base keeps the raw parts apart (`w`), never in a verdict.
- Each entry keeps a few keys per part, most recently RECORDED first, so worktrees on two versions of a hub keep each other's results. A reuse never reorders them: a run that only reuses results writes nothing (a most-recently-used order made two worktrees rewrite every entry for each other, run after run).
- The flat config comes from `buildLintConfig` (`@plugins/framework/plugins/tooling/plugins/lint/core`), the same builder as root `eslint.config.ts`.

What a change costs:

| Change | Re-linted |
| --- | --- |
| body edit | the file |
| exported-type change | the file, plus typed parts of users of the moved names |
| workspace-only lockfile / exemption / app.css token | nothing |
| one syntactic rule | that group everywhere, and every directive file's verdict (no program) |
| one type-aware rule | that typed part everywhere (one program 2 over the tree) |
| producer code | every typed part |
| walk code | nothing |
| a dependency or patch no rule loads | no syntactic part (the typed parts follow the result key: a patch touching only JS moves none, any other resolution change moves every one) |
| lint core, a tsconfig, a global `.d.ts`, a bump of a package lint loads | everything |

## The run base: a run reads only what changed

`shared/run-base.ts`. A **run base** is the complete per-file lint state a completed run ended in, content-addressed, host-wide:

- **Root** (`type-check-run-base-roots`, found by a `tree → root hash` pointer):
  - every group / typed / directive fp;
  - per **shard** (a leaf plugin's lintable files, `shardOf`): its content hash, listing hash (paths + versions), holds-messages flag, last-used day;
  - the walk base it names (`walk`).
- **Shard** (`type-check-run-base-shards`): per file version, directive flag, R, non-empty raw messages per part.

**Choosing** — candidates in this order; the first stored one **under this run's rules** wins, else the first stored one:

1. this tree;
2. the worktree's last completed run (hint);
3. `HEAD`'s tree;
4. the merge-base with `main`;
5. the latest root written under this run's rules, on any tree (the **rules pointer**, `lintInputsKey`).

- Rules first: a base under other rules re-runs every file's moved parts, and on a busy host the per-file store has long evicted most results (2026-11-05: main's current base-group key held by 172 of 15,002 files).
  - After a rebase onto a main whose rules moved, the hint is such a base. The merge-base's base, written by the pusher's check of that tree, carries every unchanged file.
  - First-stored-wins re-linted the whole tree (~500 CPU-s) on every such rebase.
- The rules pointer is last (its tree can be far, so more files differ) and is the only same-rules candidate when no nearby tree has a base under these rules: a fresh worktree off a main tree nobody checked (`base none`), a rebase onto a main whose merged tree nobody checked. So a rules move is re-linted once per HOST, by the first run under the new rules; every later run carries from it.
- A candidate naming a missing shard is passed over; with no usable candidate the run takes the full path, every reason logged. Correctness never rests on the choice: a shard carries only when its listing hash equals the root's, a file only when its version does, and rules are compared.

**Planning**:

- With a base, whatever the rules → only files in a moved-listing shard whose version moved (or new) are sent; the job names the base and which parts' rules moved (`lintBase: { hash, moved }`, `MovedLintParts`: syntactic groups, typed parts, raw parts, the verdict).
  - **A text the base holds is never in the job** (the worker throws): the worker reads its state from the base and runs only its moved parts — a moved syntactic group with no program, a moved typed part in program 2 (every carried file is then in `LintHook.jobs`) — and its typed parts where its key moved. Every other part stands under the base's own key and is not even named in the answer.
  - Before (rules moved → every file sent with the base's state as `known`), a one-line syntactic rule edit shipped 16,562 files × ~65 typed keys: a 30 MB job, ~130 MB of worker heap alive through the whole re-lint, and 11 s of per-file store reads in prepare. Now the job is the changed texts (2026-11-13: syntactic rule edit, live heap at the start of the syntactic phase 548 → 430 MB, prepare 18 → 2.7 s; typed rule edit 603 → 486 MB, 17 → 4 s).
- No base → every file.

**Recording** (`finalize`):

- Rewrites only shards holding a sent/patched file or whose listing moved (content-addressed: a shard whose state did not change is not written); writes root, pointer, hint, rules pointer.
- Shards are touched after `TOUCH_AFTER_DAYS` (3) so a shard (14 days) outlives every root (7 days).
- **Nothing is written** when the worker crashed or keyed nothing (`ProgramOutcome.keys` null/absent).
- The verdict reads only message-holding shards plus files a file-level exemption names.
- The per-file store stays the reuse layer for TEXTS (an API edit and its revert do not re-lint users twice).
- **A text the base held, re-run because the rules moved, is not rewritten in the per-file store** (`left to the base` in the lint line): its new results live in the next base, found through the rules pointer. Only a typed part whose rules did not move (it ran because R moved) is recorded. Before, every rule edit rewrote ~15k entries (2026-11-08: 18 such runs in 6.5 h, up to 58 % of a minute's file events).

## The walk base: the walk visits only what changed

`shared/walk-base.ts`, `shared/walk-incremental.ts`. The state the walk ended in, per tree (`type-check-walk-roots`, `-shards`, sharded like the run base), written by the WORKER at the end of a run that returned.

- **Root**: global hash, global files, per shard content hash, LISTING hash (every view file with version), holds-a-diagnostic flag, last-used day.
- **Shard**: per source file its version, R, contract hash, signature, diagnostics, per-name records, uses and every key read (`Meanings`), resolution probes, rank, component; plus reverse indexes held by the TARGET (`ir`, `id`, `if`).
- **Which base**: the lint root's `walk`, else (no lint base only) this checkout's last walk (`hint`). Refused (full walk, reason in the walk line) on a different global hash or ambient names, a missing shard, or other walk code.
- **The walk** (`name-run.ts`):
  - D₀ = moved/new sources, readers of removed files or changed non-sources, files whose resolution probed a moved listing or read a moved file — each with its whole component.
  - Everything else is FIXED (base meanings/key/result, no store read).
  - After phase 0, a walked key whose meaning definitely moved pulls its readers in; after phase 1 a ⊥ one too.
  - Components go in RANK order; a new edge up past a fixed reader walks the region in the way (Pearce–Kelly, `WalkGrow`).
  - Rank exhaustion or such an edge first seen in program 2 → full walk (`WalkFallback`).
  - A fixed file whose stored `.d.ts` aged out is re-checked (`ContractMissing`).
  - Self-checks after program 2 (each a MISS): a kept-valid file whose final key differs, and the FRONTIER (a fixed file reading a key whose final meaning moved).
- **The full walk stays** for: no base, a global change, a rank violation, a missed prediction's cold rerun.
- **Validation**:
  - `walks` mode runs both and compares R, `.d.ts` (by canonical text — tsc's union order follows load order), signature, diagnostics (`walk-*` divergences).
  - `dual` adds the full check.
  - `scripts/walk-replay.ts` replays main commits as two chains and compares.

## Host-wide worker admission — `server/spawnTypeCheckWorker`

**Every worker starts through `shared/launch.ts`** (`launchTypeCheckWorker` — `spawnTypeCheckWorker` and the measurement scripts alike): the job goes in on stdin, never as a file, and the worker's scratch dir (`TypeCheckWorkerJob.scratch`, required; its batch spool lives inside) is made and removed by the launcher, around the spawn. So whatever outlives the worker owns what it leaves on disk: a worker that throws or is killed leaks nothing. (Before, a `/tmp/type-check-<name>-<pid>.json` job file only the worker deleted, after a run that returned: 29 of them, 14–21 MB each, sat in `/tmp` on 2026-11-12.)

`spawnTypeCheckWorker` (`server/`) is the ONE place a worker starts (this check, build's `--skip-checks` path and the backstop). The caller hands it the tree (`tree`, required). The check's preparation already read it; a CLI caller reads the working tree with `readTypeCheckTree` (`cli/`). `server/` never reads it: that loads the TypeScript compiler and the check runner, and a server barrel is in every backend's closure (`boot:closure-no-dev-tooling`, `boot:closure-digestable`). One read also gives a small attempt and its heavy retry the same tree.

It takes the caller's `Grant`, so admission and priority cannot be skipped:

1. **A slot, small run or heavy** (host-admission's `HOST_POOLS`; `server/internal/worker-pool.ts`). Taken FIRST, so a queued worker holds no grant units. **This is the memory bound** — the grant alone never was.
   - **Small first:** a keyed run sending ≤ `TYPE_CHECK_LIGHT_SOURCES` (100) lint files takes a slot of the laned `type-check-light` pool (size 3, background may hold 2) and runs with `batch: refuse`: its worker builds no program over 100 sources (`refuseBatches`, `shared/batch-run.ts`) and answers `over-budget` instead (`TypeCheckWorkerOutput`), having recorded nothing (the name store is written after both programs).
   - **Heavy:** a refused run — or one plainly not small (`heavyFromTheStart`: more lint files, a non-keyed mode, a caller-chosen batching) — takes a slot of the laned `type-check-worker` pool (size 2; background may hold one, interactive either) and batches past K. The two slots are taken one after the other, never nested.
   - Why split: a whole-tree run (typed re-lint of every file, 600+ CPU-s) held the heavy pool's one background slot 8–12 min while 4-s runs queued behind it (977 s measured). ≤ 100 sources covered 63 % of 150 measured runs at ≤ 3.9 GB, ≤ 34 CPU-s.
   - The transcript's `type-check worker repo: admitted …` line says which pool, and for an escalation what the refused attempt cost.
2. **`TYPE_CHECK_WORKER_UNITS` of the grant** (`core/worker-weight.ts`: `ceil(7.2 GB mean peak / PER_UNIT_BYTES)` = 2) — CPU accounting.
   - The grant clamps it to its own size.
   - Batch processes run serially inside this share.
3. **Foreground, as the slot's holder, in either lane**: the pool is `holder: "foreground"` and the worker spawns via `slot.spawn` (out of darwinbg even from a darwinbg session; no spelling for demoting it).
   - The lane picks only the slot window, never the tier — background-tier workers stretched every slot wait fleet-wide.

Sizes: `research/2026-10-15-global-push-typecheck-lane-priority-and-cap.md`.

## Caching and forcing

- There is no whole-program key (the old `type-check-programs`, `type-check-type-fps`, `type-check-file-results` stores and `.cache/type-check/` manifest are retired); the per-file stores answer everything, in the worker.
- `--no-cache` / `EQUIN_CHECK_NO_CACHE=1` disarms only the OUTER read-set replay; per-file stores are content-addressed facts and are always used.
- To force a full re-check: `scripts/dual-check.ts`.
- A crashed worker records no lint results and yields no lint verdict.

## Reading the transcript

`~/.equin/worktrees/<wt>/check-<runId>.log`, greppable lines per run — the instrument every claim about this check is made on:

| Line prefix | Says |
| --- | --- |
| `type-check: lint N/M files (… whole, … partial; syntactic, typed; groups, engine) — stale: …` | what the worker actually linted and the stalest parts: "did that edit cost its group, its importers, or the repo" |
| `type-check worker repo: cpu …s (sys …), wall …, maxRSS …, slot wait …` | cost; what `TYPE_CHECK_WORKER_UNITS` is re-derived from. High `sys` = host memory pressure; `wall` = slot hold time |
| `type-check worker repo phases: type check …, lint … (cpu)` | where the worker CPU went |
| `type-check worker repo programs: 1: … 2: …; N checked of M` | what each program held |
| `type-check: walk: incremental (…) / full (<why>)`, `program 1: …`, `program 2: …`, `walk base … written` | the walk's cost and reads, each program's build/check/record ms, what was left for the next run |
| `type-check: store opens: N in …ms; G generations dropped, U entries unlinked` | what opening the host-wide stores cost the worker (O(1) each, plus what an open evicted) |
| `type-check worker repo: lane …, priority foreground (slot holder)` | lane and tier (`unknown (<reason>)` without darwinbg) |
| `type-check: input: tree … (N files)` | the worker's input load |
| `type-check: prepared off-thread in …` | prepare's phases with CPU, the base carried from (or `base none (<why>)` / `rules moved (…)`), files sent, what finalize wrote; `(finalize skipped: coverage gate failed)` |
| `type-check: lint base …: every file carried unless its key moved` / `rules moved (…): every file carried runs its moved parts` | the lint base the worker compares keys with, and what moved since it |

**Use `cpu`, not wall clock** — wall measures the neighbours (the same build: 105 s vs 266 s at similar load). Per-check cost claims need `./equin check --jobs 1`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: spawnTypeCheckWorker: the one way to start a repo-program type-check worker — admitted first as a small run through the laned type-check-light pool (its worker refuses any program over TYPE_CHECK_LIGHT_SOURCES), else — or once refused — through the laned type-check-worker pool (background may hold one slot, the interactive lane the other), then the holder's grant; the worker runs in the foreground as the slot's holder.
- Server:
  - Uses: `infra/host/host-admission.defineHostPool`
  - Exports (types):
    - `TypeCheckWorkerRun`
    - `WorkerAdmission`
  - Exports (values): `spawnTypeCheckWorker`
- Core:
  - Uses: `infra/host/host-admission.PER_UNIT_BYTES`
  - Exports (types):
    - `LintBaseRef`
    - `LintFileJob`
    - `LintFileResult`
    - `LintTarget`
    - `MovedLintParts`
    - `ProgramSize`
    - `RawLintMessage`
    - `TscDivergence`
    - `TscMode`
    - `TscPredictionMiss`
    - `TypeCheckBatching`
    - `TypeCheckDivergencePayload`
    - `TypeCheckStats`
    - `TypeCheckTree`
    - `TypeCheckWorkerJob`
    - `TypeCheckWorkerOutput`
    - `TypeCheckWorkerResult`
    - `TypedDecision`
    - `TypedPartFp`
    - `TypedPartOutcome`
    - `TypedParts`
  - Exports (values):
    - `LINT_GROUP_ALL`
    - `LINT_GROUP_BASE`
    - `NO_TYPED_PARTS`
    - `TYPE_CHECK_BATCH_FILES`
    - `TYPE_CHECK_DIVERGENCE_KIND`
    - `TYPE_CHECK_LIGHT_SOURCES`
    - `TYPE_CHECK_WORKER_PEAK_BYTES`
    - `TYPE_CHECK_WORKER_UNITS`
    - `TypeCheckDivergencePayloadSchema`
- Cross-plugin:
  - Imported by:
    - `framework/cli/build`
    - `framework/tooling/checks/type-check/backstop`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `shared/batch-processes.ts`, `shared/batch-worker.ts`, `shared/full-check.ts`, `shared/keys.ts`, `shared/launch.ts`, `shared/name-check.ts`, `shared/name-host.ts`, `shared/name-records.ts`, `shared/name-resolve.ts`, `shared/name-run.ts`, `shared/name-store.ts`, `shared/name-walk.ts`, `shared/pass-set.ts`, `shared/repo-view.ts`, `shared/tsc-engine.ts`, `shared/worker.ts` (debt)
    - `user-path/no-unproven-claim` — `shared/batch-worker.ts` (sanctioned)
    - `blocking-fs/sync-named` — `shared/batch-processes.ts`, `shared/batch-worker.ts`, `shared/name-store.ts`, `shared/pass-set.ts`, `shared/repo-view.ts`, `shared/tsc-engine.ts`, `shared/worker.ts` (sanctioned)
- Cli:
  - Exports (values): `readTypeCheckTree`
- Sub-plugins:
  - **`backstop`** — The two-program type check's backstop: a daily main-only job runs the type-check worker in dual mode (the two-program check beside a full check of a fresh whole program, compared file by file) and…

<!-- AUTOGENERATED:END -->
