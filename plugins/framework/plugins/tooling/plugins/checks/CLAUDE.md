# checks

A check that detects a code pattern by scanning source text MUST NOT match
inside comments or string literals. Use **`grepCode`** (exported from
`checks/core`) instead of a bare `git grep`: it narrows candidate files with
`git grep -l`, then masks each via `maskSource` and re-scans, so only real-code
matches survive. Pick `maskStrings: false` when the banned token legitimately
lives in a string (e.g. `text/event-stream`, `/api/…` URLs, hardcoded paths);
`true` for code constructs (`new WebSocket(`, casts). See
[`parse-utils`](../../../../../plugin-meta/plugins/parse-utils/CLAUDE.md).

A check that parses each candidate file (AST) rather than regex-scanning its
lines MUST get its candidate sources from **`listCandidateSources`** (exported
from `checks/core`), never a bare `git grep`. `git grep` searches only
**tracked** files, so a newly-created, not-yet-committed source is invisible to
it — the exact file an agent produces when adding a pane/route/endpoint, which
would then slip past the check and only fail at runtime. `listCandidateSources`
is scan-tree-aware and untracked-aware (it shares the discovery plumbing behind
`grepCode`/`grepImports`), so it sees those uncommitted files.

A check that enumerates the repo's SOURCE FILES must get them from
**`ctx.repo()`** (below) — outside a check, from **`loadRepoFiles`** (exported
from `tooling/core`) — never a `readdirSync` walk that prunes directories by
name. Such a list is a guess at what `.gitignore` already states, and it is
always missing one: type-check's two copies both omitted `.cache/`, so a `.ts`
left in that gitignored directory counted as source and failed its coverage
gate. Both ask git for tracked + untracked-not-ignored — the same universe
`computeTreeHash` builds. The `no-adhoc-repo-walk` lint rule enforces it.

## A check whose work is per file is a fold check (`defineFoldCheck`)

A check that judges each file on its own bytes (an import grammar, a
per-file pattern) and then decides across files (a cycle, "only tests import
it") is written as **`defineFoldCheck`** (`core/fold-check.ts`), not as a
`run()` that reads the whole tree:

- `context(ctx)` — small plain data every file's part also reads (the plugin
  set), part of every record's key;
- `files(repo, context)` — which files, chosen from paths alone;
- `fold` — a plugin-records `FileFold` (`scan(src, rel, context)` and an
  associative `combine`) in a `*.scan.ts` module of its own;
- `facts(ctx)` — what the verdict alone reads beyond the paths (a shared,
  memoized input), keyed by nothing;
- `verdict(folded, { context, facts }, ctx)` — the cross-file rules, handed
  the file set WITHOUT `read`.

