# retention

Bounds unbounded-growth ("firehose") DB tables. A table's growth bound is a
**closed union of two constructors**, and both are TRUE by construction — there
is no "declared but unbounded" state to represent, so there is nothing to check
for. The bad states are unrepresentable; the one claim that cannot be made
unrepresentable (this FK really cascades) throws at boot.

**Portable: it runs on every host.** The barrel imports only `db`, the change
feed and `jobs`, so a portable plugin declares its retention in `server/` — never
a `machine/` half for it. The sweep is a `defineJob` schedule: the desktop's
graphile queue runs a main-only one only on main, the browser's in-process queue
arms every schedule (one backend).

- **`defineRetention(spec)`** — a thin wrapper over `defineJob` that schedules a
  nightly `DELETE ... WHERE <column> < now() - ttlDays [AND <where>]` sweep.
  Mirrors the hand-rolled precedents (`debug.trace-cleanup`,
  `attachments.orphan-sweep`); generalizes them so a table gets a retention
  policy in one line. Records a `{kind:"ttl"}` bound — but only when mounted.
- **`markCascadeBounded(table, owner)`** — asserts, synchronously at module eval,
  that `table` has an FK `onDelete: "cascade"` to `owner` (so deleting an owner
  row reclaims the children), then records a `{kind:"cascade", owner}` bound. If
  the cascade does not exist it **throws at boot**.
- **`getTableGrowthBounds()`** — a copy of the `Map<table, TableGrowthBound>`. Its
  only consumer is the deferred undeclared-growth monitor (a separate follow-up
  task), which uses it as a *silencing* set — which is exactly why every entry
  must be true (mounted for `ttl`, FK-verified for `cascade`), never merely
  declared.
- **Files are not here.** A file sink's `rotate` bound is true by construction
  (`append()` IS the rotation, see `../file-sink/CLAUDE.md`) and is read from
  `getFileSinks()`. Retention does not import file-sink (`node:fs`), so it stays
  portable; the monitor — machine-only, it reads `pg_stat_user_tables` and the
  logs dir — joins the two sets itself.

## `defineRetention`

```ts
import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { _reports } from "./internal/tables";

export const reportsRetention = defineRetention({
  table: _reports,       // PgTable; its name derives the job id `retention.<table>`
  column: "createdAt",   // timestamp column (default "createdAt")
  ttlDays: 7,            // rows older than this are deleted
  cron: "0 4 * * *",     // 5-field UTC (default nightly 04:00)
  perWorktree: true,     // sweep runs in every worktree DB fork (default false = main-only)
  where: eq(_reports.pinned, false), // optional extra scope AND-ed onto the age predicate
});
```

It returns the same `JobFactory` `defineJob` returns — mount it on the consumer
`ServerPluginDefinition` via `register: [reportsRetention]`. The plugin itself
mounts nothing; it is a pure API provider.

**`perWorktree`.** Default `false` (main-only), matching `ScheduleSpec`. Set
`true` only for tables that live in the **per-worktree DB fork** (`_reports`,
`entity_versions`) — a table in the shared/main DB must stay main-only so N live
worktrees don't race N sweeps over the same rows.

The DELETE predicate is `column < cutoff` — **strict**, so a row exactly at the
cutoff instant is kept. `cutoff` is recomputed each tick (not captured at define
time). A missing `column` throws loudly at `defineRetention` call time.

## Coverage ⇔ mounted, by construction (G1)

`defineRetention` records the `{kind:"ttl"}` bound **inside the returned
factory's `register()`**, next to the wrapped `defineJob(...).register()` — never
at call time. A `JobFactory` only becomes a live sweep when the consumer puts it
in `register: [...]`; recording the bound anywhere else would let a policy that is
*defined but never mounted* (its sweep silently never runs) still claim coverage.
By writing the bound only in `register()`, the two facts — "the sweep is
scheduled" and "the table is recorded as bounded" — happen in the same call or
not at all. Forgetting `register: [x]` leaves the table in the same state as never
writing the code: no false coverage, no lying registry. This is the
"failure must never masquerade as a legitimate value" rule applied to the
registry itself.

