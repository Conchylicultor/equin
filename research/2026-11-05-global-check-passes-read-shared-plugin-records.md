# Check passes read the shared plugin-records store (decision D8)

## Context

Every `./equin check` process keeps a per-process memory record store, so on
every pass, in every worktree, it re-extracts every facet, re-imports every
barrel and rebuilds the module graph, token usage and plugin refs: ~30 s of the
shared check thread per pass, ~1 pass a minute fleet-wide
(task-1793832150-iokzai). The build already reads the shared SQLite store.

The memory store was the net against a record whose key missed an input
(plugin-records CLAUDE.md, "What escapes a key"). D8 (approved): records keyed
by EVERY input, the producer's own code included; a daily main-only full
recompute as a loud VERIFIER, not a cache bypass; only then do checks read the
shared store.

## Measured (2026-11-05)

Store: `~/.equin/cache/plugin-records/records.sqlite`, **4.4 GB after two
days** (created 11-03; the 14-day prune has never deleted a row).

| table | rows | distinct values | value MB |
| --- | ---: | ---: | ---: |
| evaluated | 264k | 2,208 | 1,525 |
| facet | 2,126k | 7,384 | 731 |
| file | 5,197k | 20,667 | 352 |
| module | 1,158k | 47 | 41 |

Keys (hex text) are another 560 MB. **~99% of stored values are byte-identical
duplicates under different keys.** A key changes when anything in its
producer's code closure changes, though the value almost never does:

| producer identity (Merkle closure) | modules | re-keyed by (of last 200 main commits) |
| --- | ---: | ---: |
| file scanners in `plugin-registry-gen.ts` / `eager-tier-gen.ts` | 376 | 52 |
| `data-views-gen.ts` scanner | 309 | 37 |
| `icon-manifest-gen.ts` scanner | 95 | 19 |
| facet harness `faceted-tree.ts` | 80 | 19 |
| cross-refs facet | 238 | 27 |

Each re-key rewrites the whole set (~30k file × scanner, ~18.5k facet rows).
So old data is kept that will never be read again: rows keyed by a code state
only one transient checkout had, each holding a duplicate of a value stored
thousands of times.

## Design

### 1. Every input in the key, the producer's code included

- **File facts** (the module graph's own per-file scan) are keyed by a
  hand-bumped `FILE_FACTS_VERSION`. Replace it with the Merkle key of the scan
  code (`scan-imports.ts`'s closure), computed by an unrecorded graph over
  that closure: derived, never maintained by hand.
- **File scans** name their module by a hand-typed path string that must match
  the file the scan lives in. Replace it with `defineFileScan(import.meta.url, …)`:
  the identity is the defining module, by construction. Move each codegen scan
  into its own small module (`*-scan.ts`), so its identity is the scan code, not
  a 376-module generator.
- **Facet harness**: key by `facet-records.ts`, the module that runs the
  extraction, not `faceted-tree.ts` / `plugin-tree.ts`. Neither runs inside a
  record's computation; what they decide (dir, id) is already in the key.
- **Plugin refs**: `findPluginRefs` becomes per-file records
  (`scanFilesCached`, keyed by its scanner module, the kinds and the blob),
  instead of a full rescan of every file on every pass.

### 2. The verifier: `./equin check --verify-records`

A verifying `RecordStore` (plugin-records `cli`):

- serves reads only from what THIS process computed, so every record is
  recomputed;
- compares each value it is handed with the shared store's value under the
  same key, writing nothing.

Its verdict is the run's exit status, and each disagreement is printed with
its table, key and both values. Check failures are still printed, but are not
this run's verdict. `--verify-records` implies `--no-cache`, since the checks
must really run.

A daily main-only supervised job `plugin-records.verify` (new `server/` barrel
of plugin-records, shaped like `checks.host-audit`) runs it. A non-zero exit
fails the run, which files the job's failure report.

### 3. Checks read the shared store

`check/cli/run.ts` installs `openRecordStore()` (or the verifying store under
`--verify-records`). Records are then O(changed) for every check pass.

### 4. Store size: content-addressed values

New schema (`records.v2.sqlite`, `auto_vacuum = INCREMENTAL`):

- `keys(tbl, key BLOB(32), vid BLOB(32), used)` and `vals(vid, value)`, where
  `vid = sha256(value)`, so each distinct value is stored once;
- daily prune: keys unread for 7 days, then values no key references, then
  `incremental_vacuum`;
- the legacy `records.sqlite*` files are unlinked on the daily prune.

## Verification

- Unit: the sqlite store (dedupe, prune drops unreferenced values), the
  verifying store (mismatch, absent, match), and the file-facts identity.
- Before/after: `./equin check plugins-doc-in-sync plugin-refs-resolve
  plugin-refs:relative-links-resolve … --no-cache` on main's code (memory
  store), against the same run on this branch with a warm shared store.
- `./equin check --verify-records` on this checkout: zero disagreements.
- Store size after the migration (a build plus a few check passes).

## Results (2026-11-05, as built)

- **Check time**: the 7 plugin-tree checks (`plugins-doc-in-sync`,
  `plugin-refs-resolve`, `plugins-registry-in-sync`, `data-views-in-sync`,
  `eager-tier-in-sync`, `composition-closure`,
  `plugin-refs:relative-links-resolve`, `--no-cache`) went from 18.4 s in-run
  (15 s process user CPU), every record computed, to 7.7–11.4 s in-run (5–6 s
  user CPU) on the warm shared store. What remains is mostly check loading and
  the checks' own work.
- **The verifier found a real escape on its first run**: 2 of 89,594 records
  disagreed. Both were declaration-dependent barrels (pane, reorder), whose
  base evaluated record had been stored by a build that had already run a
  live declaration pass, so it held the contributions that pass filled in. A
  fresh process reads them empty. Fix: a dependent barrel's base record is its
  state before any pass (`declarationPassCount() === 0`); a process past one
  keeps its own reading and stores none.
- **After the fix**: `./equin check --scope tree --verify-records` reports
  115,500 records agreeing, 0 disagreeing, and every check green.
- **Store**: v2 holds 559k key rows and 34k distinct values (26 MB), 140 MB on
  disk, against 4.4 GB for the legacy file, which was unlinked. Worktrees still
  on the old code recreate `records.sqlite` until they rebase; the daily
  reclaim unlinks it again.
- Implementation also moved: the job is in a `verify` sub-plugin (a lone
  `server/`, so plugin-records' build-tooling `core` stays out of the backend
  closure). `findPluginRefs` takes its `scanFiles` (plugin-records'
  `scanRepoFiles`) for the same reason.
