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
  sidequest.
- **file records**: 1.25M new keys a day for ~40–54k distinct values: every
  move of a scan's own closure re-keys every file's record for that scan.
  Filed as a sidequest.
- **retention** (7 days) is the user's call: halving it halves the steady
  state, at the cost of a cold rebuild of the records for a worktree idle that
  long.
