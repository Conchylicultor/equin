# Firehose retention coverage — enforce by construction, throw at boot

**Category:** global (framework infra) · **Date:** 2026-07-09 · **Status:** Plan

Resolves deferred item 2 of [`research/2026-07-08-global-bounding-boot-time-work.md`](./2026-07-08-global-bounding-boot-time-work.md).

## Context

`plugins/infra/plugins/retention/` bounds unbounded-growth ("firehose") DB tables.
A table declares itself a firehose (`defineRetention({firehose:true})` or
`markFirehose(table)`), and the `retention:firehose-bounded` `./equin check`
is supposed to fail when a declared firehose has neither a retention policy naming
it nor a declared FK-cascade owner.

The check reads a module-level registry populated as a **side effect of
`defineRetention` / `markFirehose` at module eval**. `./equin check` is a
standalone bun process that never loads server modules, so the registry is empty
and the check passes silently. The original framing of the fix was "make the check
statically load-complete." Investigation shows that framing is wrong on three
counts, and that the real fix is smaller and structural.

### What the investigation found

**1. The check is not merely empty — it is non-deterministic.** Checks all run
concurrently in one process (`tooling/plugins/checks/core/runner.ts`, `Promise.all`),
and `plugins-doc-in-sync` calls `buildEnrichedTree` → `buildPluginTree({facets:true})`,
which barrel-imports **every plugin's server barrel**. So whether the retention check
observes `_reports` depends on whether docgen won the race to import `reports/server`
into the shared process. Run alone (`./equin check retention:firehose-bounded`)
the registry is empty; run in a full pass it may be populated. A green result carries
no information in either mode.

**2. The check's failure surface is provably empty.** The only production consumer is
`plugins/reports/server/internal/retention.ts`, and `firehose:true` on `defineRetention`
*both* declares and covers, so it is self-covering by construction. Bare
`markFirehose(table)` — the sole input that can make `evaluateFirehoseCoverage` return
`{ok:false}` — has **zero call sites** repo-wide. Even a perfectly load-complete check
would enforce a rule nobody can trip.

**3. "Catch a future unbounded table that forgets retention" is undecidable from
declarations.** A table nobody *declared* is invisible to any declaration-reading
check, static or runtime. Deferred item 2 asks the check to achieve something no
version of the check can achieve. That gap is closed empirically (a monitor over
`pg_stat_user_tables` firing on *large table ∧ no declared bound*), which is
**already tracked as a separate follow-up task** and is out of scope here.

### The two silent gaps that are real

Neither is what the check was written to catch, and neither is visible to any static
scan:

- **G1 — defined but not mounted.** `defineRetention` records coverage at *module-eval*
  time (`define-retention.ts:81`), but the returned `JobFactory` only becomes a live
  sweep when the consumer puts it in `register: [...]` (`jobs/server/internal/registry.ts:340-360`
  — `jobRegistry.set` happens inside `factory.register()`, nowhere else). Define a policy,
  forget to mount it: coverage is recorded, the check passes, **the sweep never runs.**
  The registry lies.
- **G2 — unverified cascade claim.** `markFirehose(table, {cascadeOwner:true})` asserts
  "an FK `onDelete:"cascade"` reclaims these rows." Nothing checks it. The retention
  `CLAUDE.md` explains why the *check* cannot: it only ever holds table name strings.
  That constraint does not apply in-process, where `getTableConfig(table).foreignKeys[].onDelete`
  is a synchronous, DB-free read of the drizzle table object.

### Decision

Make the bad states **unrepresentable**, and for the one claim that cannot be made
unrepresentable (this FK really cascades), **throw at the declaration site during
module eval** — which is boot. Delete the check.

This is the CLAUDE.md rule applied to the check itself: *"Fix the structural issue,
not the specific instance."* An assertion that a mounted job exists is a patch on a
footgun; deleting the footgun is the fix.

