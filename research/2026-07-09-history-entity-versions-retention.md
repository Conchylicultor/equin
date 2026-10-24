# `entity_versions` retention — bounding the version-history firehose

**Category:** history · **Date:** 2026-07-09 · **Status:** Planned

## Context

`entity_versions` (`plugins/history/plugins/engine/server/internal/tables.ts`) accrues a
row on every edit of a versioned entity. `recordVersion` coalesces edits inside a ~10-min
window onto one row, so the growth rate is bounded *per session* — but the row count over
time is not. The table has **no FK to any consumer** (deliberately: the engine is
domain-agnostic and the snapshot is opaque), so the only reclamation path today is the
consumer calling `deleteVersions` when the entity itself is deleted. A live,
frequently-edited page therefore grows its history without bound, forever.

This is Phase 2 item 5 of `research/2026-07-08-global-bounding-boot-time-work.md`, the one
item deferred out of that change because it is a **product policy decision**, not a
mechanical one: unlike `_reports` (disposable telemetry, re-filed on recurrence), this is
user-facing history and a TTL is destructive.

**The decision, now made:** a 30-day TTL on version age. Versions older than 30 days are
dropped; recent history is always kept. This matches Notion's free-tier page-history
semantics, which is the product this feature is modelled on.

The `infra/retention` primitive (`defineRetention` / `markFirehose`) was built in Phase 1
for exactly this and already has a working consumer precedent in
`plugins/reports/server/internal/retention.ts`.

## Decisions

### Sweep pinned versions too — no `where` scope

`recordVersion(..., { pin: true })` has exactly one caller today:
`handle-restore-version.ts:23`, which pins the "Before restore" undo point so the
post-restore auto-snapshot cannot coalesce over it. That is a **machine-created** row, not
a user-curated one. A 90-day-old "Before restore" point is no more precious than a
90-day-old auto-snapshot.

Sparing pinned rows (`where: eq(_entityVersions.pinned, false)`, mirroring reports'
`taskId IS NULL` safety scope) would leave one immortal row per restore click — i.e. the
table would remain unbounded, defeating the entire point of the policy. So the sweep is
unscoped: `DELETE WHERE created_at < now() - 30 days`.

If a manual "named version" feature ever lands (the `tables.ts` comment anticipates one),
*that* is when a protective scope becomes correct — and it should key off a new
`user_created` flag, not off `pinned`, which is an internal coalescing barrier.

### Accepted semantics

A page untouched for more than 30 days loses its **entire** timeline — the version dialog
goes empty and restore becomes impossible. This is what a 30-day TTL means and is
intended. Nothing is lost that the entity itself doesn't already hold: the newest version
is a snapshot of state the live entity still carries; versions are only ever useful as
*past* states.

### `firehose: true` — an inventory entry, not enforcement

Worth recording plainly, because the flag's name overpromises. It has **zero** runtime
effect on the sweep. `defineRetention` (`define-retention.ts:83-85`) does:

```ts
declareRetentionCoverage(tableName);   // unconditional
if (spec.firehose) declareFirehose(tableName, { cascadeOwner: false });
```

Both write a module-level registry read only by the `retention:firehose-bounded` check.
Two independent reasons it cannot fail for this table:

1. **Self-satisfying.** The same call that declares the firehose also declares retention
   coverage, and the check fails only on `!cascadeOwner && !retentionCovered`. A firehose
   declared *via* a retention policy is covered by construction. Only a standalone
   `markFirehose(table)` can ever turn the check red — that is the primitive's intended
   forcing function (declare → check goes red → you are forced to add a policy).
2. **The check never observes it.** The registry is populated as a side effect of module
   eval of `define-retention.ts`, which happens only when a *server* module imports it.
   `./equin check` is a standalone process; the only importers of
   `shared/internal/firehose-registry.ts` are the check, the writer, and the writer's test.
   So `getFirehoseEntries()` returns `[]` and the check passes trivially. `_reports` has
   carried `firehose: true` since Phase 2 and has never been observed either.

We still pass `firehose: true`, for an accurate greppable inventory of known-unbounded
tables and symmetry with the `_reports` precedent. It does not protect anything today.
Closing gap (2) is deferral #2 of the Phase-2 doc and is **out of scope here**; a task is
filed separately.

## Implementation

### 1. New file — `plugins/history/plugins/engine/server/internal/retention.ts`

Mirrors `plugins/reports/server/internal/retention.ts` byte-for-byte in shape.

```ts
import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { _entityVersions } from "./tables";

export const entityVersionsRetention = defineRetention({
  table: _entityVersions,
  column: "createdAt",
  ttlDays: 30,
  perWorktree: true,
  firehose: true,
});
```

- **`perWorktree: true`** — `entity_versions` lives in the per-worktree DB fork, so each
  backend sweeps its own rows. (`retention/CLAUDE.md` names this table explicitly as a
  `perWorktree` case.) Main-only would leave every worktree fork unbounded.
- **No `where`** — per the decision above.
- **Default cron** `0 4 * * *` (nightly 04:00 UTC), inherited.
- Job id derives to `retention.entity_versions` via `getTableName`.

The file carries a comment block explaining *why* pinned rows are swept and what the
accepted semantics are — the reports precedent sets that bar.

### 2. Mount it — `plugins/history/plugins/engine/server/index.ts`

