# First-class data/backfill migrations: decouple from the drizzle snapshot chain

## Context

Hand-edited **data/backfill migrations** (DML-only, no schema change — created via
`./equin build --custom-migration`) cannot reliably land through
`./equin push` when `main` concurrently adds a schema migration. The push
enters an unrecoverable loop:

1. The post-rebase normalize (`push.ts → postRebaseNormalize → regen-migrations`)
   fires because the migration merge-driver triggers during rebase.
2. `assertNoHandEditedBranchLocalMigrations` aborts: the backfill's content hash
   != filename hash (inherent to any hand-edited migration), so it refuses to
   auto-regenerate (correctly, to avoid discarding the SQL).
3. After rebasing onto a main that added a schema migration, `snapshot-chain-intact`
   FAILS with a Y-fork: the backfill's drizzle snapshot and main's new snapshot
   share the same `prevId`.
4. The documented recovery (`build --reset-migration`) DELETES the branch-local
   migration; plain `drizzle generate` then produces nothing (no schema diff), so
   the SQL is lost. Recreating needs `--custom-migration` again, which re-forks the
   next time main moves. Loop.

Net: backfills only land in a "quiet window" where main doesn't move. Commit
`4c3001b9e` ("rechain avatar backfill onto rebased tip") was a manual hand-fix of
exactly this.

### Root cause (verified)

A data migration has **zero schema delta** — its drizzle snapshot is byte-identical
to its parent's, modulo `id`/`prevId`. The *only* reason it Y-forks is that
`--custom-migration` gives it a snapshot, forcing it into the linear snapshot chain.

Two facts confirm a snapshot is unnecessary and harmful for data migrations:

- **The runtime applies migrations by filename hash and never reads snapshots**
  (`plugins/database/plugins/migrations/server/internal/runner.ts` — `MIGRATION_RE`,
  sorts by timestamp prefix, tracks applied state in `__singularity_migrations` by
  `hash`). Snapshots are a *build-time-only* drizzle artifact.
- **drizzle-kit picks its diff base as the lexicographically-last
  `meta/*_snapshot.json`, ignoring the journal and the prevId chain**
  (`preparePrevSnapshot` in drizzle-kit 0.28.1: globs `meta`, `snapshots.sort()`,
  takes `snapshots[length-1]`). So a snapshot-less data migration is simply skipped;
  the next schema migration correctly bases off the prior *schema* snapshot — which
  is right, since the data migration changed no schema.
- **3 of 4 existing backfills on main already have no snapshot** (`6d466d3e`,
  `996ffe6e`, `b4c0f111`) and have coexisted fine for months — they are invisible to
  `snapshot-chain-intact` (which only reads snapshots) and so can never Y-fork. Only
  the avatar backfill got a snapshot (via `--custom`) and that is precisely the one
  that broke.

### Intended outcome

Make a data/backfill migration a **snapshot-free** artifact (`.sql` + journal entry
only), so it never joins the snapshot chain, never Y-forks, and pushes cleanly
regardless of main movement — **without weakening the safety guarantees that gate
manual migrations.**

## Safety analysis (why this preserves the existing protections)

The `--custom-migration` restriction exists because an agent once broke the app by
working around the standard `schema.ts → drizzle` path (schema drift). This design
keeps every existing protection and **adds one**:

- **Creation stays human-gated.** `migrationsGuard`
  (`plugins/framework/plugins/tooling/plugins/guards/core/guards/migrations.ts`)
  still blocks `--custom-migration` unless `.allow-migrations` exists (explicit user
  approval), and still blocks `rm` of `migrations/data/`. **Unchanged.** Creating a
  data migration remains exceptional.
- **Schema migrations keep full protection.** They always carry a snapshot, so the
  hand-edit detector still aborts on their edits, `snapshot-chain-intact` still
  guards their chain, and `migrations-in-sync` still enforces `schema.ts` parity.
- **The hand-edit exemption applies ONLY to snapshot-less files**, which can be
  created only via the approved path (`--custom-migration` is gated; `rm` of
  snapshots is blocked). An agent cannot reclassify a schema migration as a data
  migration by deleting its snapshot.