Throwing is the right loudness tier here, and it reaches the author at the right
moment — in fact **earlier than a boot crash**. `./equin build` (and `push`'s
`regen-generated` normalize step) runs docgen, which calls
`buildPluginTree({facets:true})` → `importBarrel` over **every** plugin's server
barrel (`codegen/core/docgen.ts:160-167`). A `throw` at consumer module eval therefore
fails the *build*, at the doc-generation step, before the frontend build and before the
backend restarts. Verified: a deliberately false `markCascadeBounded(_reports, _reports)`
fails `./equin build` with `EXIT=1` and the full diagnostic, from
`[barrel-import] Failed to import …/conversations/server/index.ts`.

This is what makes deleting the check free rather than a trade: the module-eval
assertion is *already* a build-time and push-time gate, running strictly earlier and
with strictly more information (real drizzle table objects) than the check ever had.
The health probe (`plugins/framework/plugins/cli/bin/commands/build.ts:489-580`, fails
with "Check server logs" when the new backend never takes over) is the second net,
for a throw that somehow only manifests at real boot.

Precedent for a throwing boot invariant of exactly this shape:
`plugins/database/plugins/change-feed/server/internal/identity-coverage.ts`
(`assertScopePoliciesCovered`, thrown from `onReadyBlocking`; its header comment states
the rationale — *"a static `./equin check` can reach neither a live DB nor the
server-only contribution/registry sets"*).

## Design

### The closed union

Growth-bound declaration collapses to two constructors of one closed set. There is no
"declared firehose with no bound" state to check for, because it cannot be written.

```ts
// plugins/infra/plugins/retention/server
export type GrowthBound =
  | { kind: "ttl"; ttlDays: number }        // recorded by defineRetention's register()
  | { kind: "cascade"; owner: string };     // recorded + VERIFIED by markCascadeBounded

// A table bounded by a nightly TTL sweep.
defineRetention({ table: _reports, ttlDays: 7, perWorktree: true, where: isNull(_reports.taskId) });

// A table whose rows are reclaimed by an FK cascade. Throws at module eval if the
// declared cascade does not exist in the drizzle table object.
markCascadeBounded(_someChildTable, _ownerTable);
```

Deleted: the `firehose` field on `RetentionSpec` (pure ceremony — a `defineRetention`
call *is* a bound; labelling the same table a firehose in the same breath adds a
self-covering registry entry with no consumer), and `markFirehose` in both forms.

### G1 — coverage ⇔ mounted, by construction

Move `declareRetentionCoverage(tableName)` **out of the `defineRetention` call body and
into the returned `Registration`'s `register()`**, alongside the wrapped
`defineJob(...).register()`. The two writes then happen in the same call or not at all.

```ts
// define-retention.ts (sketch)
export function defineRetention(spec: RetentionSpec): RetentionJob {
  // …validate column; throws loudly at call time (unchanged)…
  const job = defineJob({ name: `retention.${tableName}`, /* …unchanged… */ });
  return {
    ...job,
    register() {
      job.register();                                  // throws on duplicate job name
      declareGrowthBound(tableName, { kind: "ttl", ttlDays: spec.ttlDays });
    },
  };
}
```

A policy that is never mounted now records **nothing**. Forgetting `register: [x]` leaves
the table in the same state as never having written the code — no false coverage, no
lying registry. The failure is honest rather than absorbed, per the api-design rule that
failure must never masquerade as a legitimate value.

The consumer API and per-table job shape are unchanged (`register: [reportsRetention]`
still reads the same), so this mirrors the existing precedent byte-for-byte rather than
inventing a new mounting mechanism.

> **Why this, and not a single always-mounted `retention.sweep` job.** Collapsing the N
> per-table jobs into one plugin-owned sweep also makes mounting unrepresentable, but it
> costs per-table retry isolation and queue-pane visibility, and it converts a `defineRetention`
> into a side-effect-only module — reintroducing the identical footgun one layer up
> ("remember to `import "./internal/retention"`"). Coverage-at-register gets the same
> guarantee with a smaller diff and no behavior change.

### G2 — verify the cascade claim where the truth lives

`markCascadeBounded(table, owner)` asserts, synchronously at module eval, that `table` has
a foreign key with `onDelete: "cascade"` whose `reference().foreignTable` is `owner`, then
records `{kind:"cascade", owner}`. On violation it throws, naming the table, the owner, and
the FKs it actually found.

- `getTableConfig` from `drizzle-orm/pg-core` returns `foreignKeys: ForeignKey[]`, each with
  `onDelete: 'cascade'|'restrict'|'no action'|'set null'|'set default'` and
  `reference(): { foreignTable, foreignColumns, … }`. Synchronous, no DB round-trip.
  Precedent for `getTableConfig`: `plugins/infra/plugins/query-resource/server/internal/identity.ts`.
  Precedent for the `onDelete:"cascade"` declaration shape:
  `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts:92`,
  `plugins/infra/plugins/attachments/server/internal/define-link.ts:63,66`.
- Reading the **drizzle declaration** (not `pg_constraint`) is correct and needs no DB:
  `migrations-in-sync` already guarantees `tables.ts` ↔ committed migrations, so the
  declaration is the schema. Dropping `onDelete:"cascade"` in a later edit makes the next
  boot fail at the `markCascadeBounded` call.
- Naming the `owner` (rather than a bare `cascadeOwner: true` flag) is what makes the claim
  checkable at all, and keeps it greppable.

This supersedes the retention `CLAUDE.md` section *"Why cascade coverage is a declared flag,
not FK introspection"* — that reasoning was sound for a name-only static check, and is void
now that the check is gone.

### Registry placement

`shared/internal/firehose-registry.ts` exists **only** so the `check/` could read it without
importing `server/`. With the check deleted, the registry is server-private. It becomes
`server/internal/growth-bounds.ts` and `shared/` is removed.

Its sole remaining consumer is the deferred growth monitor (the follow-up task), which needs
the bound set as its *silencing* set — precisely why the set must now be true (mounted, and
FK-verified) rather than merely declared. `getGrowthBounds()` stays exported for it.

## Files

**Modified**
- `plugins/infra/plugins/retention/server/internal/define-retention.ts` — drop `firehose` from
  `RetentionSpec`; delete `markFirehose`; move the coverage write into `register()`.
- `plugins/infra/plugins/retention/server/index.ts` — export `markCascadeBounded`,
  `getGrowthBounds`, `GrowthBound`; drop `markFirehose`.
- `plugins/infra/plugins/retention/CLAUDE.md` — rewrite: remove *"Registry loading model
  (current limitation)"* and *"Why cascade coverage is a declared flag"*; document the closed
  union, coverage-at-register, and the module-eval cascade assertion.
- `plugins/reports/server/internal/retention.ts` — drop `firehose: true` (the call is the bound).
  `register: [backfillNoiseWarmup, reportsRetention]` in `plugins/reports/server/index.ts:43`
  is unchanged and now load-bearing for coverage.
- `research/2026-07-08-global-bounding-boot-time-work.md` — amend deferred item 2: record that
  making the check load-complete cannot achieve its stated goal, and point here.

**New**
- `plugins/infra/plugins/retention/server/internal/growth-bounds.ts` — the `GrowthBound` union,
  `declareGrowthBound` (throws on a conflicting re-declaration), `getGrowthBounds`.
- `plugins/infra/plugins/retention/server/internal/assert-cascade.ts` — `markCascadeBounded` +
  the pure `findCascadeFk(table, owner)` used by both it and its tests.

**Deleted**
- `plugins/infra/plugins/retention/check/index.ts`
- `plugins/infra/plugins/retention/check/firehose-check.test.ts`
- `plugins/infra/plugins/retention/shared/internal/firehose-registry.ts` (and `shared/`)

`check.generated.ts` drops the retention entry on the next `./equin build`; the
`plugins-registry-in-sync` check guards the drift. No registry is hand-edited.

## Tests (`bun:test`, co-located)

- `server/internal/growth-bounds.test.ts` — a ttl bound and a cascade bound coexist; a
  conflicting re-declaration of the same table throws; `getGrowthBounds()` returns a copy.
- `server/internal/assert-cascade.test.ts` — `findCascadeFk` accepts an FK with
  `onDelete:"cascade"` to the named owner; rejects `onDelete:"no action"`, rejects a cascading
  FK to a *different* owner, rejects a table with no FKs. `markCascadeBounded` throws with a
  message naming the table, the owner, and the FKs found.
- `server/internal/define-retention.test.ts` — `defineRetention(...)` alone records **no**
  growth bound; calling `.register()` records `{kind:"ttl"}`. (This is the G1 regression test.)
- `server/internal/retention-sql.test.ts` — unchanged.

Run: `bun test plugins/infra/plugins/retention`

## Verification

1. `./equin check --list` no longer lists `retention:firehose-bounded`; `./equin check` is green.
2. `./equin build` succeeds and the backend boots.
3. **G2 fires and the build reports it.** Temporarily add `markCascadeBounded(_reports, _tasks)`
   (no such FK) to `plugins/reports/server/internal/retention.ts` and run `./equin build`.
   Expect the build to fail at the health probe with "Check server logs", and the backend log to
   carry the assertion naming `_reports` / `_tasks`. Revert.
4. **G1 is closed.** Temporarily remove `reportsRetention` from `register: [...]` in
   `plugins/reports/server/index.ts`, rebuild, and confirm via `mcp__singularity__query_db` that
   `graphile_worker` has no `retention._reports` cron entry **and** that `getGrowthBounds()` no
   longer reports `_reports` (assert in `define-retention.test.ts` rather than by hand). Revert.
5. **Steady state.** `mcp__singularity__query_db`: `SELECT * FROM graphile_worker.known_crontabs`
   contains `retention._reports`. Seed a `_reports` row with `created_at < now() - 7 days` and
   `task_id IS NULL`, run the sweep, confirm it is deleted and that a row with a non-null
   `task_id` survives.
6. `bun test plugins/infra/plugins/retention` — all green.

## Out of scope / follow-ups

- **Undeclared-growth monitor** (the empirical half of deferred item 2) — already tracked as a
  separate task. It reads `pg_stat_user_tables.n_live_tup` + `pg_total_relation_size` on a
  main-only schedule and files a deduped `recordReport` + investigation task for any table over
  threshold that carries **no** `GrowthBound`. Precedents: `debug/boot-budget` (monitor shape),
  `.../tables/plugins/row-count/server/internal/row-count-handler.ts` (the pg_stat query).
  Answering the filed task *is* the declaration that silences it.
- **`entity_versions` retention** (deferred item 1) — a product decision (keep-N-per-entity vs
  TTL vs cascade-only). Under this design it simply carries no `GrowthBound` and is caught by the
  monitor above, rather than being pinned in a permanently-red check state.
- **Other undeclared firehoses surfaced during this investigation**, for the monitor to adjudicate:
  `search_documents` (deleted only by explicit consumer calls), `_attachments` (orphan-sweep, not a
  declared bound). Not declared here — a `GrowthBound` with no reader is speculative API.
- **`check/` and `bin/` are unmodelled runtimes in the boundary DSL.** `boundaries/core/resolve.ts:64-65`
  resolves them to `runtime: null`, and `evaluate.ts:19-29` bypasses runtime isolation entirely for
  such files — which is why four existing checks import server modules with the boundary checker
  silent. Nothing in the config documents this as intentional. Worth a separate task; this plan does
  not rely on it (the check is deleted, not rewired).
