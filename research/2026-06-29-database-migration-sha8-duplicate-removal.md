# Remove duplicate-sha8 migration & enforce sha8 uniqueness

## Context

The committed migration set contains two byte-identical SQL files that share the
same `sha8` token `2a407315`:

- `plugins/database/plugins/migrations/data/20260501_182228_2a407315__add_improve_pending_queue_top.sql`
- `plugins/database/plugins/migrations/data/20260503_222323_2a407315__add_improve_pending_queue_top.sql`

The migration runner (`plugins/database/plugins/migrations/server/internal/runner.ts`)
keys applied-state by the `sha8` (it is the PRIMARY KEY of `__singularity_migrations`).
Two files sharing a hash means the runner applies the first and skips the rest —
the from-scratch boot crash that the prerequisite commit
(`fix(migrations): tolerate duplicate sha8 hash on from-scratch migrate`) made
the runner *tolerate*, but the duplicate itself is still in the tree.

A check named `migration-hashes-unique` already exists, **but it deliberately
exempts collisions where every colliding file is tracked on `main`** (its
`trackedBasenames` logic — rationale: "frozen history with no safe fix"). Both
duplicate files are on `main`, so the exemption let this through. That rationale
is wrong for *byte-identical* duplicates: a byte-identical sibling is always
safely removable (the runner only ever applied one, the hash is already in every
deployed ledger, so deleting the redundant file is a pure runtime no-op).

**Outcome:** remove the redundant file and tighten the check so the invariant
"no two migration files share a sha8" cannot silently regress.

## How the duplicate arose (for reviewers)

This is a Y-fork remnant. The table was added May 1 (`20260501_182228`), the
snapshot chain later lost it via a merge (an abandoned/orphan "remove" snapshot
`20260503_181726_6917477c…_snapshot.json` exists with **no** `.sql` and **no**
journal entry — pre-existing, out of scope), drizzle re-emitted an identical
`CREATE TABLE IF NOT EXISTS` on May 3 (`20260503_222323`, same bytes → same
hash), and the table was finally dropped at `20260503_223547`
(`remove_improve_pending_queue_top`). The runtime is already safe; this is a
tree-cleanliness + guardrail fix.

## Part A — Remove the redundant file

Remove the **later** file (`20260503_222323`). It is the accidental re-add; the
earlier May-1 migration stays canonical, and deployed ledgers recorded
`file = 20260501_182228…` so keeping that filename on disk leaves the ledger's
`file` column consistent. Runtime effect is nil: existing DBs already hold hash
`2a407315`; from-scratch boots apply the byte-identical May-1 file instead.

Chain context (verified, full UUIDs):

```
… → 81c2be6e (20260503_182856 move_conv_progress_to_ext)
  → 56482627 (20260503_222323 add_improve_pending_queue_top)   ← DELETE
  → 3c87e516 (20260503_223547 remove_improve_pending_queue_top)  ← relink prevId
```

Four operations:

1. **Delete** `plugins/database/plugins/migrations/data/20260503_222323_2a407315__add_improve_pending_queue_top.sql`
2. **Delete** `plugins/database/plugins/migrations/data/meta/20260503_222323_2a407315__add_improve_pending_queue_top_snapshot.json`
3. **Edit** `plugins/database/plugins/migrations/data/meta/_journal.json` — remove the
   one entry object (no `idx` field; entries are array-ordered, so nothing
   renumbers):
   ```json
   { "version": "7", "when": 1777847003000,
     "tag": "20260503_222323_2a407315__add_improve_pending_queue_top",
     "hash": "2a407315", "breakpoints": true }
   ```
   (handle the surrounding comma so the array stays valid JSON)
4. **Edit** `plugins/database/plugins/migrations/data/meta/20260503_223547_6917477c__remove_improve_pending_queue_top_snapshot.json`
   — relink `prevId`:
   - from `"56482627-5f93-4f7f-9317-f9f38d0888fe"`
   - to   `"81c2be6e-47fc-4a87-a51c-5d466daaa7d0"`

Why this is safe against every relevant check:

- `snapshot-chain-intact` — purely structural (single root, no dup id, no Y-fork,
  all reachable). After the relink the chain stays linear. It does **not**
  validate SQL-vs-snapshot deltas, so the `DROP TABLE` against a no-table prev is
  fine (and no other check cross-validates that either).
- `migrations-in-sync` — sub-check A (every `.sql` has a journal entry) passes
  because we delete `.sql` + journal entry together; sub-check B diffs `schema.ts`
  against the *latest* snapshot, which is unchanged.
- `migration-applies-clean` — dry-run finds nothing pending (hash `2a407315`
  already in main's ledger and still on disk via the May-1 file).
- `migration-hashes-unique` — collision gone entirely → passes.

## Part B — Enforce the invariant (tighten `migration-hashes-unique`)

File: `plugins/framework/plugins/tooling/plugins/checks/plugins/migration-hashes-unique/check/index.ts`

Decision (confirmed): **flag byte-identical duplicates always.** Add reading of
file contents for each colliding sha8 group and classify:

```
for each sha8 group with > 1 file:
  if all files byte-identical            -> FAIL  (safely removable; this is our class)
  elif some file is branch-local         -> FAIL  (existing: rebase + --reset-migration)
  else (all tracked, differing content)  -> exempt (existing safety valve: frozen,
                                                     ~1-in-4-billion true hash collision)
```

Implementation notes:
- Keep the existing structure (`MIGRATION_RE`, `MIGRATIONS_SUBDIR`,
  `trackedBasenames`, `cacheSignature: () => null` — still git-impure).
- For each collision group, `readFileSync` each member and compare bytes; if all
  equal, it's a byte-identical group → flag unconditionally.
- Tailor the message/hint per case: byte-identical → "delete the redundant
  file(s); the runner applies the first and the hash is already in every ledger,
  so removal is a runtime no-op" (point at this plan's Part A as the procedure:
  also drop the file's `meta/*_snapshot.json`, its `_journal.json` entry, and
  relink the next snapshot's `prevId`). Keep the existing branch-local
  rebase/`--reset-migration` hint for the differing-content case.
- Update `plugins/framework/plugins/tooling/plugins/checks/plugins/migration-hashes-unique/CLAUDE.md`
  prose to describe the byte-identical-always-flag rule and the now-narrowed
  exemption (only all-tracked *differing-content* collisions).

Optional (recommended): extract the pure group→verdict classification into a
small testable function and add a co-located `*.test.ts` (`bun:test`) covering:
byte-identical-all-tracked → fail, differing-all-tracked → exempt, branch-local
→ fail, single file → ok. The existing checks ship no unit tests, so this is an
improvement, not required for parity.

## Critical files

| File | Change |
|---|---|
| `plugins/database/plugins/migrations/data/20260503_222323_2a407315__add_improve_pending_queue_top.sql` | delete |
| `plugins/database/plugins/migrations/data/meta/20260503_222323_2a407315__add_improve_pending_queue_top_snapshot.json` | delete |
| `plugins/database/plugins/migrations/data/meta/_journal.json` | remove one entry |
| `plugins/database/plugins/migrations/data/meta/20260503_223547_6917477c__remove_improve_pending_queue_top_snapshot.json` | relink `prevId` |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/migration-hashes-unique/check/index.ts` | tighten logic |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/migration-hashes-unique/CLAUDE.md` | update prose |

## Verification

1. `./equin build` — regenerates migrations (must produce **no** new
   migration, since `schema.ts` is unchanged) and runs checks.
2. `./equin check` — confirm green, in particular:
   - `migration-hashes-unique` (now passes; no collision left)
   - `snapshot-chain-intact` (linear after relink)
   - `migrations-in-sync`
   - `migration-applies-clean`
3. Regression proof for the new rule — temporarily copy an existing migration to a
   new timestamped filename keeping the same `sha8` (byte-identical), run
   `./equin check migration-hashes-unique`, confirm it now **fails** even
   though both files are tracked, then delete the temp file. (Or run the optional
   unit test.)
4. Confirm a from-scratch boot is clean: `query_db` against a fresh worktree DB
   shows `improve_pending_queue_top` absent (dropped by `6917477c`) and no
   duplicate-skip warning in logs for `2a407315`.