- **NEW guarantee — backfills are provably DML-only.** A new check rejects any
  schema-changing DDL in a snapshot-less migration. This *structurally* prevents the
  backfill path from drifting the schema — a stronger guarantee than today's
  `--custom` flow, which permits arbitrary SQL. All 4 existing backfills are DML-only
  and pass.

## Silent-failure analysis (can hand-written backfills corrupt data silently?)

A *naive* decouple (just stop emitting snapshots + exempt the hand-edit detector) WOULD
open two silent-failure classes. The plan closes both; the residual risk is loud.

| # | Failure | Naive risk | Closed by | Result |
|---|---|---|---|---|
| 1 | **Silent schema drift** — DDL hidden in a "data" migration applies to the DB but isn't in `schema.ts` | A DDL *blocklist* regex misses exotic forms (`CREATE EXTENSION`, `DO $$…$$`, `EXECUTE`, `SELECT…INTO`, `CREATE TABLE AS`) → silent drift, future-migration breakage (the original incident) | Change 2: **default-deny DML allowlist** — anything not recognizably `UPDATE/INSERT/DELETE/WITH/SELECT` fails the check | Loud check failure at `push`; schema change is impossible on this path |
| 2 | **Silent runner skip** — runner keys on filename hash; `--custom` freezes it at the empty file, edits don't change it → a DB that applied the frozen hash skips the new SQL with no warning | Exempting the hand-edit tripwire removes the only signal of the mismatch | Change 3: **re-hash data migrations on every build** so filename hash == content hash | Edited content gets a new hash → runs once per DB; stale hash → loud drift warning; never a silent skip |
| 3 | **Double-apply / non-idempotent backfill** on the dev's worktree DB after an edit | Re-hash makes the new content re-run; a non-idempotent backfill (e.g. `x = x + 1`) doubles its effect | Inherent to migrations; mitigated by the long-standing "backfills must be idempotent" rule + loud drift warning + documented re-fork | Loud (drift warning), worktree-DB-only (throwaway); **main's DB always runs final content exactly once** |
| 4 | **Logically-wrong-but-valid DML** (bad `WHERE`, wrong constant) corrupts rows | No tool can detect a syntactically-valid wrong UPDATE | Unchanged — true of *every* migration; gated by the human `.allow-migrations` approval + push review | Same risk surface as today; not introduced or widened by this design |

Net: with Changes 2 and 3, the design adds **no new silent-corruption path**. The only
residual (#4) is the universal "a human wrote wrong SQL" risk that the `.allow-migrations`
human gate already governs and that this change neither introduces nor widens.

## Approach

Snapshot-absence is the canonical marker: **schema migration ⟺ has a snapshot; data
migration ⟺ no snapshot** (per user decision). This is already the structural signal
the runtime and chain check rely on.

### Changes

**1. Stop emitting a snapshot for `--custom-migration`**
`plugins/framework/plugins/cli/bin/migrations.ts` → `generateMigration` (around the
`customMigration` branch and after `renameMigrations`, line ~429):
- When `customMigration` is set, after generate + `renameMigrations`, delete the
  newly-added migration's `meta/<tag>_snapshot.json` (identify via the `added` set
  already computed at line ~397). The `.sql` + journal entry remain. `regenerateJournal`
  is snapshot-agnostic (builds from `NEW_FORMAT` `.sql` files), so no journal change
  is needed beyond what `renameMigrations` already does.
- Result: a data migration is `.sql` + journal entry only — matching the 3 legacy
  backfills and aligning with drizzle's last-snapshot base resolution.

**2. NEW check: `data-migration-dml-only` (closes silent-drift, Class 1)**
New plugin `plugins/framework/plugins/tooling/plugins/checks/plugins/data-migration-dml-only/`
(mirror an existing check, e.g. `snapshot-chain-intact/check/index.ts`):
- For every `.sql` in `migrations/data` with **no** sibling `*_snapshot.json`, split
  into statements (on `;` and `--> statement-breakpoint`), strip `--`/`/* */`
  comments, and require every non-empty statement to begin with an **allowlisted**
  DML keyword: `UPDATE | INSERT | DELETE | WITH | SELECT` (and `SET LOCAL`). Anything
  else fails the check.
