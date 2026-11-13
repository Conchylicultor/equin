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

## A fold writes its own path, not its answer (task: check pass O(changes), 5)

Measured 2026-11-12, host load 17–25, with a write probe in the SQLite store
(new value rows and their zstd bytes, per table) and a fold probe (node and
value lookups, bytes read, phase times) — both temporary, reverted.

### Split before

The store already stores each distinct value once (`vals`, keyed by the
value's sha256), so the cost depends on the edit:

- **an edit that leaves its file's part as it was** (a comment) writes no
  value: every ancestor's combined answer is byte-identical. 26 key rows.
- **an edit that changes its file's part** (an import, an export, a
  violation) changes every ancestor's combined answer, the root's included:
  plugin-boundaries + boundary-rules wrote 7–14 new values, **3.3–5.3 MB raw,
  510–711 KB zstd per edit**, whatever the edit's size (five edits in
  `conversations`, `primitives/action-presentation`, `checks/core`,
  `hints/help-menu`: 3.2 MB zstd in total). Reclaimed only after 7 days unread.

Root cause: a directory's record was its subtree's combined answer, so an
answer-changing edit rewrote the answer once per ancestor — the root's whole.

### Fix

`foldFilesCached` (`plugin-records/core/internal/tree-fold.ts`) records two
kinds in the `fold` table:

- a **node** record (file by blob, directory by its members' keys — the same
  Merkle walk) holds only a ref to its value, `<size>.<sha256 of the body>`;
- a **value** record, keyed by that ref: a file's value, or a directory's
  whose members' sizes add up to ≤ 256 KB of JSON, held whole (`combine` of its
  members); a larger directory's value is the **list of its members' refs**,
  combined only when the answer is read.

A directory's size is its members' sizes added up (a file's is its JSON
length), so whole-or-list is decided from refs alone and a subtree is
recorded the same way whichever of its nodes a pass found. An edit re-folds
its path: whole directories read at most the limit of sibling values, lists
read nothing. A value can be reclaimed while its node record lives on (a
value under a whole one is read only when a sibling is edited); a pass that
meets one re-folds that node and writes it back — its own subtree, not an
error.

Equivalence: the unit tests compare against the flat fold with lists forced
(a 40-character limit), after an edit, after a reclaimed value, and with every
value reclaimed; plugin-boundaries, boundary-rules, mask-sync and relocate
report the same verdicts on the real tree.

| per edit, plugin-boundaries + boundary-rules | before | after |
| --- | ---: | ---: |
| answer-changing edit: new values written (zstd) | 510–711 KB | 3.4–38 KB |
| 5 answer-changing edits: store growth (zstd) | 3.2 MB | 72 KB |
| comment edit: new values written | 0 (26 key rows) | 0 (10–26 key rows) |
| node lookups, one-line edit | 55–132 | 55–132 |
| value lookups to read the answer | — (in the node reads) | 229 / 543 |
| bytes read for the answer | 1.77 + 3.43 MB | 1.79 + 4.45 MB |
| fold time alone, one-line edit | 169 / 195 ms | 106–175 / 134–232 ms |
| cold fold alone (scan module new) | 3.4 s (plugin-boundaries) | 2.8 s (scan 2.5 s, dirs 0.2 s) |

The limit trades reads against the write bound: at 32 KB the answer is read as
1,016 / 2,020 value records, at 512 KB 65 / 289; 256 KB keeps both near the
old shape while bounding an edit's write to the limit per whole ancestor (the
largest seen: `checks/core`, 291 KB raw / 38 KB zstd).

Whole pass, the same answer-changing edit (`--scope tree`): fold writes
676 KB → 8.1 KB zstd; no fold is among the check thread's top-10 owners before
or after (top: `parsedTsSource` ~3.6–4.1 s, `platformOffenders` ~2.2–2.6 s,
semaphore ~2.5–3.1 s, source-analysis ~1.6–1.8 s, sql-writes ~1.2 s);
51 s → 31 s grant to verdict, noise-bound (load 17–25).

### What is still O(answer)

The **read**: every pass materializes the whole answer for its verdict (the
R6 graph, every barrel's names), 1.8 + 4.5 MB from ~770 records. Writes no
longer grow with it, and its cost is ~0.1–0.2 s per check; making it
O(changes) means not running the verdict when the root's ref did not move —
a read-set fact on the fold's root ref (validated by the O(changes) walk,
which already answers it) in place of a content fact per folded file. Not
done here: the read-set's other facts (the plugin tree's and the standard-dir
scan's content reads) would have to be recorded precisely first.

### Next

