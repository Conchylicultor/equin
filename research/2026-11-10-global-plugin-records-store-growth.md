# The plugin-records store grew 6.7 GB in six days: every new plugin re-keyed every record

Task: task-1794321210 (found by the closing re-measure, task-1794319850-v6eeoj).

## Symptom

`~/.equin/cache/plugin-records/records.v2.sqlite` was 6.7 GB on 2026-11-10,
about six days after the file was created (`used` days 20762–20767), and
gained ~4.7M keys a day. D8 (`research/2026-11-05-global-check-passes-read-shared-plugin-records.md`)
had said 140 MB. That figure was not a rate: it measured the fresh v2 file on
the day it was made, which held about one set of records (559k key rows, 34k
values). The daily reclaim deleted 0 rows, which is correct because nothing
was 7 days old yet.

## What the store holds (measured, read-only, 2026-11-10)

| table | key rows | distinct values |
| --- | ---: | ---: |
| file | 11,324,802 | 53,677 |
| facet | 2,732,866 | 6,517 |
| module | 2,641,074 | 48 |
| group | 1,669,175 | 419,603 |
| evaluated | 555,060 | 2,483 |
| verdict | 385 | 1 |

That is 19M key rows for 482k distinct values (2.5 GB of value text, of
which **2.37 GB is group values**: file 103 MB, evaluated 52 MB, facet 12 MB). The
rest of the file is key rows and the `keys_vid` index, about 160 B per row. So
**the keys move while the values don't**: the file table holds about 210 keys
per distinct value.

## Why the keys move: the lockfile blob was in every key

Every producer folded in `bun.lock`'s git blob as "the npm code it can run":
file facts (`fileFactsIdentity`), every file scan (`scannerIdentity`), every
facet (`facetIdentities`), the evaluator (`evaluateBarrels`) and the drizzle
verdict. Adding a plugin writes its workspace stanza into `bun.lock`, so
**every new plugin re-keyed every record of every producer**, and every
worktree whose lockfile differs (its own new plugin, or a different main
base) wrote a whole new set.

Measured over main's 484 commits since 2026-11-04 (`git log -- bun.lock`, each
version parsed, npm entries compared):

- `bun.lock` changed in **64** commits; **61 were workspace-only** (no npm
  entry moved). The other 3 were the weekly deps upgrade and two single
  additions.
- The producers' own code closures (`scripts/key-closures.ts --commits 484`):
  file-facts scan (`scan-imports.ts`) **0**, the seven `*.scan.ts` 11–18 each,
  the facet harness 13, the evaluator 88.

So for the largest table (file facts plus scans, 11.3M rows) the lockfile
caused almost every re-key; file facts would otherwise never have re-keyed.
Groups follow their members: a group key is made of member keys, and its
value lists the member values in member-key order. So a re-key also mints new
group keys and new group values, which explains the 420k distinct group
values. Because a group value follows its member keys' order, value
content-addressing cannot dedupe it across epochs, so each lockfile epoch
re-stored a plugin-grouped copy of every value: that is the 2.37 GB.

## Fix

The npm part of every key is now `npmResolutionsKey(set)`: sha256 of
`lockfileNpmResolutions(bun.lock)`, which is the lockfile minus its workspaces
section and every `@workspace:` line. That is the same text type-check and the
browser host snapshot already key on (they measured the same 37/37
workspace-only edits a week). It is memoized per file set and used by all five
producers. `lockfileNpmResolutions` moved to a no-import leaf
(`infra/deps/npm/lock-resolutions`), so the evaluator's Merkle closure gains
one module and not the npm barrel's.

An npm change (version, integrity, override, patch) still re-keys every
record. That over-invalidates; it never serves a stale key. Workspace links are
not npm code a producer can load: the boundary rules forbid importing a
workspace name, and `--verify-records` (daily on main) catches any escape.

Test: `module-graph.test.ts` asserts that a plugin added to `bun.lock` writes
no file record, and that an npm bump re-keys every one.

## Expected effect

Re-keys of every record in a set drop from 64 to 3 over the same 484 commits.
What remains is each producer's own code moving (a scan's own files only; the
evaluator's 88 commits, see below) plus real file changes, which is
O(changes). The existing 6.7 GB stays until the rows go unread for 7 days,
after which the daily reclaim deletes them (the file was created with
`auto_vacuum = INCREMENTAL`, so the pages are returned). The switch itself
re-keys once.

## Left, proposed

- **Evaluator / module records** (3.2M rows, 48 distinct module values): the
  evaluator's key covers 346 modules (`evaluate.ts` + `barrel-import`) and
  moved in 88 of 484 commits. That is the next re-key source. Narrow it with
  `key-width` as was done for scans and facets.
- **Per-producer npm closure** (`lockfileNpmClosure`, which exists in
  `infra/deps/npm`): would make an npm upgrade re-key only the producers that
  load the bumped package. The module graph does not record bare specifiers
  yet.
- **Retention** is unchanged (7 days). Not touched without the user's OK.
