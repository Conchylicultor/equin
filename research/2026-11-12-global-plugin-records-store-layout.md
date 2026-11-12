# The plugin-records store's layout made a lookup ~4× the pages it needs

Task: plugin-records store — a point lookup costs 2–60 ms under load, so a
300-record flush takes ~50 s. Follows `2026-11-10-global-plugin-records-store-growth.md`
(key churn) and the writer-line / `writeBounded` work (no read under the lock).

## Symptom

On 2026-11-12, `records.v2.sqlite` held 24.4M key rows in 8.86 GB. At load ~40
a random point lookup took 2–60 ms. Every write's probe and every read is such
a lookup, so a flush of 300 new records spent ~50 s reading.

## Split: what the 8.86 GB is (dbstat, v2, 4 KB pages)

| B-tree | pages | interior | overflow | depth | rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| `keys` (tbl, key → vid, used) WITHOUT ROWID | 531,678 | 11,943 | 0 | 5 | 24.4M |
| `keys_vid` index | 512,621 | 11,096 | 0 | 5 | 24.4M |
| `vals` (vid → value) WITHOUT ROWID | 1,116,265 | 15,190 | 1,014,402 | **8** | 633k |

- **`vals` is half the file, and 8 levels deep for 633k rows.** In a WITHOUT
  ROWID table the B-tree's cells ARE the rows, interior cells included, up to
  ~1 KB local payload each. With ~1–2 KB values an interior page holds ~6
  children, so the tree is deep and its 15k interior pages are themselves
  60 MB to keep cached. Every value also spills into overflow pages (1.6 per
  value). SQLite's own guidance: WITHOUT ROWID only for rows under ~1/20 of a
  page.
- **`keys_vid` is a quarter of the file and serves one query**: the reclaim's
  "does any key still name this value?". It is also a third B-tree every
  insert descends (a random leaf per new key).
- **`keys` stores a 32-byte value hash per row** to name a value that is
  identified by 633k distinct hashes.

The live rows are spread uniformly over every page (sha256 keys), so the
working set of a build's lookups is the whole file regardless of how few rows
are live: 8.86 GB competing for the page cache on a loaded host.

## Fix: records.v4.sqlite

```sql
keys (tbl TEXT, key BLOB, val INTEGER, used INTEGER, PRIMARY KEY (tbl, key)) WITHOUT ROWID
vals (id INTEGER PRIMARY KEY, vid BLOB NOT NULL UNIQUE, used INTEGER, body BLOB)  -- body = zstd(value)
```

- `vals` is a rowid table: interior cells are rowids, depth 3. The hash → id
  lookup a write needs is the UNIQUE index (40-byte cells).
- Keys name values by rowid (2–4 bytes, not 32).
- Values are zstd-compressed (JSON, and group records' JSON lists of JSON,
  shrink ~6×), so nearly all fit their leaf: overflow pages 1.01M → 19k.
- No `keys_vid`. The reclaim instead relies on `vals.used ≥ used` of every key
  naming the value — maintained because every key write and every last-read
  refresh moves both rows in one transaction. It deletes keys unread for 7
  days, then values unread for 7 days (each re-checked under the lock).

## Measured (same 24.4M rows, converted)

| | v2 layout | v4 layout |
| --- | ---: | ---: |
| file | 8.86 GB | **2.10 GB** |
| `keys` | 531k pages, depth 5 | 339k pages, depth 4 |
| `keys_vid` | 513k pages | — |
| `vals` | 1.116M pages (1.01M overflow), depth 8 | 166k pages (19k overflow), depth 3 |
| `vals` unique index | — | 7.3k pages |
| point lookup, warm, p50 / p90 / p99 | 0.075 / 0.110 / 0.324 ms | **0.030 / 0.041 / 0.081 ms** |

Today's fresh v3 store (309k rows): 234 MB → 155 MB (layout) → 51 MB (+ zstd).

Through the real store code on the converted 24M-row file (host load ~4):
`getMany` of 3,000 live keys 137–148 ms; a flush of 300 new ~2 KB records
176 ms (2 transactions, longest hold 37 ms); of 3,000, 612 ms (15
transactions, longest hold 66 ms).

