# drizzle-kit prompts: hold at 0.31.9 until 1.0's hints protocol (v2)

Supersedes `2026-10-30-cli-drizzle-prompts-pty.md`. The PTY was rejected because it keeps
injecting keystrokes into a prompt UI.

## Context

drizzle-kit 0.31.10 added a guard to its prompt renderer (`render()` in `bin.cjs`): it rejects
every prompt when stdin or stdout is not a TTY. `runDrizzleKitWithPrompts`
(`plugins/framework/plugins/cli/plugins/migrations/cli/migrations-interactive.ts`) drives those
prompts over pipes, so since the 0.28.1 → 0.31.11 bump (`6052246812`) no migration can rename or
replace a column (`--migration-answers` does nothing). That bump passed its gates because no test
takes the real drizzle-kit through a prompt.

The clean design exists upstream, but only in drizzle-kit **1.0** (rc.5 at the time of writing).
`generate` never prompts. It exits 2 with a `missing_hints` report and takes `--hints` /
`--hints-file`. The API is `generateMigration(prev, cur, { hints })`, which throws
`MissingHintsError`. This maps 1:1 onto our detect / answer / keyed-answers modes, and would delete
the prompt parser. It needs `drizzle-orm >= 1.0.0-rc.5`, and drizzle-orm is held below 0.39
(task-1793083762-bu58fd).

0.31 has no such API. `drizzle-kit/api`'s `generateMigration` calls the same interactive resolvers,
and the resolver seam (`applyPgSnapshotsDiff`) is not exported.

## Changes

1. **Lock drizzle-kit at 0.31.9**: 0.31.9 doesn't have the guard, 0.31.10 does (checked by grepping
   both tarballs). Use the npm updater's two-install recipe: set the exact `0.31.9` in both
   declaring manifests (`plugins/database/plugins/migrations`, `plugins/framework/plugins/server-core`),
   run `bun install`, widen to `^0.31.9`, run `bun install` again, and confirm bun.lock resolves 0.31.9.
2. **Hold** in `plugins/database/plugins/migrations/package.json` (the owner):
   `drizzle-kit` below `0.31.10`, with a reason, the issue link, and `reviewBy` ≤ 90 days. Lift it
   with the drizzle-orm/kit 1.0 move, which replaces the prompt runner with hints.
3. **Regression test** `cli/migrations-interactive.test.ts`: the real installed drizzle-kit, run
   through `runDrizzleKitWithPrompts` + `drizzleGenerateArgv` on a throwaway schema (tmp dir,
   absolute config paths, cwd = `MIGRATIONS_PLUGIN_DIR` so `bun x` finds the installed binary).
   Generate v1, then drop `a` and add `b`. Detect mode finds one column prompt offering a rename
   from `a`. Answering rename gives `RENAME COLUMN`. Answering create gives drop + add. The deps
   updater runs `./equin test` as a gate, so a bump that breaks prompt driving fails its own
   upgrade task.

## Verification

- The new test passes on 0.31.9 (and fails on 0.31.11, which I'll check before pinning).
- `./equin check` (deps-npm:policy / ranges included).
- att-1793320131-wachkc can rebase and re-run its `--migration-answers` build.
