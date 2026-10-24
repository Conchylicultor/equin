# `./equin build --reset-migration`

## Context

When an agent's worktree branch falls behind `origin/main` and a new migration
has landed on main in the meantime, the next `./equin build` produces a
**Y-fork**: two snapshot JSONs share the same `prevId`. The
`snapshot-chain-intact` check then fails (locally and during `./equin
push`) with:

```
snapshot chain has a Y-fork: 2 snapshots share prevId d555...
hint: Rebase onto origin/main and re-run `./equin build` to regenerate the branch's snapshot against the current tip.
```

Today the recovery path is brittle: rebasing alone does **not** fix anything —
drizzle-kit re-runs against the existing branch-local snapshot and re-emits the
same Y-fork. The agent must manually delete its branch-local migration `.sql`
and `meta/*_snapshot.json` files, but `./.claude/hooks/guard-migrations.sh`
(rightly) blocks `rm` on those paths. The bypass is creating
`$PWD/.allow-migrations` — a footgun that agents are explicitly told *not* to
create on their own initiative. The result: agents either give up, ask the
user, or work around the guard in unsafe ways.

We add a first-class recovery flag — `./equin build --reset-migration` —
that auto-detects branch-local migration files (vs `origin/main`), deletes
them, and proceeds with the normal generate flow. The Y-fork hint and the
guard-hook deny message are updated to point at this flag instead of the
manual bypass.

## Approach

### 1. Add `--reset-migration` flag to `build`

**File:** `cli/src/commands/build.ts`

- Add `.option("--reset-migration", "...")` next to `--migration-name` (lines 275–283).
- Forward to `generateMigration({ ..., resetMigration: opts.resetMigration })` at line 327.

### 2. Implement reset in `generateMigration`

**File:** `cli/src/migrations.ts`

- Extend the `opts` signature with `resetMigration?: boolean`.
- Before snapshotting `before` (line 38), if `resetMigration === true`:
  1. Call new `resetBranchLocalMigrations(serverDir)` helper.
  2. Print one summary line per deleted file (`  removed <file>`).
  3. If nothing was deleted, print `(--reset-migration: no branch-local migrations found, nothing to reset)` and continue (do **not** exit — the user may still want a fresh generate).

#### `resetBranchLocalMigrations(serverDir: string): string[]`

New helper, same file. Returns the list of removed file basenames.

1. Resolve the migration directories: `migrationsDir = serverDir/src/db/migrations`, `metaDir = migrationsDir/meta`.
2. Determine the comparison ref:
   - Prefer `origin/main` (run `git rev-parse --verify origin/main`).
   - Fall back to local `main` if `origin/main` is missing.
   - If neither resolves, `console.error` a clear message ("`--reset-migration` needs `origin/main` or `main` to compare against; run `git fetch origin main` first.") and `process.exit(1)`.
3. List files tracked at that ref under the migrations dir:
   ```
   git ls-tree -r --name-only <ref> -- server/src/db/migrations
   ```
   Build a `Set<string>` of basenames.
4. Read the working-tree `migrationsDir` and `metaDir`.
5. **Delete:**
   - Any `<name>.sql` in `migrationsDir` whose basename is **not** in the tracked set.
   - Any `<name>_snapshot.json` in `metaDir` whose basename is **not** in the tracked set.
   - Use `rmSync(..., { force: true })` — the guard hook only intercepts shell `rm`, not Node `fs.rmSync`.
6. **Do not** touch `_journal.json` directly. Instead, after deletion, immediately call the existing `regenerateJournal(migrationsDir)` (already exported from this file, lines 179–213) so the journal becomes consistent with the remaining `NEW_FORMAT` files **before** drizzle-kit runs. This avoids drizzle picking a wrong "latest snapshot" via a stale journal entry.
7. Return the list of deleted basenames.

The function only ever deletes files that are not tracked at `origin/main` (or local `main`), so it cannot remove a migration that's part of the shared chain. This matches the user's chosen strategy.

### 3. Update Y-fork hint

