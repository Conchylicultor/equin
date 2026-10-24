# migration-applies-clean: make the derived-view dry-run actually test the views

## Context

`migration-applies-clean` (`plugins/database/plugins/migrations/check/index.ts`)
replays a branch's pending migrations against main's DB in a rolled-back
transaction. Its last step, `rebuildDerivedViews(tx)` inside
`dryRunPendingMigrations` (`migrations/server/internal/runner.ts:240`), exists to
catch a migration that breaks a derived view (e.g. `DROP COLUMN … CASCADE` takes a
view with it, and the view's source can no longer be re-created) before it crashes
main's boot.

It tests nothing. `rebuildDerivedViews` reads its view set from
`View.getContributions()`, a module-global table that only `collectContributions`
fills — and only a booted backend calls that. The `./equin check` process
never boots, so the list is empty and the function returns at
`ordered.length === 0`. The check is green on exactly the case it was built for.

Root shape (same as the retired `apply-migrations` crash): a server function reads
a registry that only exists inside a booted backend, and outside one the registry
silently reads as "empty" instead of "not there".

## Approach

Two fixes, top rung first.

### 1. The view set becomes an argument (rung 1 — the empty read has no spelling)

- `rebuildDerivedViews(db, views)` — `views` is the required list of `View`
  payloads (`{ view, dependsOn?, identityTable? }[]`). The function no longer
  touches `View.getContributions()`.
  - `plugins/database/plugins/derived-views/server/internal/rebuild.ts`
- `dryRunPendingMigrations(db, { views })` — same, required, forwarded to the
  rebuild. `plugins/database/plugins/migrations/server/internal/runner.ts`
- The booted caller passes the collected set:
  `rebuildDerivedViews(db, View.getContributions())` in
  `plugins/database/server/index.ts:69`.
- Update the comments in `derived-views/CLAUDE.md` ("How it works") and
  `contribution.ts` that say the rebuild reads the contributions itself.

### 2. The check gathers the views from the server barrels

This is the established pattern for checks that need server contributions:
`plugins/config_v2/check/registrations-paired.ts` walks `ctx.tree` (from
`buildRegistryGenContext`), `importBarrel`s each `server/index.ts`, reads
`default.contributions`, and keeps only plugins in `ctx.mainBundle` (main's
composition closure — a plugin outside it contributes no view on main).

- Add one generic, pure framework method so a check never matches on the
  `_kind` symbol's description string:
  `ServerContributionToken.from(plugins: { contributions?: ServerContribution[] }[]): P[]`
  — filters by the token's own `kind` symbol, no global state.
  `plugins/framework/plugins/server-core/core/contributions.ts`
  (Symbol identity holds: `importBarrel` loads the real `derived-views/server`
  module the check itself imports.)
- In the check's SLOW PATH only (a migration file differs from `origin/main`),
  before `withDirectDb`: build the context, import the bundled server barrels,
  `View.from(defs)` → pass to `dryRunPendingMigrations(drizzle(pool), { views })`.
  A barrel import failure is the check's own `{ ok: false }`, as in
  `registrations-paired`. The fast path stays free.
- Put the barrel walk in a small `check/internal/declared-views.ts` so `index.ts`
  stays the orchestration.

The rebuild's skip-when-signature-unchanged logic is kept as is: the dry-run then
behaves exactly as main's next boot would (branch's view source vs. main's live
signature, after the pending migrations).

### 3. Reading contributions before they are collected throws (rung 4 — the class)

`getContributions()` on a process that never ran `collectContributions` returns
`[]` today. Make `byKind` start as "not collected" and have `getContributions()`
throw `"<debugName>: contributions read before the plugin graph was collected —
this process never booted"`. Any other server module driven from a CLI or a
headless test then fails loudly instead of acting on an empty set.

Audit the ~64 server-side `getContributions()` call sites and tests before
landing: any caller that legitimately runs un-booted (a headless test, a CLI
path) must be given its data explicitly, as step 1 does here — not a
`[]` fallback. If the audit turns up more than a handful, split this step into
its own task and land 1–2 first.

## Out of scope (note as follow-up)

`dryRunPendingMigrations` does not replay `rebuildDerivedTables` or the
change-feed trigger rebuild either, which main's boot also runs after
migrations. A migration that breaks a trigger-maintained rollup would pass the
check the same way. File as a task once this lands.

## Verification

1. `./equin test plugins/framework/plugins/server-core` — unit test for
   `token.from()` (matches own kind, ignores others, carries payload fields) and
   for the throw-before-collect.
2. Negative end-to-end, in this worktree (reverted afterwards): add a migration
   that `ALTER TABLE … DROP COLUMN … CASCADE` on a column `tasks_v` /
   `attempts_v` reads, then `./equin check migration-applies-clean` → must
   FAIL with the `CREATE VIEW` error. Before the fix it passes.
3. Positive: remove the migration → check passes via the fast path; with a
   harmless migration (e.g. `ADD COLUMN`) → slow path runs, views rebuild, pass.
4. `./equin build` (boot still rebuilds views through the new argument) and
   `./equin check`.