Not measured: the cold case under load ~40. The host was at load ~4, and the
page cache cannot be dropped without root, so both files were partly cached.
The cold cost follows from pages per lookup and the working set: a lookup
reads ~2.1 leaf/overflow pages instead of ~3.6, through 22 MB of interior
pages instead of ~110 MB, in a file 4.2× smaller — 4.2× more of it fits the
same cache.

## What is left: volume = key churn × retention

Rows by the day they were last read (v2, `used`): before the lockfile fix
(Nov 9–10) 5–7M a day; after it (Nov 11) **2.4M a day** — file 1.25M,
module 0.46M, group 0.30M, facet 0.27M, evaluated 0.10M. With 7-day
retention that is ~17M rows at steady state, ~1.5 GB in the v4 layout (the
keys B-tree, at ~57 B a row, is now two thirds of the file).

- **module records**: 3.6M keys for **48 distinct values** in v2. Each is keyed
  by the module's Merkle key under the evaluator's key, so a change to any
  widely-imported module, or to the evaluator's 346-module closure (88 of 484
  main commits), re-keys every module above it — per worktree base. Filed as a
  sidequest. **Done:** a module's facts (slots created, subscribes) are a
  function of its closure, which every barrel above it already keys, so they
  now ride on the barrel's `evaluated` record and the `module` table is gone.
  Over the last 484 main commits that is ~3,245 module keys per commit no
  longer minted, against ~643 barrel keys per commit both schemes mint (−83%
  of evaluation keys); `--verify-records`: 139,208 agree, 0 disagree. The
  evaluator's own closure (361 modules, 76/484 commits, mostly
  barrel-import's stubs) is the next rung — filed as a sidequest.
- **file records**: 1.25M new keys a day for ~40–54k distinct values: every
  move of a scan's own closure re-keys every file's record for that scan.
  Filed as a sidequest.
- **retention** (7 days) is the user's call: halving it halves the steady
  state, at the cost of a cold rebuild of the records for a worktree idle that
  long.

## How often: a one-line edit asks ~32k lookups (task-1794469426)

The sections above make one lookup cheaper. This one counts how many a pass
asks, and why. Measured 2026-11-12 on a worktree check pass (v2 store, load
~14), with `getMany` traced by caller (temporary instrumentation, since
reverted).

### Split

After a **one-line edit** (a comment appended to
`hints/help-menu/web/index.ts`), one `./equin check`:

| caller | SQLite lookups | keys asked | calls | values read |
| --- | ---: | ---: | ---: | ---: |
| `scanFilesCached`: groups (`file-scans.ts` → `readGrouped`) | 13,563 | 15,202 | 1,579 | 26.7 MB |
| `scanFilesCached`: one-file plugins, read on their own | 5,987 | 6,064 | 1,514 | 1.9 MB |
| module graph `walkLevels`: one-file groups, read as files | 3,862 | 8,075 | 117 | 1.6 MB |
| module graph `walkLevels`: groups | 2,950 | 4,686 | 132 | 5.3 MB |
| `evaluateBarrels`: module groups | 1,965 | 2,796 | 2 | 0.8 MB |
| `evaluateBarrels`: evaluated barrels | 1,928 | 3,114 | 2 | 11.5 MB |
| `facetRecordTexts`: facet groups | 1,770 | 3,536 | 2 | 14.1 MB |
| rest | ~230 | | | |
| **total** | **~32.2k** | 43.8k | 3,364 | ~62 MB |

- **Every lookup hits** (~100% in each row): the cost is the count, not misses.
- A **fresh worktree's first pass** asked the same 32,181. A **second pass on
  an unchanged tree asked 0**: every check answered `ok (cached)`.
- After the one-line edit, **173 of 192 checks re-ran** (19 cached). Most
  checks key their PASS on the whole working-tree hash (`checks/core/cache.ts`).
  Only 9 are `inputKeyed` (`checks/core/read-set.ts`), so any edit re-runs the
  rest, and each re-run rebuilds its readers' whole-tree results.
- `walkLevels` is the latency chain: 117 level reads one after another across
  the module graphs (17 s of summed await at load ~50, 2 s at load ~14). Its
  groups are per plugin **per BFS level**, so one plugin's modules split over
  several groups, and many groups have one member (the 3,862 file lookups).