- **Default-deny, not blocklist.** This is the key robustness decision: an unrecognized
  statement is *rejected*, so DDL forms a blocklist would miss (`CREATE EXTENSION`,
  `DO $$ … $$`, `EXECUTE`/dynamic SQL, `SELECT … INTO`, `CREATE TABLE AS`) cannot slip
  through. A data migration provably cannot change the schema, so it cannot drift from
  `schema.ts` and break the app the way the original incident did.
- Discovered automatically by the check runner (no registry edit). Gates `push`.
- Verify the 4 existing backfills pass (all bare `UPDATE …;`, no breakpoints — confirmed).
- *(Optional, maximal robustness — out of scope v1):* additionally apply all migrations
  to a scratch DB and introspect-diff against `schema.ts` to catch ANY drift by
  construction (gold standard, heavier — needs a throwaway DB + `drizzle-kit pull`).

**3. Keep filename-hash == content-hash for data migrations (closes silent-skip, Class 2)**
The runner (`runner.ts`) identifies each migration by its filename hash, so the
filename hash **must** equal the hash of the executed SQL — otherwise edits silently
fail to re-run. `--custom` freezes the hash at creation (empty file) and the agent
edits afterward, breaking this invariant; today's hand-edit *abort* is only a
tripwire, not a fix. Instead of exempting data migrations from the tripwire, **make
the invariant self-healing**:
- `plugins/framework/plugins/cli/bin/migrations.ts` → `renameMigrations` (line ~536):
  add a second pass that, for `NEW_FORMAT` `.sql` files with **no** sibling snapshot
  (data migrations), recomputes the content hash and, if it differs from the filename
  hash token, renames the file (timestamp preserved, hash token updated) and
  regenerates the journal. Idempotent: unchanged content → unchanged hash → no-op.
  Runs on every `build`, so a backfill's filename always tracks its current SQL.
- Consequence: editing a backfill yields a **new** hash → it runs exactly once on every
  DB; the stale old hash triggers the runner's existing **loud** drift warning
  (`applied hash X has no matching file on disk`), and re-forking the worktree DB is
  the documented remedy. Loud, never silent.
- `plugins/framework/plugins/cli/bin/commands/regen-migrations.ts` →
  `assertNoHandEditedBranchLocalMigrations` (line ~28): skip branch-local snapshot-less
  `.sql` (their hash is already self-healed by step 3, so the mismatch tripwire is moot
  for them). Schema migrations (with snapshot) **still abort** on content-hash mismatch —
  their SQL must match the snapshot's DDL and must never be silently re-hashed.

**4. Make `--reset-migration` recovery preserve data migrations**
`plugins/framework/plugins/cli/bin/migrations.ts` → `resetBranchLocalMigrations`
(line ~446): skip deleting branch-local `.sql` files that have no sibling snapshot.
(They have no snapshot to delete anyway.) This stops the documented Y-fork recovery
command from destroying backfills.

**5. `snapshot-chain-intact` — no code change**
Snapshot-less data migrations are invisible by construction. Add a one-line note to
its CLAUDE.md documenting that data migrations intentionally carry no snapshot.

**6. Update guard + recovery messaging**
- `guards/core/guards/migrations.ts` `--custom-migration` hint: describe the new
  snapshot-free, DML-only, push-safe model (still requires `.allow-migrations`).
- Recovery hints that point at `--reset-migration` (`build.ts` option text ~line 492,
  `regen-migrations.ts`, `snapshot-chain-intact/check/index.ts:88`): clarify they
  apply to schema migrations; data migrations are preserved automatically.
- Document the data-migration model in
  `plugins/database/plugins/migrations/CLAUDE.md` (or the migrations plugin doc).

**7. One-time normalization of the avatar backfill (optional; lands on main)**
Delete `meta/20260601_222354_4e6a27df__backfill_avatar_icon_aliases_snapshot.json`
so the avatar backfill joins the 3 legacy snapshot-less backfills and the chain head
reverts to the last schema snapshot (`fd75d9b0__add_build_run_pid`). Safe because the
avatar backfill is the current chain tip — nothing references its snapshot. This
removes the lone snapshot-bearing data migration so the invariant
"data migration ⟺ no snapshot" holds uniformly. (If skipped, the rule still holds
going forward; the avatar snapshot is just a harmless tip.)

### Out of scope