**File:** `cli/src/checks/snapshot-chain-intact.ts`, line 86

Change:

```ts
hint: "Rebase onto origin/main and re-run `./equin build` to regenerate the branch's snapshot against the current tip.",
```

to:

```ts
hint: "Rebase onto origin/main, then re-run `./equin build --reset-migration --migration-name <slug>` to drop this branch's old migration and regenerate it against the new tip.",
```

Also update the related stderr-collision hint in `cli/src/migrations.ts`
line 73 to suggest the same flag.

### 4. Update guard-hook deny message

**File:** `.claude/hooks/guard-migrations.sh`, lines 32–43

Replace the body of the `deny "..."` call so that the documented recovery for
the Y-fork case is `--reset-migration`, and the `.allow-migrations` bypass is
demoted to a last-resort note. Concretely:

- Keep: "Refusing to delete migration files directly. ... managed exclusively by `./equin build` ..."
- Keep: the "remove a table or plugin" recipe (`build --migration-name remove_<plugin_name>`).
- **Replace** the "If the user has EXPLICITLY instructed..." `.allow-migrations` block with:
  > If you hit a snapshot-chain Y-fork after rebasing onto main, run:
  >   ./equin build --reset-migration --migration-name <slug>
  > That drops this branch's migration and regenerates it against the new tip.
- Append a short tail line: "(`.allow-migrations` still bypasses this hook in true emergencies, but agents must never create it without explicit user approval in this conversation.)"

The hook's behavior (`exit 0` on `.allow-migrations` present, deny on `rm
... db/migrations/`) is unchanged — only the deny *text* changes.

## Files to modify

| File | Change |
| --- | --- |
| `cli/src/commands/build.ts` | Add `--reset-migration` flag + forward to `generateMigration`. |
| `cli/src/migrations.ts` | Accept `resetMigration` opt; new `resetBranchLocalMigrations()` helper; update stderr-collision hint at line 73. |
| `cli/src/checks/snapshot-chain-intact.ts` | Update Y-fork hint at line 86. |
| `.claude/hooks/guard-migrations.sh` | Replace `.allow-migrations` advice in the deny message with the `--reset-migration` recipe. |

No new dependencies. No DB-schema or plugin changes.

## Verification

1. **Unit-ish smoke**: from a clean worktree, run `./equin build` — confirm no behavior change (no flag passed → existing path).
2. **Reset-with-no-branch-local-files**: run `./equin build --reset-migration` on a clean worktree — confirm it prints the "nothing to reset" line and proceeds.
3. **Reset-with-branch-local-file**: stage a fake branch-local migration (e.g. add a column to a plugin's `schema.ts`, run `./equin build --migration-name fake_test` to generate one), then re-run `./equin build --reset-migration --migration-name fake_test`. Confirm the previously-generated `.sql` + `_snapshot.json` are deleted, a new pair is generated against the current `origin/main` tip, and `./equin check --snapshot-chain-intact` passes.
4. **Y-fork repro**: simulate the conflict by checking out a stale branch with a migration whose `prevId` collides with one on `origin/main`. Run `./equin check` — confirm the Y-fork hint now references `--reset-migration`. Run the suggested command — confirm recovery succeeds in one shot.
5. **Hook**: try `rm server/src/db/migrations/<file>.sql` from bash — confirm the deny text now references `--reset-migration` and no longer leads with the `.allow-migrations` instructions.
6. **Origin/main fallback**: in a fresh worktree where `origin/main` isn't fetched, run `./equin build --reset-migration` — confirm fallback to local `main` works; also confirm the clean error when neither ref exists.

## Out of scope

- Restoring `_journal.json` from `origin/main` directly (we regenerate it from remaining files instead — simpler and equally correct because every entry is a pure function of the remaining `NEW_FORMAT` filenames).
- Changing the rest of the snapshot-chain-intact hints (duplicate-id, missing-root, missing-parent, orphan) — only the Y-fork case maps cleanly to `--reset-migration`.
- Removing the `.allow-migrations` bypass — kept as a last-resort escape hatch.
