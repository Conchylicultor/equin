# Migration metadata consistency check (journal ↔ sql ↔ snapshot)

## Context

The drizzle migration store under `plugins/database/plugins/migrations/data/` is three
parallel families of files keyed by the same `<tag>` (`<YYYYMMDD>_<HHMMSS>_<sha8>__<slug>`):

- `data/<tag>.sql` — the migration body
- `data/meta/_journal.json` — one `entries[]` row per applied migration (`{ tag, hash, when, … }`)
- `data/meta/<tag>_snapshot.json` — the drizzle schema snapshot (schema migrations only)

Nothing in `./equin check` asserts these three families cross-reference each other.
The closest checks each look at only one slice:

- `migrations-in-sync` flags **orphan `.sql` files with no journal entry** (the sql→journal
  direction only) and then checks that `drizzle-kit generate` is a no-op vs `schema.ts`. It
  **never reads `meta/*_snapshot.json`** and never checks journal→sql.
- `snapshot-chain-intact` walks snapshot `id`/`prevId` links and asserts a single linear chain.
  It reasons purely over the snapshot **id-graph** — it never maps a snapshot **filename** back
  to a journal entry or `.sql`.
- `migration-hashes-unique` groups `.sql` filenames by `sha8`.
- `data-migration-dml-only` checks that snapshot-less `.sql` files contain only DML.

This leaves a gap that lets orphaned migration metadata land silently. Two concrete instances:

1. A journal entry left behind after its `.sql` + snapshot were deleted (a normal `build` does
   not regenerate the journal — only `--reset-migration`/rename does), so it is only caught by
   manual inspection.
2. A **pre-existing orphan snapshot**:
   `data/meta/20260503_181726_6917477c__remove_improve_pending_queue_top_snapshot.json`.
   It has **no `.sql` and no journal entry** (the real, journal-backed migration for hash
   `6917477c` is the re-timestamped `20260503_223547_…` one). Crucially, the orphan is still a
   **valid, reachable link in the snapshot chain**:
   `…f5749cd1 (id 33d99909) → [orphan b89e136c, prev 33d99909] → a0e4e8e1 (id 81c2be6e, prev b89e136c) → real 223547 …`
   so `snapshot-chain-intact` sees an intact single chain and passes — the orphan is undetected.

**Goal:** a check that asserts the three artifact families are mutually consistent (both
directions where an invariant exists), closing this class of fault and making hand-editing
migration metadata safe.

## Design

New check **`migration-metadata-consistent`** — a self-contained sub-plugin under the checks
umbrella, auto-discovered (no registry edit). It is a pure function of the working tree
(reads `_journal.json` + two `readdirSync` listings, no git/DB/drizzle), so it uses the default
tree-hash caching (no `cacheSignature`).

Let:
- `J` = set of `entries[].tag` from `meta/_journal.json`
- `S` = set of `<tag>` from `data/*.sql` (strip `.sql`)
- `N` = set of `<tag>` from `data/meta/*_snapshot.json` (strip `_snapshot.json`)

Assert:

1. **`J === S`** — every journal entry has a backing `.sql` (catches instance 1, the leftover
   journal entry), and every `.sql` has a journal entry (no orphan `.sql`). Report the two
   diffs separately with their own actionable hints.
2. **`N ⊆ S`** (equivalently `N ⊆ J`, since `J === S`) — every `meta/<tag>_snapshot.json` maps
   to a real migration (catches instance 2, the ghost snapshot the chain check walks through).
3. **Not** `J ⊆ N` — data/backfill migrations legitimately carry no snapshot (that contract is
   owned by `data-migration-dml-only`), so a `.sql` without a snapshot is **not** flagged.

The pure verdict logic (`classifyMigrationMetadata(J, S, N) → { orphanSql, orphanJournal,
orphanSnapshot }`) is factored out and exported for a co-located `bun:test`, mirroring
`classifyCollisions` in `migration-hashes-unique`. The impure `run()` does the `readdirSync` /
`JSON.parse` and formats `CheckResult`.

### Consolidation (chosen over additive)

