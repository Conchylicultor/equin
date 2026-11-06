# Change-feed trigger install on a fresh database: where the 22 s went

task-1793932779-i11s7u. Track: "apps running in the browser" (page block-d04c6c0d-…).

## Context

On a fresh PGlite database, `onReadyBlocking:network.live.change-feed` took ~22 s of
a 29 s /demo boot, and 13–33 s of every demo snapshot take (which main now re-takes
on ~25 commits a day). On a database that already has the triggers it is ~0.75 s.

## Decomposition (snapshot take, loaded host — load avg ~37, 192 tables, 576 triggers)

| Part | Calls | Time |
| --- | --- | --- |
| `installDbTriggers` total | 1 | 31.0 s |
| ├ `readCatalog` | 197 | **24.4 s** |
| ├ `plan` (JS) | 197 | 2.2 s |
| ├ `applyTable` (the real DDL: 3 × CREATE TRIGGER + def read + COMMENT) | 192 | 3.0 s |
| └ BEGIN / advisory lock / COMMIT | 192 | ~1 s |
| enumerate tables (`singleColumnPk` per table, `tableColumns` per routed table) | ~250 queries | 1.6 s |
| coverage check | 1 | 0.1 s |

**Why.** `commit: "per-table"` runs each table in its own transaction and re-plans
under the advisory lock. The re-plan read the WHOLE set's catalog: every trigger
already installed, with `md5(pg_get_triggerdef)` and its comment. That is O(tables²)
catalog work, ~124 ms a read in PGlite's WASM. It was not PGlite's per-commit sync,
and not the trigger DDL. The steady state skips the per-table loop entirely, which
is why it costs 0.75 s.

## Outcome

**The catalog half landed separately while this ran**: 64e94ee042
(task-1793985491-3r9po8, research/2026-11-06-global-build-pipeline-step9-fresh-boot-and-snapshot-key.md)
re-plans each table from that table's triggers alone (`readTableCatalog`) and joins
comments from `pg_description`. This branch had the same fix (a scoped catalog read);
it was dropped in favour of main's. Measured here before that landed, same loaded
host, back to back:

| | Before | Scoped re-plan |
| --- | --- | --- |
| PGlite install, 192 tables | 31.0 s (catalog 24.4 s) | 5.2 s (catalog 1.45 s, DDL 2.8 s) |
| Desktop Postgres, fresh install, 192 tables | 3.0–3.5 s | 0.4–0.8 s |
| Desktop Postgres, steady state | 80–100 ms | 40–60 ms |

**This branch adds the other "a query per table" in the same stage**: the feed's
enumeration asked the catalog for each table's primary key (and each routed table's
columns) one query at a time, ~250 round trips. That is now one PK query and one
columns query (`singleColumnPks`, `tablesColumns` in `change-feed/server/internal/triggers.ts`).
A routed table missing from the column read throws. It means the table was dropped
mid-install; the old per-table `::regclass` cast threw for the same case.

| On top of main (loaded host, load ~25) | main | + one-query enumeration |
| --- | --- | --- |
| enumeration | 0.5–1.7 s | 16–21 ms |
| `onReadyBlocking:network.live.change-feed` in a snapshot take | 3.3–3.9 s | 1.3–2.8 s |

The host was never idle during this session (load 17–44), so absolute numbers move
with it. A visitor's first /demo boot loads the snapshot, which already has the
triggers, so it does not pay this install. A client-only app with no snapshot pays the
fresh-PGlite figure.

What is left of a fresh take is the real work: ~576 `CREATE TRIGGER` + definition
read + `COMMENT`, and the migration replay (`onReadyBlocking:database`, now the
biggest stage).

Tests: `db-triggers-install.test.ts` gains a per-table case over a quoted, mixed-case
table. Its triggers are re-planned from its own catalog and a stale one is dropped,
which exercises `splitTableKey`. Demo e2e: snapshot 28, persistence 38, no-leak 46,
app-switch 28, places 31, desktop 22, prototypes 27, sonata 41, keyboard-party 35,
all passing. Pre-existing and unrelated: `schema-layer-replay.test.ts` fails on main
too (rollup result order).