## `markCascadeBounded` — verify the cascade where the truth lives (G2)

A table whose rows are reclaimed by an FK cascade needs no TTL sweep, but the
claim "this FK really cascades" must be checked, not trusted. `markCascadeBounded`
reads `getTableConfig(table).foreignKeys` from `drizzle-orm/pg-core` — a
synchronous, DB-free read of the drizzle table object — and requires an FK with
`onDelete: "cascade"` whose `reference().foreignTable` is `owner`. On violation it
throws, naming the table, the owner, and every FK actually found (name +
`onDelete` + target).

- Reading the **drizzle declaration** (not `pg_constraint`) is correct and needs
  no DB: `migrations-in-sync` already guarantees `tables.ts` ↔ committed
  migrations, so the declaration *is* the schema. Dropping the `onDelete:
  "cascade"` in a later edit makes the next boot fail at the `markCascadeBounded`
  call.
- Naming the `owner` explicitly (rather than a bare boolean flag) is what makes
  the claim checkable at all, and keeps it greppable.

**This runs at MODULE EVAL of the consumer** — boot's import phase — so a
violation is boot-fatal. `./equin build` probes backend health after
restart and fails loudly ("Check server logs") when the new backend never takes
over, so a bad cascade claim surfaces as a failed build, not a silently-dead app.
Precedent for a throwing boot invariant of exactly this shape:
`plugins/database/plugins/change-feed/server/internal/route-coverage.ts`.

## Why there is no `./equin check`

An earlier design had a `retention:firehose-bounded` check over a string-keyed
registry. It was deleted: `./equin check` runs in a standalone process that
never loads server modules, so the registry was empty (and non-deterministically
so under a full pass), and its only representable failure — a firehose declared
with no bound — became **unrepresentable** once growth-bound declaration
collapsed to the two always-true constructors above. The FK-cascade claim, which
a name-only check genuinely could not verify, is instead verified in-process at
module eval, where the drizzle table object is in hand. Making the bad states
unrepresentable and throwing on the one residual claim is the structural fix; a
check would have been a patch on a footgun.

## Boundaries

- `server/` — the whole plugin (owns all drizzle + `db` usage):
  - `internal/define-retention.ts` — `defineRetention` (bound recorded in
    `register()`).
  - `internal/assert-cascade.ts` — `markCascadeBounded` + the pure `findCascadeFk`
    probe (barrel-private; exported only for its test).
  - `internal/growth-bounds.ts` — the `TableGrowthBound` union and the
    process-global table registry (`declareGrowthBound`, `getTableGrowthBounds`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Retention primitive, on every host: defineRetention wraps defineJob into a nightly TTL sweep (DELETE WHERE column < now()-ttl) whose growth bound is recorded only when the sweep is mounted; markCascadeBounded verifies at module eval that an FK onDelete cascade really reclaims the rows. getTableGrowthBounds exposes the resulting true set of table growth bounds.
- Server:
  - Uses:
    - `database.db`
    - `database/change-feed.changeProducerFor`
    - `infra/jobs.defineJob`
    - `infra/jobs.JobFactory`
  - Exports (types):
    - `RetentionJob`
    - `RetentionSpec`
    - `TableGrowthBound`
  - Exports (values):
    - `defineRetention`
    - `getTableGrowthBounds`
    - `markCascadeBounded`
- Cross-plugin:
  - Imported by: 21 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×5
    - `debug` ×5
    - `page` ×3
    - `conversations` ×2
    - `infra` ×2
    - `apps-core/app-usage`
    - `history/engine`
    - `primitives/usage-rank`
    - `reports/engine`
- Test helpers:
  - Server: `@plugins/infra/plugins/retention/server/testing`
    - `sweepExpired` — One sweep tick's body, extracted from the job for direct testing (the `findCascadeFk` precedent: barrel-private, exported only for its test). `beforeDelete` sees exactly the rows the DELETE predicate matches at select time; a row aging past the cutoff between the two statements waits for the next tick (the predicate is time-based, so the set can only grow, never lose a row the callback already handled).

<!-- AUTOGENERATED:END -->