The barrel currently exports only `httpRoutes`. Add the registration:

```ts
import { entityVersionsRetention } from "./internal/retention";
// ...
export default {
  description: "...",
  register: [entityVersionsRetention],
  httpRoutes: { ... },
} satisfies ServerPluginDefinition;
```

Barrel purity holds — `register: [...]` sits inside the single default export, exactly as
`plugins/reports/server/index.ts:43` does.

### 3. Test — `plugins/history/plugins/engine/server/internal/retention.test.ts`

A `bun:test` file (pure logic, co-located, **not** under `__tests__/`). Deliberately
small, because the primitive is already covered by 14 tests
(`retention-sql.test.ts` renders the `column < cutoff` predicate; `firehose-check.test.ts`
covers coverage evaluation). What is *not* covered is this consumer's declaration:

- `entityVersionsRetention.name === "retention.entity_versions"` — pins the job id, which
  is the dedup/cron key.
- Importing the module at all is the real assertion: `defineRetention` **throws at call
  time** if `column` names a column the table lacks, so a rename of `createdAt` fails the
  test loudly instead of at server boot.

The plugin-private `firehose-registry` cannot be asserted from here — cross-plugin imports
from another plugin's `shared/` are forbidden (boundary rule R10). That is correct and not
worth working around.

### 4. Docs — `plugins/history/plugins/engine/CLAUDE.md`

Currently pure autogen. Add a short hand-written prose section above the
`AUTOGENERATED:BEGIN` marker covering the 30-day TTL, why pinned rows are not spared, and
the "stale page loses its whole timeline" semantic. `./equin build` regenerates the
autogen block plus `docs/plugins-{compact,details}.md`.

### What this change does *not* need

- **No migration.** No schema change — `migrations-in-sync` stays green.
- **No index.** The sweep is `WHERE created_at < cutoff`; the existing
  `(source_id, entity_id, created_at)` index can't serve it, so the nightly DELETE is a seq
  scan. That is fine and deliberate: once the TTL is in force the table stays small, it is
  per-worktree, and the scan runs once a night at 04:00. Adding a `created_at` index would
  tax the hot `recordVersion` insert path to speed up a nightly job on a small table.
- **No boundary/cycle risk.** `history/engine/server` → `@plugins/infra/plugins/retention/server`
  is a legal runtime-barrel import. `retention` depends on `database` + `infra/jobs`;
  `history/engine` depends on `database` + `infra/endpoints`. No cycle.

## Verification

1. `./equin build` — regenerates docs, restarts the server. Must succeed.
2. `./equin check` — all green. Specifically `migrations-in-sync` (no new migration),
   `retention:firehose-bounded` (still trivially green — see the honesty note above),
   `plugins-doc-in-sync`, `type-check`.
3. `bun test plugins/history/plugins/engine` — the new declaration test passes.
4. **Cron actually registered.** Via the `query_db` MCP tool against this worktree's DB:
   ```sql
   SELECT identifier, last_execution FROM graphile_worker.known_crontabs
   WHERE identifier LIKE '%retention.entity_versions%';
   ```
   Expect one row. Cross-check in the UI at Debug → Queue (active triggers list).
5. **Boundary correctness** is already proven by `retention-sql.test.ts` (strict `<`, so a
   row exactly at the cutoff survives; cutoff recomputed per tick).

### Known gap in verifiability (worth surfacing, not fixing here)

`defineRetention` returns a `JobFactory` that exposes `name` / `enqueue` / `inputSchema`
but **no way to invoke the sweep body**. So a consumer cannot write a DB-backed test that
inserts an old row, runs its own policy, and asserts the row is gone — the strongest test
available. The nearest thing is `entityVersionsRetention.enqueue({})` against a live
server, which routes through graphile and is not test-friendly.

This is a primitive gap, not a defect in this change. Per the repo's "report footguns, do
not memorize them" rule, it should be fixed at the source (e.g. `defineRetention` also
returning a `sweep()` thunk the job body calls, so consumers can test their own policy) —
filed as a follow-up rather than worked around here.

## Follow-ups to file

1. **Make `retention:firehose-bounded` statically load-complete** so a *future* unbounded
   table that forgets retention actually fails the check. Today the registry is empty in
   the check process, so both declared firehoses (`_reports`, `entity_versions`) are
   unobserved. Likely shape: have the facets/docgen extractor surface `defineRetention` /
   `markFirehose` call sites into a build-time manifest the check reads — the pipeline
   already statically extracts `Register: defineJob('retention.reports')` from barrels.
   (= deferral #2 of `research/2026-07-08-global-bounding-boot-time-work.md`.)
2. **Expose a testable sweep from `defineRetention`** — see the gap above.

## Critical files

| Path | Change |
|---|---|
| `plugins/history/plugins/engine/server/internal/retention.ts` | **new** — the policy |
| `plugins/history/plugins/engine/server/index.ts` | add `register: [entityVersionsRetention]` |
| `plugins/history/plugins/engine/server/internal/retention.test.ts` | **new** — declaration test |
| `plugins/history/plugins/engine/CLAUDE.md` | prose section on the TTL |
| `plugins/reports/server/internal/retention.ts` | reference precedent (unchanged) |
| `plugins/infra/plugins/retention/server/internal/define-retention.ts` | the primitive (unchanged) |
