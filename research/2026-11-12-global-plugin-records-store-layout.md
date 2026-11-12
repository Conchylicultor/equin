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