The fold's records are kept along the directory tree, so a pass after an
edit reads and judges only the edited files (an unchanged directory is one
record) and writes only its own path — never the whole answer again (a record
names its value by content; a large directory's value is the list of its
members', `plugin-records` § Folds) — and a cold store reads each file once. A one-line edit re-ran
plugin-boundaries' whole-tree walk (52.9k reads, ~9 s of check thread); as a
fold it reads the edited file (research/2026-11-12-global-plugin-records-store-layout.md).
An input-keyed fold check needs no read-set code: keying a file's record takes
its blob id through the recording file set, which records the file.

Migrating a check: move its per-file body into the scan (returning what the
cross-file part needs of the file, not the bytes), make the cross-file part
the verdict. A rule that needs another file's bytes is cross-file — fold what
it reads of each file (plugin-boundaries' `summarizeExports`). Users:
`plugin-boundaries`, `relocate:moved-plugins-unnamed`, `parse-utils:mask-sync`,
`theme-bridge-reads`, `negated-complex-selector`,
`script-state:no-stylesheet-reads` (two folds: the declared attributes, a
fold's result, are the context of the reads fold).
`sql-writes:fit` folds its per-file sites with `foldRepoFiles` directly: a
few of its holes name another file, followed after the fold through the
source analysis (what they name, never the tree).

## A check's own O(tree) work is declared, or it fails (`wholeTreeRead`)

Whether a check costs O(changes) or O(tree) per pass is a property of the
check, so it is in its declaration. The runner meters each body's OWN file
calls (`core/whole-tree-read.ts`: a `packages/timed-fs` tally around `run()`)
and judges them against `Check.wholeTreeRead`:

- over `WHOLE_TREE_FILE_CALLS` (1,000 reads, stats, listings and globs)
  undeclared → the check FAILS, naming its count and the prefixes the calls
  went to;
- declared (`{ kind: "debt", task, reason }` or `{ kind: "sanctioned",
  reason }`) and at most half the bound on a passing run → it fails too: the
  declaration outlived the read it declared. Half, not the bound itself, so
  a body near the line (one file more or fewer on some branch) cannot flip
  between the two failures.

So an O(tree) body has no silent spelling. Make it O(changes) — a fold
(`defineFoldCheck` / `foldRepoFiles`, above), or input-keyed over a narrow
read-set — or declare it, where `./equin check --list` prints it.

**Shared work is nobody's own.** Work one check starts and every later check
reuses — a per-pass memo (the plugin tree, the codegen pass's trees and
registry context, the source analysis) or a plugin record (a fold's scan, the
module graph) — runs under `sharedWork(name, …)` (`packages/shared-work`) and is counted under
that name, on the run's `done` record (`sharedFs`), never into the check that
happened to start it. Without that, a check's count would depend on which
check reached the memo first and what the record store already held, and a
verdict on it would not be a function of the tree. **A new per-run memo that
reads files must run its producer under `sharedWork`**, or the first
check to ask is charged for it.

## Reading code: `sourceAnalysis`, not regexes

A check that asks a question about code — where a function is called, what an
import names, what a `const` holds, which file a specifier is — answers it with
**`sourceAnalysis(ctx)`** (exported from `checks/core`; the API is the
[`source-analysis`](plugins/source-analysis/CLAUDE.md) sub-plugin), never with
regexes over masked text (`findImports` / `matchBracket` / an `importAliases`
map / a `const x =` pattern). Text scanners guess, and what they cannot guess
they skip: aliases, re-exports, `export *` barrels, namespace imports,
ternaries, spreads and wrappers silently escape them, and the check passes over
the case it exists for.

- **`usesOf({ key: { rel, name } }, (g) => listCandidateSources({ grepArg: g }))`**
  — every call / member call / re-export of a declaration, through every
  barrel and alias.
- **`bindingOf(file, id)` → `initializerOf(decl)`** — follow a name to its
  declaration (scope-aware, across files) and read its value.
- **`literalString(ts, file, expr)`** — a literal argument.
- **`valueReferences(ts, node)` → `bindingOf`** — which declarations a piece
  of code names (a loader's reach, a registration's owner), by resolution,
  never by spelling.
- **`boundConst(ts, file, call)`** — the `const` a declaring call initializes
  (through casts and ternaries).

It is **fail-closed**: every answer carries what it could NOT read
(`Readout`'s `unreadable` arm, `Collected.unreadable`, each with file:line and
how to rewrite it). Report each as a violation (`formatUnreadable`) — dropping
them reopens the hole. Codegen calls `failClosed`, which throws naming all of
them (the icon manifest scan, `codegen/core/icon-manifest.scan.ts`, is the
reference user).

It reuses the repo project (the root `tsconfig.json`'s module resolution) and
the run-shared parse (`parsedTsSource`, so the thread yields); it builds no
type checker. Every check of a pass shares one analysis; an input-keyed check
gets its own, so its reads land in its read-set.

A check whose whole question is cross-file (where a call's reachable code
reads the DB) cannot fold per file; it is **input-keyed** instead, so an edit
to a file it never read replays its read-set and runs nothing:
`no-db-backed-notify` reads ~1.5k of ~14k sources, and its read-set is what
it read — `usesOf` selects only files that spell a target's name or
namespace-import a repo module, and resolves only the imports that can name
a target.

## Grep selections are folded along git's trees (`core/grep-index.ts`)

`grepCode` / `grepImports` / `listCandidateSources` select their candidates
through the run's **grep index**, not one whole-tree `git grep` each. A
selection over a git tree is a pure function of (git version, `-E`/`-F`,
pattern, pathspecs, the tree's id), and git's trees are already a Merkle tree
over the directories, so the answers are kept host-wide in one SQLite file
(`checks/cli`'s `openGrepIndexStore`, opened by the `check` command and handed
to `runChecks` as `grepIndex`) at three grains:

- **a directory record** per (query, pathspecs, path, tree id): its own
  selected file names, and each sub-directory with a selected file below BY
  ITS TREE ID — the key of the child's record, never a copy of its answer. A
  selection walks the records down from the run's root tree, entering only
  directories with a match below; a directory with no record is read as a tree
  object (`readTreeObjects`, one `cat-file --batch` per level) and folded.
- **a membership record** per (pathspecs, path, the directory's file names):
  which of its files the pathspecs name — a content edit never re-asks it.
- **a per-blob answer** per (query, blob), shared by every path, directory and
  worktree holding those bytes.

So a selection costs what changed: after a one-line edit, ~6 tree objects read
for the whole pass, one record per directory on the edited path per query
(O(depth) new bytes — 83.5 KB for the pass's 91 selections), and the
directories with a match below read as records (35.7k lookups per pass, against
1.40M per-blob lookups when every selection asked about every blob of its
domain). A cold store reads each tree once and records every directory per
query (~9k rows, ~0.8 MB each).

git stays the authority on both halves, so a selection equals what `git grep -l
<pattern> <tree> -- <pathspecs>` prints:

- **which files**: `filterPathspec` (`core/tree-hash.ts`) — the files asked
  about staged into a scratch index (`update-index --index-info`), `ls-files
  -s` over it. Never `pathspecToRegex`, which is only a superset.
- **whether one matches**: `git grep` itself, over the unknown blobs only (by
  `:(literal)` path, or the whole query when there are many — whose output must
  then lie inside the domain `listTreePathspec` lists, or the run throws).

`gitGrepList` reads `-z` output: a quoted path (non-ASCII, `"`, `\`) would
otherwise name no file and be recorded as not matching, host-wide.

## `computeTreeHash` costs O(changed files)

It hashes through a scratch index seeded from the checkout's real one: `git
status` on it names what `add -A` would change, and the add is scoped to those
paths (none changed: no add at all). Three things keep that cheap, and all are
load-bearing:

- **The seed is found by an absolute path** (`--path-format=absolute`).
  `--git-path index` alone is relative in main but absolute in a linked
  worktree, and joined onto the root it named no file: from the cache's start
  (2026-06-07) to 2026-11-04 every agent worktree hashed from an EMPTY index — the whole tree's content on every
  check run (180 s timeouts under load, so `null` and an uncached run).
- **What status learns is published back** to the real index
  (`publishRefreshedIndex`): its refreshed stats AND git's untracked cache.
  No git read of ours ever saves either (`GIT_OPTIONAL_LOCKS=0`, spawn's
  child-env), so racily clean entries left by a checkout, a spare claim's
  switch or a rebase (up to 11,200 of 20,664 measured) were otherwise re-read
  by every run until the next commit, and every `status` in the checkout read
  all ~8,700 directories (0.8 s; 0.2 s once the cache is in the index). The
  scratch `status` is the one git read allowed to write (`privateIndexWrites`
  — its index is this process's own file). Only when it learned something,
  compare-and-swap under git's own `index.lock`, held for one stat + one
  rename. Scratch indexes keep the source index's mtime (`copyIndex`) — a
  fresh one would trust racily clean stats and hash a stale tree.
- **`add -A` never walks the whole tree.** Its own walk ignores the untracked
  cache, so a plain `add -A` read every directory on every run; scoped to the
  paths status named (literal pathspecs) it reads only those. A scoped add
  that fails (a path gone in between) falls back to the plain one.

## A replayed grep goes through the grep index

An input-keyed check's read-set replays each recorded `git grep -l` selection
whose pathspec fingerprint moved (`validate`, `core/read-set.ts`) — for a `*.ts`
selection, after ANY `.ts` edit, and on every later run until the body runs
again (a hit does not re-record). The replay asks the run's grep index
(`runner.ts` `validateStored`), the same records the checks select through,
so only unknown blobs are grepped. Through a raw whole-tree
`gitGrepList` it re-grepped every blob for every recorded query: ~22 whole-tree
greps, ~13 CPU-s, in a build whose checks were all cached (2026-11-06).

## A `scope: "tree"` verdict must not depend on the process that produced it

A passing check writes an entry to the shared cache under
`~/.equin/check-cache/`, and a later run in a different process (usually
`./equin push`) returns ✓ off that entry without running anything. So a
recorded PASS must be **transferable**: the process that reads it has to be able
to reproduce it.

That is why `scope: "tree"` means more than "a function of the tree hash". The
verdict must also be independent of what else already ran in the same process.
Depend on process history and the reader cannot reproduce the verdict — and has
no way to notice, so it just returns the green.

How `plugins-doc-in-sync` got this wrong: `reorder`'s `contributions` array
starts empty and is filled by a `subscribeSlotsDeclared` callback. Inside a build
the slot-declaration pass runs during codegen, so the check read the full set; in
a standalone check pass it read none. Four builds each recorded a pass, four
pushes trusted it, and a `docs/plugins-details.md` only a build could reproduce
shipped across four commits.

Commit `18126884a` fixed it. Copy both halves — neither is optional:

- **Move the precondition into the producer.** `buildEnrichedTree`
  ([`codegen/core/enriched-tree.ts`](../codegen/core/enriched-tree.ts)) runs the
  declaration pass itself, memoized per pass. It used to live in one caller's
  pipeline ordering, where it held for that pipeline and nowhere else.
- **Leave the early read no spelling.** The contributions facet is handed the
  imported barrels and the naming the declaration pass over them settled as ONE
  value (`ExtractContext.imported`), so a reader cannot hold the barrels without
  the pass that names their slots. This began as a runtime count the facet
  refused to extract while zero; pairing the two turned the assert into a type.
  Without either, reading too early returns a smaller answer that looks correct
  — which is how this shipped.

`cacheSignature()` follows the same reasoning: a signature keys a verdict, it
cannot make one reproducible. If the verdict depends on something outside the
checkout and outside the signature, the right value is `null`, and the repair is
to remove the dependency rather than key around it.

## `runChecks()` has exactly one in-process caller

[`cli/plugins/check/cli/run.ts`](../../../cli/plugins/check/cli/run.ts), the `check`
command's own action. `build` and `push` both reach it by spawning that command.

A build process has already imported every plugin barrel, run the
slot-declaration pass, and warmed the codegen memos, so entries it recorded
in-process would carry all of that as invisible context — and the clean
subprocess push spawns would then hit those entries and skip the run it paid
for. Spawning makes build's ✓ and push's ✓ the same claim by construction. Held
by the `check-runner-safety` lint rule (bans the `runChecks` value import
elsewhere) plus a throw in `runChecks` when `isBuildProcess()`.

## A check that throws fails itself, never the run

If a check's `run()` throws, that check FAILs: it is named, its full stack is in
the transcript, and the result is fatal and never cached. Every other check in
the run still reports its own verdict. The conversion is
[`core/thrown-outcome.ts`](core/thrown-outcome.ts). Still, return `{ ok: false }`
(or `inconclusive`) for any failure you can name — a throw is reported as a bug
in the check. The runner's outer catch, which aborts the whole run, is for
runner-internal failures only — don't route check failures back to it.

## `inputKeyed` carries an extra rule

Live, not a dormant scaffold — among others: `type-check`,
`plugin-boundaries`, `parse-utils:mask-sync`, `no-db-backed-notify`,
`active-data`, `no-raw-event-source`, `no-raw-sse`, `no-raw-websocket`,
`no-hardcoded-colors`, `no-hand-built-link-to`, `no-use-resource-cast`
(`rg 'inputKeyed: true'` for the current set).

The read-set slot is keyed on `(checkId, cacheSignature(), checkout)` with **no
tree hash at all** (`readSetFile` in [`core/cache.ts`](core/cache.ts)), so a PASS recorded
there survives forward into later trees for as long as the replay still
validates. A wrong answer on the tree-hash slot is confined to the one tree it
was recorded against; here nothing bounds it. **A check that is not a pure
function of the checkout must never be moved onto this flag** — fix the impurity
at its source first.

**One slot per checkout, tried own-then-main.** A run replays the read-set its
own checkout last recorded, then the main checkout's, and records into its own
only. With one slot per `(checkId, sig)` every concurrent worktree overwrote
the others' facts, so a replay almost always compared against someone else's
edits: 5 hits in 57 type-check runs (2026-11-05). The checkout picks which
read-set is tried; `validate` alone decides the hit.

**A read-set is keyed on the check's code, derived — never on a path list.**
Replay first compares the read-set's `codeKey` (`core/check-code-key.ts`): the
plugin-records module graph's Merkle key of the check's own `check/index.ts`
and of `core/runner.ts` (each module's blob plus the keys of every module it
imports, static or literal `import()`), plus the npm code they load. So an edit
to a check's logic, or to any helper it imports from anywhere in the repo, is a
MISS, and an edit no check loads replays. It replaced `CHECK_SOURCE_PREFIXES`,
a hand-listed set of directories (tooling/, parse-utils/, …) that missed every
check living elsewhere (network/live, product-name, layout-harness, …): their
logic edits replayed the PASS the old logic recorded. Two consequences:

- **Neither the runner nor a check reaches the check registry.** The
  registry's `import()` reaches every check, so a closure holding it re-keys on
  any check's edit. It lives in its own sub-plugin
  ([`registry`](plugins/registry/CLAUDE.md)), not in `checks/core`; the `check`
  command loads it and hands it to `runChecks`, and the runner throws when a
  check's closure reaches another check's module.
- **What a key cannot see is a read, and belongs in the read-set**: an
  `import()` whose path is not a literal, a file read at run time. Go through
  `ctx.repo()`.

Three checks document why they stay off it; read them before adopting:
[`format-clean`](plugins/format-clean/check/index.ts) and
[`lint-directives-stable`](plugins/lint-directives-stable/check/index.ts) start
from a `git merge-base` read the recording view cannot observe, and
[`test-layout:runner-split`](../test-layout/check/index.ts) reads
`bunfig.toml` / `vitest.config.ts` directly.

## The check fan-out is gated, and the gate is an instrument

`runChecks()` gates its per-check fan-out with a `createSemaphore` (the repo's
canonical in-process bound). **The default width is unbounded** — one slot per
selected check, i.e. the behaviour that predates the gate — and `--jobs <n>` /
`EQUIN_CHECK_JOBS` narrow it. The env var is the one `build` and `push`
reach: neither calls `runChecks` in-process, they spawn the `check` command, and
the child inherits `...process.env`.

The width exists to make the timings mean something, not to tune throughput.
Unbounded, ~100 checks start within ~3s of each other, so every recorded
`durationMs` is mostly the wave's own length — twelve unrelated checks each
"cost" ~260s. So **`wallStart` is captured INSIDE the gate**, after it grants,
with the slot-wait recorded separately as `queuedMs` on the `end` record. Move
that `performance.now()` back outside and the queue reappears inside every
duration: intact-looking, measuring nothing.

`--jobs 1` is the point of it — a serial run is the only trustworthy per-check
cost table, and the way to corner a wedged check. **Only width 1**: read at width
4 the suite ranks `table-defs-in-schema-glob` second at 131s; serially it is
5.8s. A merely narrower run still reorders the table.

Why the default stays unbounded: wall clock improves monotonically with width
(~337s at one-per-core vs ~196s unbounded), while a run's self-reported durations
degrade 23×. Narrowing by default would tax every run for a fleet benefit nobody
has measured. Measure that first — see
[`research/2026-09-02-global-bounded-check-fan-out.md`](../../../../../../research/2026-09-02-global-bounded-check-fan-out.md).

**The gate is NOT `options.grant`. Do not merge them.** One `Grant` is shared by
the whole run and wraps one `createSemaphore(units)` with no reentrancy, while
checks call it from *inside* their own bodies (`type-check` per tsc worker;
`layout-geometry` as `ctx.grant.run(() => browserPool.run(fn))`). Wrapping each
check in `grant.run()` therefore deadlocks at `units === 1` — which `acquireShare`
may legitimately return under load: the outer wrap holds the only slot while the
check's body waits for a slot only its own completion can free. Same bug class
`host-read-pool` hit (`research/perfs/2026-07-10-read-admit-wedge-stuck-git-loaders.md`);
here the answer is not to nest at all. It would also over-serialise: `grant.units`
sizes CPU-bound workers (~6 background), but most checks are spawn/IO-bound and
can correctly run wider. The grant bounds a check's heavy *children*; the gate
bounds how many *checks* run.

`checkStarted` is inside the gate too, so "started" keeps meaning "running" and a
hang is still `started − ended`. Queued checks are derived
(`selected − ever-started`), never recorded — a second source for that fact could
disagree with the start/end records. The bound's one real cost: a wedged check
eventually stalls the run behind it, where before its peers drained.

## A cache miss runs once across concurrent runs

On a cache MISS with a key (cache on, a tree hash, a non-null signature),
`runOne` runs the body through `runCheckFlight`
([`core/check-flight.ts`](core/check-flight.ts)): a `packages/single-flight`
flight keyed on `(check.id, sig, treeHash)` in `<check cache>/flights/`, with
the run's id (`ProgressRun.runId`, i.e. the op id) as the leader id. So
`./equin check` and `./equin check type-check` launched together
pay for one type-check body.

- **Leader pass:** the cache record is written as today, then `{kind:"pass"}`
  is published; a joiner re-enters its own cache lookup and is served the hit
  (a miss there runs the body — a pass is never fabricated). **Leader failure:**
  the result and observations are published and returned as the joiner's own.
  **Inconclusive or a thrown check:** nothing is published; the joiner runs it.
- **Console/transcript:** `• type-check ... ok (shared with run <id>)` /
  `FAIL (shared with run <id>)` (`CheckOutcome.sharedFrom`, rendered by
  `provenance()` for both). **Progress log:** a `joined` / `join-ended` record
  pair, `sharedFrom` on `end`; `check --status` prints
  `type-check — joined run <id>, running Ns`. A joined check leaves the
  thread watch's running set for the wait — it is not on the thread.
- **The gate slot is released for the wait.** A check takes its `--jobs` slot
  as a lease (`gateSlot`), gives it back the moment it joins, and re-takes it
  only to do work (a post-adoption lookup, or leading after a leader it could
  not adopt). This is what keeps it deadlock-free at any width: no check ever
  holds a slot while waiting on a flight, so every slot holder finishes without
  waiting on one, and a joiner that wakes holding a flight lock and queues for
  its slot is waiting on work that ends. Do not take the slot back before the
  wait ends, and do not wait on a flight while holding it — either reopens a
  cycle between two bounded runs.
- **Grants:** a leader runs on the host grant its run already holds, so a
  leader is never queued for admission — the nested-op cycle `withDirectOp`
  guards with `tryLead` does not exist here, and nested (build-spawned) and
  top-level checks join each other freely.
- **Reclaim:** the hourly `prune()` sweep also deletes flight files idle for a
  day, only while it holds the key's lock (`flockTry`), and orphaned publish
  temps. See `sweepIdleFlights` in `core/cache.ts` for the one benign race.

## The check thread is shared, and a run reports when it stalls

Every check in a pass runs on ONE JS thread. When code holds that thread, no
other check runs and no timer fires — so every check's `durationMs` in that
window grows by the stall, and a check's own wall-clock timeout can fire against
a service that is perfectly healthy. That is how fork-schema-drift's 5 s
Postgres connect failed on 2026-09-10. Measured with this watch, a full uncached
pass stalls its thread 10–14 times, and the longest stall is 24–42 s. The design
and the measured culprits are on the wiki track page "Check pass speed"
(read it with the `read_page` MCP tool: `block-c0e3f7dd-4943-432d-a631-d864fe623fe7`).

So each run carries a **thread watch**
([`core/thread-watch.ts`](core/thread-watch.ts)), opened and closed with the
progress run. A 50 ms timer measures how late it fires, and each tick drains the
JSC stack sampler (`infra/stack-sampler`, claimed as `check-runner`). A tick
late by ≥ 1 s is a **stall**. Every sample is attributed, stall or not, to give
a whole-run table of who used the thread. The sampler's rate is measured inside
stall windows, where the thread is busy by definition, and it turns sample
counts into milliseconds. With no stall, the tables give shares only.

Where it lands:

- **`check-progress.jsonl`**: a `stall` record per stall (top 3 owners with
  5-frame example stacks, plus the WHOLE `running` list), a `thread` record just
  before `done` (written even when nothing stalled), and `stalledMs` on each
  `end` (how much of that check's `durationMs` fell inside stalls). Read back,
  a missing `stalledMs` is `null`, never 0: older runs stalled too, they just
  weren't measured. Both `stall` and `thread` also carry a `kinds` tally
  (sample counts by innermost-frame kind) and a `cpu` reading
  (`process.cpuUsage()` delta); a stall's own record additionally keeps
  `leaves` (its busiest raw innermost frame names). Read back the same way as
  `stalledMs`: missing is `null`, never zeros.
- **The transcript** (`check-<runId>.log`): the full detail above the trailer —
  the whole-run owner table and each stall with its top 5 owners, 8-frame
  stacks, and the checks in flight.
- **The console**: one `⚠ check thread stalled …` line after the per-check
  lines, on a passing run too. It never changes the verdict.
- **`./equin check --status`**: a `thread stalled N× so far` line under
  each open run.
- **Debug → Reports and the bell**, for a stall or run that misses the track's
  targets ([`core/stall-report.ts`](core/stall-report.ts)), judged on **held**
  time, never on lateness (see "Held vs starved" below). One stall whose code
  held the thread ≥ 2 s files a `check-thread-stall` report the moment it
  closes, so a killed run still reports; one row per top owner, each new stall
  by it bumping the count. A run whose stalls add up to ≥ 20 s held files one
  more at `finish()`, on a single `total` row. Without a thread CPU clock (an
  unsupported platform) there is no split, and lateness is judged instead. The thresholds are the targets (longest stall under
  2 s, total under 20 s), not today's numbers, so both fire on most full
  passes until the remaining stalls are fixed. Filing is async and can never
  change the verdict; the runner awaits it before returning so an exiting
  process does not lose it. The kind lives in
  `plugins/reports/plugins/check-thread-stall`.

  A CLI has no server, so the reports go through the **report outbox**
  (`plugins/reports/plugins/outbox`), which main's backend drains. Each entry
  carries this checkout's `git merge-base HEAD main` (read once per run, on the
  first report) and the repo files on the reported stacks (dependency and
  native frames left out). **Main drops the report when it has changed any of
  those files since that merge-base** — the stall may already be fixed there —
  and files it otherwise, including a stall this branch itself introduced.

**Held vs starved** (`StallHeld` in `core/thread-watch.ts`). A tick fires late
for two reasons a timer cannot tell apart: code did not yield (**held**), or the
thread was runnable and the OS did not schedule it (**starved**). A check pass
inside a build runs at macOS background priority, so on a busy host most of its
lateness is starvation: the 2026-10-29 audit found process CPU ≈ 0.2 × `lateMs`
across 478 stalls, the watcher itself a "top owner" 57 times, and reports
filing at the rate builds ran rather than at the rate code changed. So each
stall reads the main thread's own CPU clock (`packages/thread-cpu-clock`) and
splits `lateMs` into `heldMs = threadCpuMs + blockedMs` (`blockedMs`: `lateMs`
× the `blocking-io` sample share — a sync syscall holds the thread without CPU)
and `starvedMs`, the rest. Every sink carries both; only held time files a
report. The watch's own `selfMs` is on the same clock (`selfClock`), so
preemption mid-tick no longer reads as watch cost. Per-check `stalledMs` and
`overlapMs` still measure LATENESS: that is what a timer inside a check sees.

**Reading an owner** ([`core/thread-attribution.ts`](core/thread-attribution.ts)):

- `check <plugin>`: a frame from that check's own `check/` directory was on the
  stack. That is sync work the check itself runs.
- `shared <fn @ path>`: the outermost source frame, i.e. an async function
  resumed after an `await`. **Its caller is not on the stack.** The stall
  record's `running` list is the link back to the checks that could have called
  it (e.g. the four that call the shared plugin-tree builder).
- `import`: module evaluation from `await import()`. The evaluated module's
  plugin is kept as detail ("of which: …"), so a long barrel-import chain reads
  as one owner rather than 800 slivers.
- `native during <activity>`: no source frame, but the sample was taken inside a
  `withThreadActivity` interval (`infra/stack-sampler`) — today only
  `barrel import`, with the barrel paths as detail. "During", not "caused by":
  the interval also covers other work that ran while the import awaited.
- `native <leaf>`: no source frame at all, and no activity running.

**Reading an owner's example stack** (`OwnerShare.example`): one real sample
from the owner's **busiest path** (innermost frame + innermost repo frame, lines
ignored), never its first sample — a first sample can be a 5 ms regex while the
seconds are a directory walk deeper in the same check. `exampleSamples` (the
transcript's `busiest path: N of M`) says how representative it is. When the
innermost repo frame lies past the frame budget, the example is the leaf, a
`… N frames` marker, then the stack from that repo frame out — so it names the
repo code that called into the dependency, and the outbox's staleness paths
have a file to diff.

**Reading a stall's kind split**: an owner says WHOSE code held the thread;
`classifyLeaf` (`core/thread-attribution.ts`) says WHAT it was doing, sorting
each sample's innermost frame into `blocking-io` (a native `*Sync` frame — the
class this project exists to remove), `process` (Bun's spawn machinery),
`module-load` (the loader's own frames), `cpu` (ordinary JS), or `native`
(unclassified, never dropped). Its `blocking-io` share is what
`StallHeld.blockedMs` is estimated from; `held` itself says how much of the
stall was code's at all. `cpu` (the `process.cpuUsage()` delta, process-WIDE so
a busy Worker inflates it) is kept as context. The transcript prints one line
of each per stall.

A sync function whose last act is `return heavy()` loses its frame to JSC's
proper tail calls, and its samples go to the next frame out. An `async run()`
keeps its frame.

Two consequences for check authors:

- **A check's own wall-clock timeout must be longer than the longest stall a
  pass reports.** Otherwise it measures the other checks, not its service. Read
  the `thread` record of a recent uncached pass before picking a number.
- **The watch sees only the main thread.** Work a check moves onto a Worker
  (type-check's preparation) cannot show up here. That keeps it off the shared
  thread, but it is not free.

The watch names who held the thread. It does not give a check's true cost.
`--jobs 1` is still the tool for isolating one check (see the fan-out section
above).

## A check gets its files from `ctx.repo()`, and never blocks the thread

The watch above names the culprit of nearly every stall: a **blocking** call —
`readdirSync`, `existsSync`, `statSync`, `readFileSync`, `Bun.Glob.scanSync`,
`Bun.spawnSync` — made once per file across the tree. Alone each is fast. In a
pass it is not: an agent's check process runs at macOS background priority
(throttled disk, slow cores), so each call takes ~100× longer, and holds the
one thread every check shares for all of it.

So check code:

- **Gets the file set from `ctx.repo()`.** Loaded once per run, shared by every
  check: the universe the cache key covers (tracked + untracked-not-ignored),
  read off the key's own tree snapshot when the run has one. `all()`,
  `has(path)` and `under(dir)` answer in memory, and `blobOf(path)` gives the
  content id the snapshot hashed (it is a `RepoSnapshot`). Never list, walk or
  glob the repo yourself, never run `git ls-files` per check, and hand the set
  to any shared helper that needs one (`buildStructureTreeOnce`, the
  web-artifacts plan, `readWorkspace`) — `repo-walk-safety/no-adhoc-repo-listing`
  rejects a listing outside a pass root. Whether `add -A` would record a
  gitlink is on `ctx.snapshot()` too (`gitlinks()`).
- **Reads contents asynchronously**: `repo.read(path)`, or `node:fs/promises`.
  `read` is bounded by one run-wide gate, so `Promise.all` over thousands of
  paths is fine through it — never through raw `readFile`.
- **Masks and parses through `checks/core`**: `await maskedSource(source)` and
  `await parsedTsSource(ts, source)`, never `maskSource` / `ts.createSourceFile`
  directly. Each yields the check thread's one shared time slice
  (`sliceCheckThread`, ~10 ms) before working and shares its result, so a loop
  over thousands of candidates yields by construction, and a file `grepCode`
  masked for one check — or a tree another check still holds — is free for the
  next. A mask is kept for the run; a parse tree only while a holder keeps it
  (weak memo — `mask-sync` parses the whole repo, ~1.4 GB of trees). A check
  that needs a tree across calls holds it itself.
- **Yields in its own CPU loops** over thousands of items: `await
  sliceCheckThread()` between items. Not `await Promise.resolve()` — a
  microtask never lets a timer run.
- **Makes `cacheSignature()` async** when it needs git, rather than
  `spawnSync`-ing it.

The `check-thread-safety/no-blocking-check-work` lint rule holds the first
three in a `check/` folder's code: no blocking fs / process call made per item
(in a loop or a callback), no direct `maskSource` / `createSourceFile`
(`research/2026-10-30-framework-checks-never-hold-the-check-thread.md`). It
cannot see into a core helper a check calls — keep those async too
(`readWorkspace`, `readSnapshotNodes`); the thread watch still names them.

For an `inputKeyed` check, `ctx.repo()` records what it answers: `has` as an
existence fact, `under(dir)` as the membership of `dir/**`, `all()` as the whole
tree's, `read` as a content fact. A check that moves its reads onto it needs no
read-set code for them.

The runner holds up its end: each check starts on its own event-loop turn
(`createTurnQueue`), so ~100 checks' synchronous start-ups no longer run as one
block before any timer.

## Bumping the cache-key format version

Slot names carry `CACHE_KEY_VERSION` ([`core/cache.ts`](core/cache.ts)). Bump it
when the **meaning** of a recorded entry changes but its key would not — e.g.
entries recorded under a weaker guarantee must stop being trusted.

Never bump for a change in check logic: `ReadSet.codeKey` covers that (the
check's code key — see "`inputKeyed` carries an extra rule" above; it rides
inside the read-set payload and is verified on read), and a legacy slot's key
is the whole tree, code included. The code key cannot help the legacy slot, whose `has()` is a bare
`existsSync` that never opens the file — renaming is the only way to retire one.
Never revert a bump either: returning to a retired version re-addresses the
entries it was raised to abandon. To undo `v2`, go to `v3`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Check runner and built-in checks for ./equin check
- Core:
  - Uses: 86 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `framework/tooling` ×12
    - `packages/timed-fs` ×11
    - `plugin-meta/plugin-records` ×10
    - `framework/tooling/exempt` ×7
    - `reports/check-thread-stall` ×7
    - `infra/stack-sampler` ×5
    - `infra/host-fs/user-path` ×4
    - `framework/tooling/checks/source-analysis` ×3
    - `infra/launcher/env-names` ×3
    - `infra/spawn` ×3
    - `plugin-meta/parse-utils` ×3
    - `infra/paths` ×2
    - `packages/macrotask-yield` ×2
    - `packages/owned-fd` ×2
    - `packages/thread-cpu-clock` ×2
    - `reports/outbox/file` ×2
    - `infra/file-sink.defineFileSink`
    - `infra/paths/repo-root.REPO_ROOT`
    - `packages/flock.flockTry`
    - `packages/semaphore.createSemaphore`
    - `packages/shared-work.sharedWork`
    - `packages/single-flight.singleFlight`
    - `packages/string-hash.sha256Hex`
    - `plugin-meta/plugin-tree/structure-records.buildStructureTreeOnce`
  - Exports (types):
    - `CandidateSource`
    - `CheckCache`
    - `CheckCachePruneReport`
    - `CheckRunProgress`
    - `CodeMatch`
    - `ContentHashMemo`
    - `DirFact`
    - `FileFact`
    - `FileSystemView`
    - `FoldCheck`
    - `FoldKey`
    - `FoldVerdictContext`
    - `GlobFact`
    - `GrepIndexStore`
    - `ImportMatch`
    - `ListCandidateSourcesOptions`
    - `LoadedCheck`
    - `OutstandingCheck`
    - `ProgressRecord`
    - `QueryFact`
    - `RepoPaths`
    - `RunChecksOptions`
    - `SourceText`
    - `TreeSnapshot`
    - `TscProgram`
    - `ValidateOptions`
    - `ValidateResult`
  - Exports (values):
    - `assertExemptableInvariant`
    - `computeTreeHash`
    - `currentScanView`
    - `defineFoldCheck`
    - `fingerprint`
    - `foldKeyOf`
    - `gitGrepList`
    - `grepCode`
    - `grepImports`
    - `hashFileBytes`
    - `hashFileCached`
    - `isBuildInProgress`
    - `isBuildProcess`
    - `listCandidateSources`
    - `loadTreeSnapshot`
    - `markBuildInProgress`
    - `maskedSource`
    - `openCheckCache`
    - `parsedTsSource`
    - `pruneCheckCache`
    - `readCheckProgress`
    - `readTranscriptVerdict`
    - `readTreeSnapshot`
    - `repoProgram`
    - `requestedJobs`
    - `runChecks`
    - `scopeOf`
    - `sliceCheckThread`
    - `sourceAnalysis`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shadow --shadow`
  - Imported by:
    - `framework/cli/build`
    - `framework/cli/check`
    - `framework/cli/op-runtime`
    - `framework/cli/test`
    - `framework/cli/test/digest`
    - `framework/tooling/checks/cache-prune`
    - `framework/tooling/checks/registry`
    - `framework/tooling/checks/type-check`
    - `framework/tooling/checks/type-check/backstop`
    - `infra/deps/updates`
- Exemptions:
  - Exempts itself from:
    - `imperative-create-table-allowlisted` — `cli/internal/grep-index-store.ts` (sanctioned)
    - `repo-walk-safety/no-adhoc-repo-walk` — `core/scripts/fix-shared-to-relative.ts` (sanctioned)
    - `user-path/no-unproven-claim` — `core/tree-hash.ts` (sanctioned)
    - `boundaries/no-platform-api` — `core/cache.ts`, `core/content-hash.ts`, `core/discover.ts`, `core/grep-code.ts`, `core/progress-log.ts`, `core/read-set.ts`, `core/scan-context.ts`, `core/thread-attribution.ts`, `core/thrown-outcome.ts`, `core/transcript.ts`, `core/tree-hash.ts`, `core/whole-tree-read.ts` (debt)
    - `repo-walk-safety/no-adhoc-repo-listing` — `core/repo-set.ts` (sanctioned)
    - `repo-walk-safety/no-adhoc-repo-listing` — `core/repo-files.ts` (sanctioned)
    - `repo-walk-safety/no-adhoc-repo-listing` — `core/tree-hash.ts` (sanctioned)
    - `blocking-fs/sync-named` — `core/cache.ts`, `core/content-hash.ts`, `core/progress-log.ts`, `core/scripts/fix-shared-to-relative.ts`, `core/thread-attribution.ts`, `core/transcript.ts`, `core/tree-hash.ts` (sanctioned)
- Cli:
  - Exports (values): `openGrepIndexStore`
- Test helpers:
  - Core: `@plugins/framework/plugins/tooling/plugins/checks/core/testing`
    - `createReadSetRepo` — Create the repo holding `files` (repo-relative path → content), committed.
    - `listRepoFiles` — Every repo-relevant path, repo-relative and sorted: tracked + untracked-not- ignored, minus index entries whose file is gone from the worktree — EXACTLY the membership `computeTreeHash` folds into the check cache key.
    - Types: `ReadSetRepo`
- Sub-plugins:
  - **`app-css-utilities-in-sync`**
  - **`app-declarations-in-sync`**
  - **`barrel-stubs-in-sync`**
  - **`bun-runtime`** [exempt]
  - **`cache-prune`** — The hourly checks.cache-prune job: ages out and caps the shared check-result cache and reclaims idle flight files, so no check run lists the whole cache.
  - **`class-token-walk-single-source`**
  - **`color-token-ref-in-sync`**
  - **`composition-closure`**
  - **`config-origins-in-sync`**
  - **`config-stable-list-ids`**
  - **`conversation-trailer`**
  - **`css-vars-single-owner`** [exempt]
  - **`css-vars-supplied`** [exempt]
  - **`data-migration-dml-only`** [exempt]
  - **`data-views-in-sync`**
  - **`eager-tier-in-sync`**
  - **`fields-eager-in-sync`**
  - **`format-clean`**
  - **`generated-artifacts-normalized`**
  - **`host-audit`** — The hourly checks.host-audit job: runs the host-scoped checks on main and files a host-check report per failure — the one place a verdict about the shared machine is delivered, since no worktree's…
  - **`host-budget`**
  - **`host-pools-declared`**
  - **`inherited-theme-defaults-scoped`** [exempt]
  - **`lint-directives-stable`**
  - **`migration-hashes-unique`** [exempt]
  - **`migration-metadata-consistent`**
  - **`migrations-in-sync`**
  - **`negated-complex-selector`**
  - **`no-db-backed-notify`**
  - **`no-disabled-flag`**
  - **`no-gitlinks`** [exempt]
  - **`no-hand-built-link-to`**
  - **`no-hardcoded-colors`**
  - **`no-plugin-imports-in-core`**
  - **`no-plugin-workspace-deps`**
  - **`no-raw-event-source`**
  - **`no-raw-sse`** [exempt]
  - **`no-raw-websocket`**
  - **`no-reexport-default`**
  - **`no-relative-server-imports`**
  - **`no-use-resource-cast`**
  - **`plugin-boundaries`** [exempt]
  - **`plugin-refs-resolve`**
  - **`plugins-doc-in-sync`**
  - **`plugins-have-claudemd`**
  - **`plugins-registry-in-sync`**
  - **`pre-barrel-manifests-complete`**
  - **`registry`** — The check registry: the check collected-dir marker, its generated check.generated.ts, and loadChecks / listAllChecks — every registered check with the module its code lives in. Apart from…
  - **`reorderable-slots-in-sync`**
  - **`snapshot-chain-intact`**
  - **`source-analysis`**
  - **`space-ramp-in-sync`**
  - **`table-defs-in-schema-glob`** [exempt]
  - **`tailwind-scan-covers-classes`**
  - **`theme-bridge-reads`**
  - **`theme-declarations-in-sync`**
  - **`token-group-vars-in-sync`**
  - **`tsconfig-alias-single-owner`**
  - **`type-check`** [exempt] — spawnTypeCheckWorker: the one way to start a repo-program type-check worker — admitted first as a small run through the laned type-check-light pool (its worker refuses any program over…
    - Plugins:
      - **`backstop`** — The two-program type check's backstop: a daily main-only job runs the type-check worker in dual mode (the two-program check beside a full check of a fresh whole program, compared file by file) and…

<!-- AUTOGENERATED:END -->