The shared parse behind the sourceAnalysis checks (no-db-backed-notify,
sql-writes:fit: `parsedTsSource` is the thread's top owner, ~3.6–4.9 s per
one-line-edit pass).

## The shared parse behind the cross-file checks (task: check pass O(changes), 6)

Measured 2026-11-12, same one-line edit (a comment appended to
`hints/help-menu/web/index.ts`), `./equin check --scope tree` after a warm pass
of the same code; standalone probes (temporary, reverted) counted parses.

### Split before

- **no-db-backed-notify: 3,603 parses**, 2,058 of them in the `usesOf` that only
  looks for `ExcludeFromChangeFeed`. Two causes in source-analysis's `usesOf`:
  - its selection added `\* as ` to every query: 409 files, of which 33
    namespace-import a repo module — the rest npm namespaces (`* as React`) and
    JSDoc lines opening with "as";
  - each candidate's EVERY import (and every export) was resolved to ask
    whether it names a target, parsing every module a candidate imports.
  The rest is the question itself: the ~450 files that spell a serve function,
  and the code an external loader reaches (~970 files).
- **sql-writes:fit: 2,604 parses** — every file its word prefilter passes
  (`insert|update|delete|create…`), on every pass; 56 hold a site, and the hole
  resolution reads 11 other files.

### Fix

- **`usesOf` parses only what can name a target.** A file is a candidate when
  it spells a known name or namespace-imports a REPO module (`* as x from
  "./…"|"@plugins/…"`, or a `* as` ending its line — the old selection missed a
  namespace import split across lines); an import or re-export is followed only
  for the names it takes that are known spellings (a whole-module form for all
  of them), and only an export whose source name is known (or a namespace) is
  resolved in the fixpoint. A rename spells the name it renames, so its file is
  selected by it and the fixpoint finds the alias in the next round.
  Equivalence: no-db-backed-notify's offenders, unreadable spots and feed
  exclusions are byte-identical on the real tree (exemptions off), and so are
  `live:*` and `investigate:failures-registered`; a unit test pins rename
  chains, local re-exports of an import, a re-exported namespace import and a
  split namespace import.
- **no-db-backed-notify is input-keyed.** Its question is cross-file (where a
  serve call's reachable code reads the DB), so it does not fold per file; but
  every byte it reads goes through `ctx.repo()` and `listCandidateSources`,
  both recorded. An edit to a file it never read replays the read-set; one it
  read (or one that moves a selection) re-runs it. The TypeScript version is
  its signature; `plugin-id/` joins the check-source hash (its verdict calls
  `pluginDirOfRepoPath` / `isTestCodePath`).
- **sql-writes:fit folds its sites** (`sites.scan.ts`, `foldRepoFiles`): a
  file's sites and markers from its own bytes; a hole whose value another file
  decides is recorded deferred and followed afterwards (`resolve.ts`, through
  the run's source analysis — module resolution over the run's file set, no
  `ts.sys` reads). Equivalence: the check's whole result on the real tree
  (164 write sites, 22 fit issues, 41 hand-written writes) is byte-identical.

| one-line edit, in a full pass | before | after |
| --- | ---: | ---: |
| parses, no-db-backed-notify | 3,603 | 0 (read-set hit; 1,502 when it re-runs) |
| parses, sql-writes:fit | 2,604 | the edited file if it passes the prefilter, + ≤ 11 to resolve holes |
| files read, no-db-backed-notify | 3,110 | 10 (replay) |
| files read, sql-writes:fit | 14,003 | 349 |
| duration, no-db-backed-notify / sql-writes:fit | 25.0 s / 16.2 s | 2.4 s / 17.5 s |
| check-thread samples: `parsedTsSource` + the two checks + source-analysis | 742 of 3,538 (21%) | none in the top 10 (each < 66 of 2,723) |
| check-thread samples, whole run | 3,538 | 2,723 |
| files read by check bodies | 222.4k | 205.9k |
| grant → verdict | 31.3 s (load 10–12) | 51.0 s (load 3–8) |

The wall time is noise-bound and set by other checks: after, `layout-geometry`
(a browser check) ran 41.6 s and every other check ended by 24.7 s; before, the
last ended at 30.1 s. sql-writes:fit's own duration is its schema probe (a
subprocess importing every schema file) and libpg_query, not its parse.

Cold: sql-writes:fit's first fold (scan module new) 25.0 s / 14,012 reads,
once, against 16.2 s / 14,003 reads on every pass before; standalone, 6.3 s vs
10.0 s. no-db-backed-notify on a read-set miss: 20.5 s / 1,253 reads (vs 25.0 s
/ 3,110 every pass).