- **Raw DDL that drizzle can't express via `schema.ts`.** That genuinely changes the
  schema and must keep a snapshot / go through the chain; it is rare and a separate
  concern. The DML-only check will (correctly) reject such SQL from the snapshot-free
  path — if encountered, surface it to the user rather than working around it.
- **The b3cc75fa `--custom-migration` hash-collision bug** (separate task). This plan
  keeps the `.sql` content (and thus its hash) untouched; no interaction beyond not
  relying on incoming hash uniqueness.
- **Rechaining snapshot-bearing data migrations.** Not needed: decoupling prevents
  the snapshot from existing in the first place. (Item 7 normalizes the one legacy
  case by deletion, not rechain.)

## Critical files

| File | Change |
|---|---|
| `plugins/framework/plugins/cli/bin/migrations.ts` | `generateMigration`: delete snapshot for `--custom`; `renameMigrations`: re-hash snapshot-less `.sql` on every build (Change 3); `resetBranchLocalMigrations`: skip snapshot-less `.sql` |
| `plugins/framework/plugins/cli/bin/commands/regen-migrations.ts` | `assertNoHandEditedBranchLocalMigrations`: skip snapshot-less `.sql` (hash already self-healed) |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/data-migration-dml-only/check/index.ts` | NEW — DML-only enforcement on snapshot-less migrations |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/data-migration-dml-only/CLAUDE.md` | NEW — required by `plugins-have-claudemd` |
| `plugins/framework/plugins/tooling/plugins/guards/core/guards/migrations.ts` | Update `--custom-migration` hint |
| `plugins/framework/plugins/cli/bin/commands/build.ts` | Update `--reset-migration` / `--custom-migration` option help text |
| `plugins/database/plugins/migrations/CLAUDE.md` | Document the data-migration model |
| `plugins/database/plugins/migrations/data/meta/20260601_222354_4e6a27df__...snapshot.json` | (Optional, item 7) delete |

## Verification

End-to-end reproduction of the original failure, proving it now succeeds:

1. **Unit: snapshot is dropped.** In a worktree, `./equin build --custom-migration
   --migration-name test_backfill` (with `.allow-migrations`). Confirm a `.sql` is
   created with **no** matching `meta/*_snapshot.json`, and `_journal.json` lists it.
2. **DML-only check (Class 1).** Hand-edit the SQL with an `UPDATE` → `./equin check
   --data-migration-dml-only` passes. Then exercise the default-deny boundary: `ALTER
   TABLE … ADD COLUMN`, `CREATE EXTENSION pgcrypto`, and `DO $$ BEGIN … END $$;` must
   EACH fail the check (proving exotic DDL can't slip a blocklist). Revert.
2b. **Re-hash invariant (Class 2).** Build with empty SQL → note filename hash H0. Edit
   SQL → `./equin build` → confirm the file was renamed to a new hash H1 matching
   the content, `_journal.json` updated, and the server log shows the backfill applied
   under H1 plus a loud drift warning for H0. Re-build unchanged → no rename (idempotent).
3. **The Y-fork scenario (the bug):**
   - Branch A: add a column in some `schema.ts`, `./equin build --migration-name
     add_col_a`, `./equin push -m a`.
   - Branch B (forked pre-A): `--custom-migration --migration-name backfill_b`, hand-edit
     SQL with an `UPDATE`, `./equin build`.
   - `./equin push -m b` on B. Expected: rebase succeeds; `regen-migrations` does
     NOT abort (snapshot-less → exempt); `snapshot-chain-intact` passes (backfill has no
     snapshot, A's schema snapshot is the lone tip); backfill `.sql` lands unchanged with
     both migrations in timestamp order. **No quiet window required, no manual rechain.**
4. **Recovery preserves data.** On B, after rebasing onto a moved main, run
   `./equin build --reset-migration --migration-name x` and confirm the backfill
   `.sql` is **not** deleted (snapshot-less skip).
5. **Existing migrations still pass.** `./equin check` green on main (all 4 legacy
   backfills are DML-only; chain intact).
6. **Runtime applies it.** Confirm via `mcp__singularity__query_db` that
   `__singularity_migrations` contains the backfill's hash and the UPDATE took effect.
7. **Safety regression guard.** Confirm `--custom-migration` without `.allow-migrations`
   is still blocked by `migrationsGuard`, and `rm` of a migration file is still blocked.
