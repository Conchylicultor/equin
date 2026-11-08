# Lint store: a rule or package change rewrites only what it can affect

Task: task-1794168950 (responsiveness audit, supervisor task-1793965642-94fdhj),
follow-up of task-1794161253 (research/2026-11-08-global-fseventsd-event-volume.md).

## Problem

On 2026-11-08 the type-check lint store took 246k writes in 6.5 h for 15.4k
files: 18 whole-tree rewrites of ~15k entries, each 500–800 worker CPU-s, in
bursts up to 58 % of a minute's file events (fseventsd saturation).

Measured over every retained check transcript (`~/.equin/worktrees/*/check-*.log`;
transcripts of reaped worktrees are gone, so these are lower bounds):

| day | runs | per-file entries written | whole-tree re-lints | their worker CPU |
| --- | --- | --- | --- | --- |
| 11-06 | 324 | 240,075 | 15 | 7,870 s |
| 11-08 | 333 | 408,489 | 26 | 15,413 s |

The 26 whole-tree runs of 11-08, by what the plan said:

| plan | runs |
| --- | --- |
| `rules moved` (base under other rules) | 21 — 13 of them the whole engine (124–126 groups), 6 one or two groups, 1 the typed engine |
| `base none` (fresh worktree, no candidate tree had a base) | 3 |
| same rules, every result key moved (tsc global: patch / lockfile / producer) | 2 |

## The layers

1. **Why 15k writes for one rule.** Re-linting was already per group (only the
   moved group re-ran), but `finalize` merged the fresh group result into each
   file's per-file entry — one entry rewrite per lintable file, though the run
   base (content-addressed shards holding only non-empty messages) had the
   same information and, for a rule edit that changes no message, needed no
   shard write at all.
2. **Why every worktree paid it again.** Base choice looked at four trees near
   the run (this tree, last run, HEAD, merge-base). After a rules move none of
   them has a base under the new rules unless that very tree was checked —
   main's merged trees usually were not — so each worktree re-ran the move
   itself, reusing only what the per-file store had not evicted.
3. **Why the engine moved for code lint never loads.** The engine hashed the
   whole lockfile's npm resolutions, every `patches/` file and the root
   `package.json`. Replaying main 11-01..11-08 (479 first-parent commits), that
   part moved 6 times; 5 of them were patches of graphile-worker /
   @parcel/watcher (with their lockfile lines) or a server-only package.
4. **Why a JS-only patch re-checked everything.** `tscEngineFp` hashed every
   patch file. The compiler reads no `.js` (no `allowJs`), so a patch of a
   package's JS or native code cannot change a type — yet it moved every R,
   re-running every tsc result and every typed lint part.

## What landed

- **Rules pointer** (`shared/run-base.ts`): per set of lint inputs
  (`lintInputsKey`), the latest root written under them, on any tree. Base
  candidate 5 (`check/prepare.ts` `chooseBase`), after the four nearby trees.
  A rules move is re-linted once per host; later runs carry from it, sending
  only files whose version differs. Covers the `base none` case too.
- **Left to the base** (`finalize`): a text the base held, re-run because the
  rules moved, is not rewritten in the per-file store; its new results go into
  the next base only. A typed part whose rules did not move (it ran because R
  moved) is still recorded. Transcript: `N entries written, M left to the base`.
- **Lint npm closure** (`infra/deps/npm` `lockfileNpmClosure`, `check/lint-groups.ts`):
  each closure (engine, each contribution) is keyed on the lock entries of the
  packages it imports by name, closed over dependencies and peers (node's
  resolution over bun's lock keys; workspace-scoped copies included, so the
  key may over-cover, never under-cover), plus the patches applied to any of
  them — read from the code checkout's lock. `package.json` and unrelated
  patches are out. `ENGINE_PACKAGES` in `lint-groups.test.ts` holds the engine's
  set. Replay 11-01..11-08: engine npm/config moves **6 → 1**.
- **Type-visible patches** (`shared/tsc-engine.ts` `typeVisiblePatch`, over
  `patchTouchedFiles`): a patch whose `diff --git` headers name only JS,
  native sources or source maps is out of the global hash; an unreadable patch
  counts. Replay: tsc lockfile/patch moves **6 → 4** (the other 2 add a patch,
  which rewrites `bun.lock`'s resolutions).

## Cost of landing

The lint group fingerprints' formula changed and the tsc global hash moves
once (the JS-only patches drop out): one whole-tree check + re-lint, per HOST —
the name store is keyed by R and the run base by rules pointer, so the second
worktree reuses the first's. `pass-set.ts` is untouched.

## Measured on this branch

| run | plan | linted | per-file entries written | shards written | worker CPU |
| --- | --- | --- | --- | --- | --- |
| build 1 (new group formula, no run under it yet) | `base none (…; same rules: none)` | 15,521 whole | 15,521 | — | 527 s |
| build 2 (typed engine moved: `tsc-engine.ts` edited) | `rules moved (0 groups, 16 typed parts)` | typed 15,521 | **5** (15,516 left to the base) | 1,663 (every R moved) | 371 s |

Build 2 is the old behaviour's worst case for writes: before, the same run
wrote 15,521 entries + 1,663 shards (~17.2k), now 5 + 1,663 (~1.7k). A
syntactic-only rule edit that changes no message writes ~0 shards too
(content-addressed, R unchanged). Lint engine: 12 files (was 16–21).

## Expected after (estimate on 11-08's mix, to be confirmed on the next days' transcripts)

- The 21 rules-moved runs: per-file writes from ~15k each to the changed files
  only; re-lint only for the first run per rule set on the host.
- The 3 `base none` runs: carried from the rules pointer.
- The 2 R-moved runs: unchanged when the cause is a dependency resolution
  (see follow-ups); gone when it was a JS-only patch.

Measure with: `grep -ho "[0-9]* entries written, [0-9]* left to the base"` and
`base same rules` over the check transcripts.

## Not done (follow-ups)

- **The tsc global still keys on the whole lockfile**: a new package anywhere
  (libpg-query, node-api-headers on 11-02..11-08) moves every R — a whole-tree
  check and typed re-lint, with 15k per-file typed writes. Narrowing needs the
  program's npm closure (imports of every repo file + the `types` packages), a
  larger change to the global hash.
- **`pass-set.ts` rewrites the `.writes` counter on every record** (unchanged).