What an edit writes to the shared store (sql-writes' fold): a node record per
directory on the edited path; values only when the edited file's sites change.
The whole answer is 82 KB of JSON (194 sites, 50 holes deferred) — under the
256 KB inline limit, so an edit that changes a file's sites writes at most one
value per ancestor directory, each at most that; a file with no site is a
35-byte value shared by every such file.

### What is still O(answer) or O(read-set)

- no-db-backed-notify re-runs whole (~1.5k parses) when any file it read
  changes. Folding it needs per-file summaries of the binding graph its walk
  follows (each declaration's references, `db` uses, serve calls' options,
  wrapper parameters) and the walk over summaries — a rewrite of the analysis.
- sql-writes:fit reads its folded answer (82 KB) and resolves its 50 deferred
  holes (~11 parses) every pass.

### Next

Making an unbounded whole-tree read in a check's `run()` a declared, visible
property, and migrating its readers (theme-bridge-reads,
negated-complex-selector / script-state:no-stylesheet-reads,
pre-barrel-manifests-complete, boot:closure-digestable, plugins-doc-in-sync).

## The critical path of a one-line-edit pass (task: check pass O(changes), 7)

Measured 2026-11-12, same one-line edit (a comment appended to
`hints/help-menu/web/index.ts`), `./equin check --scope tree` after a warm
pass of the same code; split from the run's `check-progress.jsonl` records
and its op-log entry.

### Split before (host load 8–12)

| part | wall |
| --- | ---: |
| host CPU grant wait (memory window, other agents' ops) | 29.7 s |
| every check but one, grant → last end | 25.8 s |
| `layout-geometry` alone past that (it ran 43.6 s) | +26.6 s |
| **command, end to end** | **84.0 s** (runner 52.4 s) |

The grant wait is the host's, not the pass's (0.1 s on the next run). Of the
pass's own 52.4 s, half was one check: `layout-geometry` launched its Chromium
suite (Vite build + measuring every exhibit, ~37–44 s) on an edit to a file no
measured exhibit loads. In the progress log it launched in 3 of 35 recent
passes, each time setting the pass's end.

Root cause: its key was a guess at the page's inputs — the css subtree plus
**every exhibit contributor's whole plugin subtree** — and the check was keyed
on the whole tree (re-run, 1.2k reads and a hash, on every edit). `hints`
contributes an *app* exhibit (never measured, never loaded by the page), so
all of `hints/**` was keyed; and a primitive a measured exhibit imports from
another plugin (`primitives/dom`, `network/live`, `ui/icons`) was not keyed at
all — over- and under-invalidating at once.

### Fix

The key is the page's code, read from the code
(`layout-harness/check/page-inputs.ts`): the static import closure of the
harness plugin (the suite, page entry, the Vite build script it spawns by
path, the oracle) and of every `exhibits/index.ts` the generated registry
loads, plus the stylesheet chain (`@import`/`@reference`/`@plugin`/`@config`)
and `bun.lock` for packages. An app exhibit's `load()` (a dynamic import the
page never calls) and Tailwind's `@source` scan (a class spelled only outside
the closure is on no measured box) are not followed; the check's own files are
keyed by bytes, not imports. Every byte goes through `ctx.repo()`, and the
check is now `inputKeyed`: the closure is its read-set, so an edit outside it
replays and runs nothing. An import the walk cannot place throws.