### Root cause

Records are grouped per plugin and nothing aggregates above that, so a reader
over the tree costs at least one lookup per plugin it covers: about 10 scans
× ~1,500 plugins, plus facets, the module graph and the evaluator. That is
O(plugins × readers) per pass. A pass happens on every edit because most check
verdicts are keyed on the whole tree. The record cache below is
O(changes) per record but O(plugins) per reader. The check cache above it is
O(1) on an unchanged tree but all-or-nothing on any change (a global
fingerprint).

### Options analysed (none implemented)

- **Each check keyed on what it reads (the structural fix).** Move checks onto
  the input-keyed read-set path (`read-set.ts`), so a one-line edit re-runs
  only the checks whose recorded reads it touches. Their readers then ask
  records only for those. This targets "how often", the dominant factor
  (173/192 re-runs for one comment). It is the follow-up this session takes
  over.
- **Merkle groups along the plugin tree:** each umbrella stores its subtree's
  values. A pass touching one plugin would need ~1 lookup per untouched reader
  and ~depth × fan-out (≈50–250) per touched one, instead of ~1,500. The cost
  is write amplification: a reader whose output changes rewrites every
  ancestor's value, up to the whole scan (~2.7 MB a scan; 26.7 MB over all
  scans). Group values already held ~593 MB (122k distinct) for the last two
  days of live rows in v2, so this needs the next point first.