The orphan-`.sql` block in `migrations-in-sync` becomes redundant once the new check owns
`J === S`. Remove it so each check owns exactly one invariant and "orphan `.sql`" has a single
source of truth. This is safe: `drizzle-kit generate` only appends and ignores a `.sql` absent
from the journal, so `migrations-in-sync` narrows cleanly to "schema.ts matches committed
migrations." (`./equin check` runs the full suite, so an orphan `.sql` is still caught —
now by `migration-metadata-consistent`, with a clearer message.)

### One-time cleanup so the check is green on landing

The current tree already satisfies `J === S` (verified: no journal-without-sql, no
sql-without-journal). Only the pre-existing **orphan snapshot** (instance 2) violates `N ⊆ J`,
so the new check would fail on landing until it is removed. Cleanup:

- Delete `data/meta/20260503_181726_6917477c__remove_improve_pending_queue_top_snapshot.json`.
- Relink the next snapshot so the chain stays intact for `snapshot-chain-intact`: in
  `data/meta/20260503_182856_a0e4e8e1__move_conv_progress_to_ext_snapshot.json`, change
  `prevId` from `b89e136c-7f9d-441b-95dc-91020c563030` (the orphan's id) to
  `33d99909-5389-4814-a0c2-780a06b57c9d` (the orphan's own `prevId`, = `f5749cd1`'s id).

Resulting chain: `…f5749cd1 → a0e4e8e1 → real 223547 → …` — intact, no ghost link. This is the
exact documented fix pattern from `migration-hashes-unique`'s hint, and is the kind of hand-edit
the new check thereafter protects.

## Files

Create (mirror `data-migration-dml-only`'s shape):

- `plugins/framework/plugins/tooling/plugins/checks/plugins/migration-metadata-consistent/check/index.ts`
  — local `Check`/`CheckResult` types (inlined, per check convention), `getRoot()` via
  `git rev-parse --show-toplevel`, exported pure `classifyMigrationMetadata`, and `run()`.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/migration-metadata-consistent/check/index.test.ts`
  — `bun:test` over the pure classifier (clean tree; orphan sql; orphan journal; orphan snapshot;
  legitimate snapshot-less data migration not flagged).
- `plugins/framework/plugins/tooling/plugins/checks/plugins/migration-metadata-consistent/package.json`
  — `{ "name": "@singularity/plugin-framework-tooling-checks-migration-metadata-consistent", "version": "0.0.1", "private": true }`.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/migration-metadata-consistent/CLAUDE.md`
  — prose describing the three-way invariant and why each existing check misses the gap
  (the autogen "Plugin reference" footer is filled by `build`).

Modify:

- `plugins/framework/plugins/tooling/plugins/checks/plugins/migrations-in-sync/check/index.ts`
  — remove the journal-load + orphan-`.sql` early-return block (and the now-unused `journalPath`
  read); keep the `drizzle-kit generate` no-op check.

Auto-regenerated by `./equin build` (do not hand-edit):
`checks/core/check.generated.ts` (new registry entry), `docs/plugins-*.md`, per-plugin CLAUDE.md
autogen blocks.

Cleanup (data):

- Delete the orphan snapshot file and relink `a0e4e8e1`'s `prevId` as above.

## Verification

1. `bun test plugins/framework/plugins/tooling/plugins/checks/plugins/migration-metadata-consistent/check/index.test.ts`
   — pure classifier covers all four cases (run after a `build`/`bun install` so `node_modules` exists).
2. `./equin build` — registers the new check (regenerates `check.generated.ts`) and refreshes docs.
3. `./equin check migration-metadata-consistent` — passes after the orphan-snapshot cleanup.
4. `./equin check` — full suite green; in particular `snapshot-chain-intact` still passes
   (chain relinked) and `migrations-in-sync` still passes (orphan logic removed, generate is a no-op).
5. Negative confirmation (transient, revert after): temporarily `rm` one `.sql` (→ orphan journal
   entry) or copy a snapshot to a bogus `<tag>_snapshot.json` (→ orphan snapshot), re-run the check,
   confirm it fails with the targeted message, then restore.