Equivalence: Vite's own module graph of the page (a build with a probe
plugin, reverted) loads 742 repo modules statically from the entry and the
exhibit barrels — all 742 are in the closure (862 files; the rest is the
suite's Node side and the lockfile). Verified: an edit to `help-menu` replays
(1.8 s for the whole command); an edit to `css/text/web/index.ts` re-runs the
suite.

| one-line edit (help-menu) | before | after |
| --- | ---: | ---: |
| layout-geometry: duration / reads | 43.6 s / 1,204 | 6 ms / 2 (read-set replay) |
| layout-geometry steady state (closure unchanged): reads | 1,182 + a hash every pass | 0 (replay) |
| key computation when it does run | ~1.2k reads + sha256 | 862 reads + imports scanned, 0.25 s |
| runner, grant → verdict | 52.4 s (load 8–12) | 23.7 s (load 13) |
| command, end to end | 84.0 s (29.7 s grant wait) | 26.5 s (0.1 s grant wait) |
| check-thread samples | 2,974 at 73 Hz | 2,754 at 92 Hz |
| files read by check bodies | 215.5k | 202.7k |
| bytes written to the plugin-records store by it | 0 | 0 (its read-set lives in the check cache, rewritten only when it runs) |

Cold: a closure change costs the walk (0.25 s) plus the suite once per closure
digest host-wide (36.5 s here), as before; a peer worktree with the same
closure reuses the marker.

### Next

The pass now ends when ~20 checks end together at ~22–25 s
(`boundaries:web-loads-portable`, `config-v2:registrations-paired`,
`plugins-registry-in-sync`, `page.editor:*` reading one file each): they wait
on the same shared inputs (barrel evaluation, registry codegen;
`platformOffenders` ~2.8 s and the semaphore ~2.5 s are the check thread's top
owners). sql-writes:fit spends ~16.5 s per pass in its schema probe. Then the
declared whole-tree read.

## The cluster is CPU, not a shared wait (task: check pass O(changes), 8)

Measured 2026-11-12/13, same one-line edit (a comment appended to
`hints/help-menu/web/index.ts`), `./equin check --scope tree`.

### Split

- **The pass is CPU-bound, and the CPU is in the check process.** One
  unbounded pass after the edit: 25.6 s wall at load 12, **177 CPU-s** (92 user
  + 85 sys, 627%). A process-tree sample put 117 CPU-s in the check process
  itself (its threads: `Bun.build`'s parser pool, the fs pool, record readers)
  and only a few in subprocesses (each schema probe ~0.6 CPU-s).
- **Why ~20 checks end together.** The `page.editor:*` checks read 0–32 files
  and take 2–3 ms in a serial pass, yet 16 s in the unbounded one: they wait
  on `buildEnrichedTree` (6 s alone, ~3.3 s with nothing changed: the
  barrel-free tree 1.4 s, evaluation 1.1 s, the enriched tree 0.7 s; an edited
  web barrel misses its evaluated record, +2–4 s of live import), and that
  shared input finishes when the host gives it CPU. With every check started
  at once, every one ends when the pass's total work drains: the tail is the
  pass's CPU, not one input. `sql-writes:fit`'s "16.5 s" was the same thing:
  0.39 s in a serial pass, its probe 1.2 s alone at load 4.
- **Who spends the CPU** — per-check process CPU (`process.cpuUsage()` around
  each check in a `--jobs 1` pass; a temporary instrument, not committed):
  93 CPU-s in all, the top being whole-closure `Bun.build`s run on every pass
  whatever was edited:

| check (serial, help-menu edit) | CPU-s | why |
| --- | ---: | --- |
| boot:closure-digestable | 13.9 | `importClosures` (follow) of the 5.8k-module backend closure, + every module read |
| cli:codegen-manifests-not-frozen | 11.4 | ~20 `importClosure`s (startup + each command body), reads `live` |
| boot:closure-no-dev-tooling | 8.0 | `importClosures` (cut) of the same closure |
| snapshot-chain-intact | 7.1 | migrations data, a subprocess |
| theme-bridge-reads | 4.6 | 16.7k reads |
| active-data:document-chip-has-server-token | 4.3 | first to ask the enriched tree |
| boundaries:machine-portable-declaration | 3.9 | one `importClosure` per declaring module |
| pre-barrel-manifests-complete | 3.7 | 13k reads |
| boundaries:web-loads-portable | 2.6 | `importClosures` over ~800 entries + every module read |

`platformOffenders` (the check thread's top owner, ~3.4 s) was the
machine-portable one re-reading and re-parsing each closure module per pass.

### Fix

The import-closure readers that need modules, edges, chains and externals —
not `live` — read them off the plugin-records module graph, whose per-module
import facts are records keyed by blob:

- **`fileSetClosure`** (plugin-records core): the bundler's closure over a
  file set, one graph per set, an unresolved import loud — the three copies
  (codegen's browser host, server portability, now the checks) are one.
  `bundledClosure` takes a `followDynamic(module, spec)` predicate, and
  `external` (each module's kept bare specifiers, dynamic ones when followed),
  both derived from the facts the graph already reads: no file record re-keys.
- **`fileSetImportClosures`** (tooling/import-closure): `importClosures`' answer
  over a file set, both dynamic-import policies; a command's `run` thunk is a
  per-blob `FileScan` (`command-runs.scan.ts`, the old `scanCommandRuns`
  moved there).
- **`platformTaintOf`** (boundaries): rules 1–2 over that closure, each
  module's facts the portability file record `serverPortabilityOf` already
  kept. `platformOffenders` is gone.
- Readers moved: `boot:closure-digestable`, `boot:closure-no-dev-tooling`,
  `boundaries:web-loads-portable`, `boundaries:machine-portable-declaration`.

Equivalence, on the real tree against `Bun.build` (scratch scripts): boot
closures, cut and followed (5,768 / 5,810 modules) — identical modules, edges,
chain lengths and externals (builtins aside: a bundle's resolver never sees
them); the CLI bin followed (1,959 modules, 42 command runs cut) identical;
web-loads-portable's 791 entries — identical violations, taint and offenders;
machine-portable-declaration's 8 declaring modules — identical.

**sql-writes:fit's probe is a record** (`closureRecord`, plugin-records core,
new `closure` table): keyed by the probe script's and every schema file's
module Merkle key, the input and the npm code they import; only a success is
stored. The probe's wire format names files repo-relative (the root is its
argument). Same answer (164 write sites, 22 fit issues, 41 declared). A pass
whose edit reaches no schema closure is a lookup (0.5–1.3 s of graph walk);
a miss is the subprocess (1.2 s at load 4, 9–21 s at load 25). The "slower
cold fold" (25.0 s vs 16.2 s) is the same host contention: the scan module's
first fold ran in a pass at load 10–12; alone it was 6.3 s vs 10.0 s.

| one-line edit (help-menu), serial, per-check process CPU | before | after |
| --- | ---: | ---: |
| boot:closure-digestable | 13.9 | 1.9 |
| boot:closure-no-dev-tooling | 8.0 | 0.0 |
| boundaries:machine-portable-declaration | 3.9 | 0.2 |
| boundaries:web-loads-portable | 2.6 | 0.9 |
| **all checks** | **93.2 CPU-s** (load 10) | **60.3 CPU-s** (load 25) |
| closure walk alone, backend (cut / follow) | 8.3 s / 6.8 s | 0.44 s / 0.39 s |
| web-loads-portable taint, warm | 8.7 s | 1.6 s |
| sql-writes schema probe, edit outside every schema closure | subprocess every pass | lookup |

Bytes written to the shared store per edit: a closure record only when the
probe input or a schema closure moves (one value, the probe's ~100 KB JSON);
command-run scan records only for edited modules (a few bytes each).

Wall time under these loads (10–25) is set by contention, not by any one
input; the lever is the pass's total work.

### Next

Filed: the four other schema probes (`derived-updated-at:declared`,
`ids:pk-declared`, `table-defs-in-schema-glob`, `schema-files-loadable`) onto
`closureRecord`; the checks still `Bun.build`ing per pass
(`cli:codegen-manifests-not-frozen`, 12 CPU-s now the largest, needs `live`;
the cli bootstrap / declaration checks, guards, sentinel); then the declared
whole-tree read. Sidequests: `snapshot-chain-intact`'s ~7 CPU-s per pass,
`web-loads-portable`'s 8.5k-file import scan.

### The four other schema probes (2026-11-13)

**Before.** `derived-updated-at:declared`, `ids:pk-declared` and
`schema-files-loadable` each spawned a bun subprocess that `require()`d all
145 schema files (their static union is 1,887 modules) on every pass, whatever
the edit; each also walked the disk for the schema files (`schemaGlobFiles`,
3.6 s at load ~20). `table-defs-in-schema-glob` runs no probe; its cost was that
walk plus its git greps. Measured directly at load ~22: the three probes took
7.4 s, 4.4 s and 11.6 s; in the check log at load ~20, 1.5–3.3 s each.

**Root cause.** The answer of each probe is a function of the schema files'
code, but nothing kept it: every pass loaded the whole closure three times.

**Fix.** `database/migrations/schema-question` (`askSchemaFiles`): a check is a
question module (`answer(file, exports, input)`) and one call. One probe host
loads the files drizzle-kit's way, in one process, and answers every question
asked; each question's answer is ONE `closureRecord` keyed by the host's, the
question's and every schema file's module Merkle key. Misses of all questions
in a pass share one load (a coalescer per checkout and file set). The checks
read the schema files from `ctx.repo()` (no disk walk).

**Why the whole set, not a record per file.** Measured: of 400 main commits,
36% reach some schema file's closure, but a median of only 3 of 145 files —
per-file keys looked O(changes). They are wrong: the files share one process
(as under drizzle-kit), so module eval shares registries — two tables declaring
one derived updatedAt differently make the SECOND file to load throw. A file's
answer is a function of the whole set loaded with it (pinned by the test
"fixing one schema file re-answers another whose load it broke"). Loading each
file alone would be sound per file but costs a bun start plus ~475 shared
modules per file, and no longer sees the conflicts drizzle-kit hits.

| (load 18–28, per check, wall) | before | after |
| --- | ---: | ---: |
| edit reaching no schema file (64% of commits) | 1.5–3.3 s, a full load each | 0.5–1.4 s, a lookup (one shared graph walk) |
| edit to one schema file | 3 full loads + 4 disk walks | one shared load (1.1–1.7 s for all four checks) |
| cold (new question code) | — | 4.7–6 s, two batched loads |

### The checks still bundling every pass (2026-11-13)

**Before.** Five checks measured closures with a `Bun.build` on every pass,
whatever the edit. Per-check process CPU, serial (`--jobs 1`), load 18–30:

| check | before (CPU-s) | why |
| --- | ---: | --- |
| cli:codegen-manifests-not-frozen | 10.8–12.0 | startup + 42 command bodies (`importClosure`, follow) + 4 at-load unions |
| cli:command-declarations-light | 0.3 | one tiny `importClosure` per declaration |
| sentinel:worker-closure-lean / status-file-lean | 0.03–0.2 | tiny closures |
| cli:bootstrap-package-free, guards:bootstrap-builtins-only | ~0.01 | tiny closures |

So the cost was one check: 42 command-body bundles at 0.15–0.8 CPU-s each
(`check`'s body: 1,950 modules, 0.8 CPU-s). The `Bun.build`s were there for
`live`, the bundle's tree-shaking: a module that CALLS the manifest writer
marks its command as regenerating only when it is live. That cannot be swapped
for `modules`. Measured, `codegen`, `plugin move` and `release` load a
writer-calling module that is not live, so they would wrongly become
regenerators.

**Root cause.** The closures (modules, chains, command-run edges, at-load sets)
are facts of the module graph, and the graph already answers them per edited
module. Only the regenerators need a bundle, and each one is a function of
exactly the files its bundle parses. Nothing kept that answer, so every pass
rebuilt all 42.

**Fix.**
- Every closure is read off the module graph (`fileSetImportClosures`). It
  now also reports the `commandRuns` it cuts, equal to `Bun.build`'s on the
  real tree: 42 edges, 873 startup modules.
- Each command body's regenerators are a `closureRecord` with a new `bundled`
  part. The key holds every module the bundle parses (path, blob and
  out-edges, not the modules behind a cut `import()`) and the producer's own
  code (its Merkle key). A miss asserts that the build parsed exactly the
  graph's closure, so the record cannot stand for an answer its key did not
  cover. Tests pin the key: an edit inside the closure, an edit to the
  producer, and a specifier that comes to resolve to another file each answer
  again, while an edit behind a cut `import()` does not. Removing `bundled`
  from the key fails all three manifest-freeze record tests.
- The other four checks read the graph (builtins filtered from `external`,
  which a bundle's resolver never reported).
- `followDynamic` scans only the modules that have a repo `import()` for run
  thunks, not the whole reach. That brought 42 warm body closures from 1.8 to
  0.3 CPU-s, with the same answer.
- The graph's import scan read a hashbang entry (`guards/bin/guard.ts`) as a
  syntax error. It now skips the `#!` line, as the runtime and the bundler do.

| cli:codegen-manifests-not-frozen, serial | before | after |
| --- | ---: | ---: |
| one-line help-menu web edit | 11.5 CPU-s | 0.84 CPU-s (0 bundles) |
| same tree again | 11.5 | 1.2–1.5 |
| edit to a module every command loads (`plugin-id/core`) | 11.5 | 9.6 (all 42 bundled) |
| cold (new producer code) | 11.5 | 8–11 |

Of the last 400 main commits, 53% reach no command body (0 bundles). The mean
is 7.9 of 42 bodies, and p90 is 36. Expected cost per commit is about
2 CPU-s plus about 1 CPU-s of graph walks.

**Review follow-up.** The record is only as sound as the graph's resolution.
Two gaps in it were fixed:
- The graph tried `.ts` before `.tsx`. Bun, at runtime and in its bundler,
  tries `.tsx .jsx .ts .mjs .js .cjs .json`, so adding `a.tsx` beside `a.ts`
  would have left a stale record. The order is now Bun's, pinned by
  `module-graph.bun.test.ts` against a real `Bun.build` for every sibling pair.
- Bun resolves a directory through its `package.json` before `index.*`. The
  graph now refuses such an import instead of guessing.

`tsconfig.base.json` (aliases, compiler options) is in each record's input. An
alias the graph treats as npm but Bun resolves into the repo makes the build
parse modules the graph did not list, so the miss-path assertion throws.

Not keyed: a `sideEffects` field in a repo `package.json`. No repo
`package.json` has one today.

## A check's own O(tree) work is declared (task: check pass O(changes), 9)

Measured 2026-11-13, the same one-line edit (a comment appended to
`hints/help-menu/web/index.ts`), `./equin check --scope tree --jobs 1`
after a warm pass of the same code, read from `check-progress.jsonl`.

### Split before

The pass's check bodies made 168.4k file calls. The top was checks that
read every file of a kind whatever changed: theme-bridge-reads 16.9k,
negated-complex-selector and script-state:no-stylesheet-reads 14.1k each
(the same files), plugins-doc-in-sync 20.6k (stats), boot:closure-digestable
19.7k. And the per-check counts were not the checks' own: a per-pass memo
(the plugin tree, the codegen trees, the registry context) was charged to
whichever check reached it first — config-v2:registrations-paired read 13.1k
in one pass and 5.4k in another, the difference being the enriched tree.

**Root cause.** Whether a check costs O(changes) or O(tree) was nowhere in
its declaration: a `run()` that lists `under("plugins")` and reads every
member looks the same as one that reads one file, and the only signal (the
`fs` count on each `end` record) was polluted by shared work, so it could
not be judged on.

### Fix

- **Shared work is nobody's own.** `packages/shared-work`'s
  `sharedWork(name, fn)` (portable: `core/` code marks its memos with it;
  `packages/timed-fs` installs itself as its scope) counts `fn`'s file calls
  into a named shared tally and into no enclosing scope. Every per-pass memo a check reaches (plugin
  tree, barrel-free / enriched trees, evaluated barrels, slot naming, the
  registry codegen context and its inner memos, the source analysis, the
  runner's exemption and code-key loads) and every plugin-records producer
  (the module graph, a fold's or file scan's read on a snapshot, the npm
  identity) runs under it. The run's `done` record carries `sharedFs` by
  name, so shared O(tree) work stays visible as its own line.
- **The declaration.** `Check.wholeTreeRead` (`{ kind: "debt", task,
  reason }` or `{ kind: "sanctioned", reason }`). The runner meters each
  body's own calls (`checks/core/whole-tree-read.ts`) and fails a check over
  `WHOLE_TREE_FILE_CALLS` (1,000) that does not declare it, and one that
  declares it but stays under on a passing run. `./equin check --list`
  prints the declarations. An O(tree) body now has no silent spelling.
- **Migrated** the three largest readers to folds (`defineFoldCheck`, each
  input-keyed): theme-bridge-reads (a file's bridges and `var(--color-*)`
  reads; the verdict matches them across files), negated-complex-selector
  (per file), script-state:no-stylesheet-reads (two folds: the declared
  attributes, themselves a fold over runtime sources, are the context of the
  reads fold, so declaring one re-judges every stylesheet and nothing else
  does). Equivalence: an injected fixture of each violation shape reports the
  same lines under the old and new code. Pinned by `script-state/check/
  folds.test.ts`: a stylesheet whose bytes did not move is re-judged when
  another file declares the attribute it reads.
- **Declared** the 26 remaining checks over the bound as debt on
  task-1794579727-rjy6wx (largest: plugins-doc-in-sync 20.6k stats,
  boot:closure-digestable 19.3k, config-v2:registrations-paired and
  companions-visible 5.4k stats each, composition-closure 4.6k; six checks
  each read every package.json, 1.8k; three each read every barrel, 2.0k;
  no-db-backed-notify 1.3k — input-keyed, its own source analysis is its
  own work, not shared).

| one-line edit, serial, whole pass | before | after |
| --- | ---: | ---: |
| wall, start to verdict | 54.0 s (load 16–18) | 37.0 s (load 5–10) |
| process CPU (user + sys) | 37.9 s | 25.0 s |
| file calls by check bodies | 168.4k | 104.0k (+ 19.5k shared, counted once) |
| theme-bridge-reads: own calls / wall | 16,891 / 362 ms | 3 / 39 ms |
| negated-complex-selector | 14,135 / 196 ms | 3 / 37 ms |
| script-state:no-stylesheet-reads | 14,135 / 341 ms | 3 / 46 ms |

The wall and CPU rows ran at different host loads; the call counts do not
depend on load.

Cold (each scan module edited, so every record misses; the three alone,
serial, load ~5): 473 / 534 / 588 ms, the folds reading 53.9k files through
plugin records (`sharedFs`) — each file once per fold, about what the old
bodies read on EVERY pass (45.1k, 196–362 ms at load 16–18). That cost is now
paid once per scan-module change, host-wide; an edit pays its own files.

**Is the count a function of the tree?** Checks run alone in a fresh process
(first to every memo) against the same checks inside a pass: composition-closure
4,584 / 4,584, plugin-boundaries 2,340 / 2,340, release:fixed-entrypoints-bundle
2,002 / 2,002, no-reexport-default 1,964 / 1,964, config-v2:registrations-paired
5,439 / 5,433 — six calls of some small unwrapped memo, far from the bound.
A memo added later without `sharedWork` charges the first check to
reach it; if that pushes a check over the bound it fails naming the
prefixes the calls went to.

### Next

task-1794579727-rjy6wx: the 25 declared checks by cost.

## The declared whole-tree reads, by shared cause (task: check pass O(changes), 10)

Measured 2026-11-13: the same one-line edit, the 26 declared checks run serially
(`--jobs 1`). Own calls were attributed to call sites by a temporary stack probe
in `timed-fs`'s tally (reverted).

### Split before

Most of the ~117k own file calls came from a few inputs that several checks
each paid for:

| cause | own calls | checks paying |
| --- | ---: | --- |
| `discoverCollectedDirsIn` read every candidate `core/*.ts` | 2,005 each | cli manifest-freeze, release, plugin-boundaries, registry-in-sync, pre-barrel |
| an existence stat per plugin that the run's file set already answers | 20k (docgen's test-helper probe), 5.4k, 5.4k, 1.8k, 1.8k | plugins-doc-in-sync, registrations-paired, companions-visible, facets, plugins-have-claudemd |
| every package.json read | 1.8k each | the four `deps-npm:*`, no-plugin-workspace-deps |
| every exemption manifest re-read to record it | 338 each | every check asking `ctx.exempt` |
| `readDeclaredApps` stat + listing + read of every plugin's `core/` | 4.6k (and 2.6k more in the shared registry context) | composition-closure |
| every reached module read for `defineHostService` | 1.2k | registry-in-sync (the static host graph) |
| every git worktree's admin files read to find main's root | 1.4k | fork-schema-drift |
| per-file rules re-run over every file of a kind | 1.5k–2.8k | portable-own-barrels, no-reexport-default, test-layout, CLAUDE.md conflict markers |
| a closure record's miss computed in the caller's scope | up to 3k | cli manifest-freeze (the count depended on what the store held) |

### Fix

- Per-file work is a plugin record. Folds: collected-dir markers, package.json
  manifests, declared apps, CLAUDE.md conflict markers, deep own-folder
  imports, barrel default exports, test-runner offenses. File scans: host-service
  declarations, computed loads. Each fold sits in a `*.scan.ts` whose closure is
  narrow: `computedLoads` moved to a leaf plugin
  (`source-digest/computed-loads`) because importing the digest's server barrel
  keyed its records by 387 modules (`plugin-records:scan-key-width`).
- Membership comes from the run's file set (`repo.has`), never `existsSync`.
  Config origins are compared by blob id (`gitBlobId(expected)` against
  `repo.blobOf`), so they are never read.
- Declared apps are read once into `RegistryGenContext.declaredApps`. Home and
  unlisted resolution take that map.
- `closureRecord` computes a miss under `sharedWork`, so a check's own count no
  longer depends on what the store held.
- `ensureMainWorktreeRoot` is `dirname` of the common git dir.

Not done: storing source-digest's `closureRefusal` walk as a record. It resolves
against `node_modules` and `tsconfig.base.json` on disk, which no record key
covers, and its refusal names absolute paths. An earlier version of this change
recorded it; review caught it, and it was reverted.

| one-line edit, serial, the 26 checks | before | after |
| --- | ---: | ---: |
| own file calls, summed | ~117k | ~4.6k (~18k with boot's disk walk) |
| checks at ≤7 own calls | 0 | 21 |
| shared "registry codegen context" | 8.6k | 1.3k |
| boot:closure-digestable | 31.4k calls / 605 ms | ~13.4k (the walk) |
| pass wall, start → verdict (load ~5) | 9.9 s | 6.7 s (before the boot revert) |

Tests pin that each stored part re-answers after an edit to what it read
(`discover.records.test.ts`, `workspace.records.test.ts`,
`declared-apps.test.ts`), over the real checkout with fixtures laid in by
`plugin-records/core/testing`'s `overlaySnapshot`.

### Next

task-1794583359-1cuyg0: boot's walk (13.4k), plugins-doc-in-sync (2.8k
CLAUDE.md/REFERENCE.md reads, ~400 ms of rendering), migration-phases-valid
(1.0k, every migration read twice) and no-db-backed-notify (~940, input-keyed).