- **Group values in path order, not member-key order:** today a group value
  lists its member values in sorted-key order, so a member whose key moved but
  whose value did not (a comment edit; a scan's closure re-key) still writes a
  new group value. In path order these would dedupe. This needs a one-time
  re-key of groups and does not reduce key rows. On 11-12, group rows read
  that day were 221k keys for 47k distinct values.
- **Module graph grouped per plugin, not per (plugin, level):** ~6.8k →
  ≤1.5k lookups. It stays O(plugins). The user ruled it out (D7) in favour of
  the structural fix.
- **Retention:** the user's call (above).

### Reclaim is not what keeps the dead rows

On 11-12 no v2 row was older than 7 days, `meta.pruned` was today's, and
`auto_vacuum = INCREMENTAL`. File rows by last-read day −7…0: 1.28M, 1.88M,
0.02M, 4.56M, 3.09M, 1.00M, 1.25M, 0.42M. The dead 95% is churn × 7-day
retention (the section above). Random sha256 keys spread the live rows over
nearly every page.

## Re-measured on the v4 store, and the first fold (task: check pass O(changes))

Measured 2026-11-12 on a worktree check pass at host load ~22–25, after the v4
layout and the narrowed scan keys landed. Same one-line edit as above (a
comment appended to `hints/help-menu/web/index.ts`), `getMany` traced by caller
(temporary instrumentation, reverted).

### Split of a one-line-edit pass

- **173 of 192 checks re-ran**, 73 s from the host grant to the verdict.
- **The check thread was the bottleneck**: ~63 s of its 73 s busy (14.5k
  samples at 230 Hz). Process CPU 95 s user + 77 s system.
- **~278k file reads** by the checks' own bodies (`fs` on each `end` record):
  the re-run checks each re-read the tree (plugin-boundaries 52.9k,
  relocate:moved-plugins-unnamed 24.7k, boundary-rules 20.3k, parse-utils:mask-sync
  16.9k, sql-writes:fit 14.0k, pre-barrel-manifests-complete 13.1k, …).
- **29.6k record lookups** (down from 32.2k on v2), off the thread: waited on
  ~15 s of union wall time in a pass at load ~25, overlapping the thread's
  work. Top callers unchanged: module-graph `walkLevels` (6.9k), `scanFilesCached`
  for plugin-refs `find` (4.4k), the registry generator (4.5k), facet groups
  (1.8k), icons (3.4k), evaluated barrels (1.9k).
- **Thread owners** (top 10 of the pass): shared TS parse
  (`parsedTsSource`) 7.3 s, plugin-boundaries 5.7 s, boundary-rules' run 5.4 s,
  grep-index `select` 5.1 s, semaphore 3.4 s, plugin-refs `findPluginMentions`
  3.0 s, `platformOffenders` 1.9 s.

So the cost is not the lookups but the re-run checks' whole-tree work: a check
keyed on the whole tree re-runs on any edit, and its body then re-reads and
re-judges every file. A lookup count is one symptom of it.

### Fix: per-file work folded along the directory tree

`plugin-records`' `foldFilesCached` / `foldRepoFiles` (`core/internal/tree-fold.ts`):
a per-file scan whose answers are folded per directory, each directory's fold a
record keyed by its members' keys (a Merkle tree over the selected files). A
pass asks top-down and recomputes only the files whose key moved: an
unchanged tree is one lookup, a one-file edit ~80 lookups and one scan. This
is O(changes) by construction — no fingerprint is consulted, every record is a
pure function of its key — and it reuses the store, the scan-module identity
and the verifier of the existing records.

Adopted by the two largest file-local checks of the split:

| one-line edit | before | after |
| --- | ---: | ---: |
| boundary-rules: files read by its body | 20,269 | 3,733 (the shared plugin tree it builds first) |
| boundary-rules: thread owner `run @ boundaries/core/check.ts` | 5.4 s | gone from the top 10 |
| relocate:moved-plugins-unnamed: files read | 24,738 | 335 |
| relocate: thread owner `findPluginMentions` | 3.0 s | gone from the top 10 |
| fold lookups (both checks) | — | 159 |
| whole pass: files read by check bodies | 277.6k | 230.8k |
| whole pass: record lookups | 29.6k | 26.3k |

The pass's wall time is dominated by the other 171 re-run checks and was
noise-bound at this host load (73 s → 89 s from grant, with the sampler's rate
dropping 230 → 170 Hz, i.e. a busier host), so it is not the measure here.

### Next

The same fold for the next file-local whole-tree reader by cost:
plugin-boundaries (52.9k reads, ~6 s of thread). Then the shared TS parse
(sourceAnalysis checks), parse-utils:mask-sync, sql-writes:fit and the grep
selections, each needing its per-file part separated from its cross-file part.

## The fold as the check API's shape: plugin-boundaries (task: check pass O(changes), 2)

`checks/core` gains `defineFoldCheck`: a check declares its per-file work (a
plugin-records `FileFold` in a `*.scan.ts` module), the small context every
file's part reads (part of the key), what the verdict alone reads, and the
verdict — which is handed the file set without `read`. The runner sees an
ordinary `Check`. plugin-boundaries is its first user, relocate's
moved-plugins-unnamed its second (a mechanical rewrite of its `foldRepoFiles`
call). boundary-rules stays on `foldRepoFiles` directly: it lives in
`boundaries/core`, and `checks/core` importing back into it would close a
plugin cycle.

plugin-boundaries split: per file (the fold) — R1 (a package.json), R3 purity
and R12 (a barrel), R4–R10, and what the cross-file rules need of each file:
its R6 edges, its R13 barrel uses (`combineBarrelUses`: shipped names, plus the
test importers of names nothing shipped takes yet — associative, and as small
as the shipped names), a public barrel's names, its re-exports
(`summarizeExports`). Across files (the verdict, no reads) — R1 missing
package.json, R3 barrel-required and the provenance chase over the folded
re-exports, R6 cycles, R11, R13. Equivalence: the old and new check report
the same 19 violations on an injected fixture exercising every rule.

Measured 2026-11-12, host load 17–34 (not calm; no calm window came):

| plugin-boundaries | before | after |
| --- | ---: | ---: |
| one-line edit, in a full pass: files read | 52,937 | 2,300 |
| one-line edit, in a full pass: check-thread samples (owner `check …/plugin-boundaries`) | 1,410 (~9.4 s at 150 Hz) | below the top 10 (< 234) |
| one-line edit, alone: duration / reads | 8.6 s / 56.7k | 0.4–0.8 s / 6.0k |
| cold fold (scan module edited), alone: duration / reads | (every run) 8.6 s / 56.7k | 3.4 s / 24.4k |

The cold case reads each file once (the old walk read barrels and re-export
chains a second time), so it is cheaper than the old every-run cost too. The
6.0k reads left alone are the shared inputs a fresh process builds first (the
plugin tree, the collected-dir discovery, the exemption manifests, the scan
module's import graph); in a full pass another check usually builds the
plugin tree first, leaving 2.3k.

**What an edit writes.** A directory's record holds its subtree's whole
answer, so each edit writes the answer again for every ancestor of the edited
file. plugin-boundaries' answer over the repo was 4.3 MB at first (re-exports
1.8 MB, edges 1.7 MB); edges grouped by source (`<from>\0<runtime>` → targets)
and re-exports spelled as tuples bring it to 2.8 MB (boundary-rules': 1.7 MB).
And `foldFilesCached` now treats a one-member directory as its member
(`combine([a])` is `a`): the repo root, which holds only `plugins/`, no longer
writes a second copy of the whole answer. The answer stays O(repo) because the
verdict's inputs are (the cycle graph, every barrel's names and re-exports);
each edit writes about one whole answer plus its plugin's subtree, reclaimed
after 7 days unread.

Whole pass, one-line edit: 58.5 s → 62.4 s from start to verdict, at load 17
vs 26 — noise-bound; files read by check bodies 236.7k → 180.4k. The thread is
now led by the shared TS parse (`parsedTsSource`, ~10 s), grep-index `select`
(~7 s), `platformOffenders` (~4.5 s).

### Next

The rest of the whole-tree readers by measured cost, each a fold check once its
per-file part is separated from its cross-file part: parse-utils:mask-sync
(16.9k reads), theme-bridge-reads (16.6k), sql-writes:fit (14.0k),
negated-complex-selector / script-state:no-stylesheet-reads (13.9k each),
pre-barrel-manifests-complete (13.1k), boot:closure-digestable (11.9k); and the
shared TS parse behind the sourceAnalysis checks. Nothing yet stops a new check
from doing whole-tree work in `run()`: the runner counts each check's reads
(`fs` on its `end` record), so an unbounded read can be made a declared,
visible property of the check.

## The shared parse: who parses, and mask-sync as a fold (task: check pass O(changes), 3)

Measured 2026-11-12, same one-line edit (a comment appended to
`hints/help-menu/web/index.ts`), host load 9–14. A parse probe (temporary,
reverted) tallied `parsedTsSource` misses by the check in whose async context
they ran:

| check | parses | parse CPU (in-thread) |
| --- | ---: | ---: |
| parse-utils:mask-sync | 13,161 | 1.86 s |
| no-db-backed-notify (sourceAnalysis) | 3,542 | 1.09 s |
| sql-writes:fit | 2,583 | 1.09 s |
| everything else | 31 | 0.02 s |

So "the shared parse" was mostly one check: mask-sync parsed and masked every
`.ts` / `.tsx` on every pass (whole-tree keyed, so any edit re-ran it), though
its work is purely per file and its answer (the divergences) is almost always
empty. It is now a fold check (`parse-utils/check/mask-sync.scan.ts`), input-
keyed; its records are keyed by the scan module's closure, the masker included,
so a masker edit still re-folds every file. Verified: an injected template-JSX
desync is still reported, with its line.

| one-line edit | before | after |
| --- | ---: | ---: |
| mask-sync: files read (in the pass) | 16,887 | 338 |
| mask-sync alone: duration | (every run, in-pass 22.9 s contended) | 0.12 s |
| mask-sync cold fold alone (scan module new) | — | 2.8 s / 16.9k reads, once |
| parses in the pass | 19,317 | 6,163 |
| thread owner `parsedTsSource` | ~5.6 s | ~2.9 s |
| check-thread samples, whole run | 3,910 at 86.8 Hz (~45 s) | 3,038 at 98.4 Hz (~31 s) |
| files read by check bodies | 250.8k | 229.0k |
| run, grant → verdict | 52.2 s | 49.0 s (noise-bound) |

Bytes written to the store per edit by this fold: the edited file's record and
its ancestor directories', each an empty list — O(depth) records of a few
bytes; the answer is O(divergences), not O(repo).

Thread owners after (top): grep-index `select` ~3.7 s, `parsedTsSource`
~2.9 s (no-db-backed-notify and sql-writes:fit, both cross-file), 
`platformOffenders` ~1.9 s, semaphore ~1.7 s.

### Next

grep-index `select` is now the largest owner: every selection asks the store
about every blob of its domain (~99 queries × ~11k blobs per pass), so a
one-line edit still costs ~1M lookups. Then the remaining parse, which goes
through sourceAnalysis's cross-file reads.

## Grep selections folded along git's trees (task: check pass O(changes), 4)

Measured 2026-11-12, same one-line edit (a comment appended to
`hints/help-menu/web/index.ts`), host load 3–12; selection internals by a
temporary probe (reverted).

### Split of `select` before

Per pass, 91 selections (each a `git grep -l` the checks narrow by):

- **1.40M per-blob store lookups** — every selection asked about every blob of
  its domain (~15k), synchronous SQLite on the check thread: 1.7–2.5 s of
  thread, the bulk of the owner's ~3.7–4.9 s.
- **91 whole-tree domain listings** — `read-tree` of the run's tree into a
  scratch index plus `ls-files -s` (twice with excludes), each O(repo) in git
  and parsed on the thread: ~9–12 s of summed wall, off-thread mostly.
- 82 literal greps of the one edited blob (one per query whose domain holds it).

Root cause: the answer was keyed per blob, so a selection was O(domain) lookups
plus an O(repo) domain listing, whatever changed. The per-blob key made the
*grep* O(changes), never the *selection*.

### Fix

A selection over a git tree is a pure function of (query, pathspecs, tree id),
and git's trees are a Merkle tree over the directories. So `select` folds along
them (`checks/core/grep-index.ts`): a directory record per (query, pathspecs,
path, tree id) holds its own selected names and its matching sub-directories
**by tree id** (the child record's key — never a copy of the child's answer, so
an edit writes O(depth) bytes); a membership record per (pathspecs, path, file
names) says which files the pathspecs name (git's own matcher over a scratch
index of just those files, `filterPathspec`); the per-blob answers stay for the
files of a directory being folded. A walk reads records down from the root
tree, entering only directories with a match below; a missing record reads
that tree object (`cat-file --batch`, one per level, shared by every selection
of the run). Nothing is invalidated wholesale and no fingerprint is consulted:
every record is a pure function of its key, so a hit is the answer, and the
cold case is the same walk with every record missing.

| one-line edit (91 selections) | before | after |
| --- | ---: | ---: |
| store lookups | 1,395,806 | 35,754 dir records + 356 blobs |
| whole-tree domain listings (git spawns of O(repo) work) | 91 (~180 spawns) | 0 |
| tree objects read | — | 6 (6 spawns) |
| membership asked of git | (in the listings) | 0 |
| bytes written to the store | 82 answer rows | 528 dir records, 83.5 KB + 82 answer rows |
| check-thread owner `select` | ~3.7–4.9 s (top 1) | below the top 10 (< 0.6 s) |
| run, start → verdict | 44.2 s (load 3–7) | 44.1 s (load 8–10, noise-bound) |

The 35.7k lookups that remain are the directories with a match below, read to
list the selection (O(matching directories), ~390 per query); the 82 literal
greps are the edited blob's own answer per query.

Cold store (every fold missing, blob answers warm): 9,189 tree objects read in
15 spawns, membership asked of git 17 times (once per distinct pathspec set,
the whole tree each), 858k directory records (78 MB) and 157k membership
records (15 MB) written — every directory once per query, reclaimed like the
blob answers after 14 days unread. From an empty store a selection is 0.7–2.4 s
(the whole-query grep, as before) and 3–66 ms warm.

Equivalence: on the real tree, five selections (including `:(exclude)` and
`:!` pathspecs, 16 to 12,243 matches) equal `git grep -l` cold and warm; the
unit tests check that a content edit records exactly the edited path's
directories and asks no membership again.

### Next

The folds of `defineFoldCheck` / `foldRepoFiles` (plugin-boundaries 2.8 MB,
boundary-rules 1.7 MB) still write their whole O(repo) answer into every
ancestor's record per edit: the shared store's churn grows with every edit.
Their verdict reads the combined answer at the root, so referencing children by
key moves the cost to the read; the design has to keep both O(changes).
