# Read-set capture must not depend on how the author spelled the table name

> **Category:** global (database, runtime-profiler, debug)
> **Status:** plan / ready to implement
> **Follows:** [`2026-06-19-global-live-state-read-set-capture.md`](./2026-06-19-global-live-state-read-set-capture.md) (L3 capture), [`2026-06-20-global-read-set-ceiling-silent-full.md`](./2026-06-20-global-read-set-ceiling-silent-full.md) (the silent-FULL pane), [`2026-07-07-global-read-set-self-heal-on-full-recompute.md`](./2026-07-07-global-read-set-self-heal-on-full-recompute.md) (replace-not-union)

## 1. Context

A live-state resource refreshes because the system knows which tables its loader
reads. Nobody declares that list — it is *observed*. Every query a loader issues
passes through one chokepoint (`pool.query`), the compiled SQL text is scanned
for the tables it reads, and those become the resource's read-set. A write to
any of them recomputes the resource.

The scanner only recognises a table name written **double-quoted**. Drizzle's
ORM always emits quoted identifiers, so ORM reads are fine. A hand-written
`` sql`…` `` template usually is not quoted — you write `FROM chord_answers`,
because that is how you write SQL. The query returns the right rows, so the
surface looks correct on first load. But the table was never recorded, so writes
to it push nothing. **The surface silently serves stale data until the page is
reloaded.** Nothing fails, nothing warns, and no Debug surface distinguishes it
from a healthy resource.

This was hit building the chord trainer's progress panel: the side panel stayed
stale after every saved round until each table name in
`plugins/apps/plugins/chord/plugins/progress/server/internal/progress.ts` was
put in quotes. That file now carries a comment telling the next author to quote
their table names — the weakest rung of the fix ladder, reaching only whoever
opens that one file. The trap is still there for everyone else.

Worth noting what the original L3 design expected. It said raw SQL and CTE
aliases "fall back to coarse over-capture, which is explicitly acceptable" —
i.e. the anticipated failure was recording *too many* tables, costing a wasted
recompute. The real failure is the opposite: raw SQL records **too few**, which
costs correctness. The premise is wrong in exactly the direction that matters.

**Goal:** make the spelling irrelevant, so there is no rule left to remember and
no next instance of this bug.

### Blast radius today: zero

A full sweep of every live-state loader found **no resource currently
degraded**. The two raw-SQL loaders that could have been are already hardened by
hand — `chord.progress` (quoted, with the warning comment) and the page
sidebar's `docOrderPaths` (interpolates the drizzle table object `${_blocks}`,
which renders quoted, with the same comment). Roughly 90 other unquoted-SQL
sites exist repo-wide, all in endpoints, jobs, DDL trigger bodies and write
paths, none of which the read-set touches.

So this change **adds no table dependency to any resource today** and creates no
new recompute traffic. It is pure removal of a trap, and it lets the two
warning comments be deleted.

## 2. Root cause

`plugins/database/server/internal/client.ts`, `extractReadTablesFromSql`
(~line 153):

```ts
const re = /\b(from|join|delete\s+from)\s+"([^"]+)"/gi;
```

Called from `installQueryWrapper`'s query path (~line 311) under
`currentCallerKind() === "loader"`, feeding `recordReadTables` →
runtime-profiler's `readSetIndex` / `lastLoaderReadSet`
(`plugins/infra/plugins/runtime-profiler/core/recorder.ts`). That index backs
`tableToResources()` in `resource-runtime/core/runtime.ts`, which
`applyDbChange` uses to route a change-feed event to the resources that must
recompute, plus the persisted `tables_read` used for L2 cold-boot catch-up.

The `"([^"]+)"` group is the whole bug: no fallback, no diagnostic, an unmatched
table simply is not there.

For a plain push resource with **no `identityTable`**, this is the *sole*
routing path, so an unquoted read is a total miss. For a resource that declares
`identityTable` (chord.progress does), the scoped path still fires on its own
identity table and the read-set is the catch-all for everything else — so the
miss is partial, which is how the chord panel could update on some writes and
not others.

Why it stays invisible afterwards: the recorder only flushes a loader's tables
when `ctx.tables.size > 0`, and the Debug → Read-set pane
(`plugins/debug/plugins/read-set/web/components/read-set-view.tsx`,
`computeCeiling`) skips any resource with `readSetBases.length === 0` as "loader
never ran". A resource whose capture failed completely looks exactly like one
that has not loaded yet.

## 3. Design

### 3a. Match unquoted names too

Widen the extractor to accept a bare identifier after `FROM` / `JOIN`, with
three guards. Shape, not final text — keep it readable and pin it with tests
rather than golf it:

- **`DISTINCT FROM` is not a FROM clause.** Postgres's `IS DISTINCT FROM`
  operator is followed by an expression, and `\bfrom\s+<ident>` matches it. This
  is not hypothetical: there are seven sites, and one of them is *inside a live
  loader* — `page-doc-order.ts:86` has `AND u.cursor IS DISTINCT FROM u.page_id`.
  Guard it the same way `delete\s+from` is guarded today.
- **A candidate immediately followed by `(` is a function call.** Drops
  `FROM unnest(...)` and `CROSS JOIN LATERAL (...)`, both of which appear in the
  chord file.
- **Strip a leading `ONLY`.** `FROM ONLY tasks` would otherwise capture `ONLY`
  and miss `tasks` entirely. No current use in the repo; it costs one alternation
  to not be a future silent miss.

Schema-qualified names: keep only the relation part when the schema is `public`
(`public.tasks` → `tasks`, matching the change-feed's `TG_TABLE_NAME`), and
**drop a non-`public` qualified name entirely**. Concretely: `jobsListResource`
is a real loader reading `FROM graphile_worker._private_jobs` unquoted. The
change-feed structurally excludes that schema and the resource drives its own
`notify()`, so capturing it would add a table that can never fire — which the
Debug pane would then report as a silent FULL. Dropping it is correct, not lossy.

### 3b. Filter unquoted candidates against the relations that really exist

Widening over-captures: CTE names, subquery aliases, and anything else that can
follow `FROM`. That is not cosmetic noise. The read-set feeds the Debug →
Read-set pane, which flags a resource as **silent FULL** the moment its read-set
contains a table outside the change-feed's covered origins. Phantom names would
light up that pane for every resource and destroy the one surface that exists to
spot this class of bug.

`page-doc-order.ts` is the proof: a live loader whose recursive CTE contains
`FROM up u`. Naive widening adds `up` to the pages resource's read-set. So:

**An unquoted candidate is kept only if it names a relation that exists in the
`public` schema. A quoted candidate passes through unfiltered, exactly as today.**

That asymmetry is what makes the change safe to land:

- Nothing that works today changes behaviour — quoted capture is byte-identical.
- The read-set can only grow, so the `read-set-shrink` guard
  (`plugins/debug/plugins/read-set-shrink/`) files no reports and no resource
  loses a dependency.
- Before the relation set is loaded, and on the central runtime (its own
  `resources.ts`, never touches this pool), the holder is absent → unquoted
  candidates are dropped → today's exact behaviour. A loader that runs in that
  window self-heals on its next FULL recompute, because `lastLoaderReadSet` is
  replace-not-union.

One residual over-capture stays possible: a CTE named after a real table
(`WITH tasks AS (…) SELECT * FROM tasks`). That records a phantom dependency —
an extra recompute, never a missed one — which is the direction the extractor's
own doc comment already declares acceptable. Say so in the comment so a future
reader does not mistake it for a new bug.

### 3c. Load the relation set at boot, in the database plugin's own barrier hook

No cross-plugin seam is needed. `client.ts` lives inside
`plugins/database/server/`, and that plugin's `onReadyBlocking`
(`plugins/database/server/index.ts`) already runs migrations → derived-tables →
derived-views **sequentially in one hook**, precisely so the order is
guaranteed. Appending one step there gives an authoritative post-DDL snapshot
with no new holder in `server-core/core` and no import-cycle question:

```sql
SELECT c.relname::text AS relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
```

House style is `plugins/database/plugins/admin/server/internal/catalog-plan.ts`
(`relkind IN ('r','p','m')`); we add `'v'` because loaders legitimately read the
derived views (`tasks_v`, `attempts_v`, …), which the change-feed already
expands base-table changes onto via `internal/view-deps.ts`.

**This placement is deliberately not change-feed's.** change-feed does its
`information_schema` work (`buildViewDeps`, `setRelationResolver`,
`setFeedExemptTables`) in **`onReady`** — after the ready barrier, when the
gateway may already be routing traffic. Those three tolerate it because their
defaults are inert. Putting the relation set in database's `onReadyBlocking`
instead closes that window rather than inheriting it, and it sits immediately
after the DDL that defines the relations.

Remaining ordering detail: the barrier is graph-driven by `dependsOn`, so
change-feed's own `onReadyBlocking` runs *after* database's and creates
`live_state_changelog` inside it. No loader reads the changelog, so missing it
is harmless — but exporting `refreshKnownRelations(db)` from
`@plugins/database/server` and calling it at the end of change-feed's
`onReadyBlocking` costs three lines and removes the caveat. change-feed already
imports that barrel, so no new edge and no cycle.

### 3d. Close the transaction hole at the same chokepoint

Queries issued on a client checked out via `pool.connect()` — the path drizzle's
`db.transaction()` takes — bypass the `pool.query` wrapper entirely, so a loader
reading inside a transaction records **no** tables at all. Same silent-staleness
class, different spelling ("I wrapped it in a transaction"). It is currently
documented in `plugins/database/CLAUDE.md` only as a *timing* gap.

Latent today: no loader uses `db.transaction()` (all ~52 sites are mutation
handlers, jobs, migrations and DDL rebuild; a grep for files containing both
`loader:` and `db.transaction(` returns nothing). The ambient
`AsyncLocalStorage` context *does* survive into the transaction, so the gap is
narrowly "the checked-out client's `.query` is never wrapped".

Fix: factor a small `wrapClientQueryForReadSet(client)` and apply it on **all
three** `pool.connect()` return paths — interactive, context-less, and the
background one that goes through `armLease`. Capture is gated on
`currentCallerKind() === "loader"` regardless of lane, so an interactive-lane
transaction is exactly as exposed as a background one.

**Constraint:** this file holds the deadlock-victim retry, the lane-gate
arithmetic and the `BACKGROUND_TX_MAX` + `BACKGROUND_QUERY_MAX` ≤
`POOL_MAX - RESERVED_INTERACTIVE` invariant. The diff stays strictly to the
read-set line — no timing spans, no gate wiring, no `armLease` slot accounting.
The `[acquire]`/timing bypass documented in `plugins/database/CLAUDE.md` stays
out of scope.

### Why not the alternatives

- **A `./equin check` banning unquoted names in `sql` templates** (rung 3)
  — enforces a rule instead of removing it, and ~90 legitimate unquoted sites
  exist (studio's table inspector, graphile_worker job admin, page write paths).
  A static check cannot tell a loader path from an endpoint path, so it would be
  either permanent-allowlist noise or wrong. The runtime gate
  (`currentCallerKind() === "loader"`) is the only thing that knows.
- **A declared `reads: [table]` on `executeRows` / `executeOne`** (rung 2) —
  relocates the footgun: add a `JOIN`, forget the declaration, resource goes
  stale again, now with no inference left to catch it. Strictly worse than
  today's uniform gap, because it creates a *second* failure mode
  (declared-then-drifted) that looks correct.
- **Requiring drizzle table-object interpolation (`FROM ${chordAnswers}`)** —
  the true rung-1 answer, but unenforceable here: the lint infra loads rule files
  through jiti, which cannot resolve `@plugins/*`, so a rule cannot name the type
  it would need to inspect. It also cannot express legitimate hand-written CTEs,
  `LATERAL`, or catalog joins.
- **Asking Postgres (EXPLAIN / pg_stat_statements)** — exact, but a second round
  trip on the hot read path this very file rations with lane gates, for a
  dependency index that is allowed to over-approximate.

## 4. Files to change

| File | Change |
| --- | --- |
| `plugins/database/server/internal/client.ts` | Widen `extractReadTablesFromSql` (§3a); add the module-local relation holder + `setKnownRelations` / `loadKnownRelations(db)` / `refreshKnownRelations(db)` beside it; wrap the checked-out client's `query` for read-set capture on all three `pool.connect()` paths (§3d). Rewrite the block comment — it currently states the quoting requirement as fact. |
| `plugins/database/server/index.ts` | Call `loadKnownRelations(db)` as the last step of `onReadyBlocking`, after `rebuildDerivedViews`; add the new helpers to the barrel's export line. |
| `plugins/database/plugins/change-feed/server/index.ts` | Call `refreshKnownRelations(db)` at the end of `onReadyBlocking`, after `rebuildTriggers`, so `live_state_changelog` is included. |
| `plugins/database/server/internal/client.test.ts` | Extend the existing `describe("extractReadTablesFromSql")`; add a transaction-path block. |
| `plugins/apps/plugins/chord/plugins/progress/server/internal/progress.ts` | Delete the now-false "quoting is load-bearing" comment. Keep the quotes — correct either way. |
| `plugins/page/plugins/editor/server/internal/page-doc-order.ts` | Same: delete the comment citing `extractReadTablesFromSql`. |
| `plugins/database/CLAUDE.md` | The `pool.connect()` note frames the bypass as timing-only; now that read-set capture crosses it, say what still bypasses and what no longer does. |

## 5. Tests

Extend `describe("extractReadTablesFromSql")` in `client.test.ts` — its five
existing write-target cases must keep passing. The relation holder is a module
singleton, so **reset it in `afterEach`** or state leaks across the file.

1. Unquoted `FROM chord_answers` / `JOIN chord_rounds` captured when both are in
   the known set — the actual incident.
2. Unquoted candidate absent from the known set is dropped (CTE / alias).
3. `FROM up u` from `page-doc-order`'s recursive CTE yields nothing.
4. **`u.cursor IS DISTINCT FROM u.page_id` captures nothing** — pin by name, so a
   future regex tweak cannot silently reintroduce it.
5. `FROM unnest(…)`, `CROSS JOIN LATERAL (`, `FROM (SELECT …)` yield nothing.
6. `DELETE FROM chord_answers` (unquoted) still excluded as a write target;
   unquoted `INSERT INTO` / `UPDATE` likewise.
7. Mixed quoted and unquoted in one statement — both captured, deduped.
8. `FROM public.tasks` → `tasks`; `FROM graphile_worker._private_jobs` → nothing.
9. `FROM ONLY tasks` → `tasks`.
10. No holder installed → unquoted dropped, quoted still captured (the boot-window
    and central default — pins the "byte-identical to today" guarantee).
11. New block: a query on a `pool.connect()` client feeds `recordReadTables` when
    the caller kind is `loader`, on the interactive and background paths, using
    the existing fake-pool harness.

## 6. Verification

1. `./equin build` (background, per the build rule in CLAUDE.md).
2. `./equin test plugins/database`.
3. Drive the real bug: open the chord trainer, play a round, confirm the progress
   panel updates with no reload. Then — to prove the fix rather than the
   pre-existing quotes — temporarily unquote the table names in `progress.ts`,
   rebuild, and confirm it *still* updates.
4. Open Debug → Read-set and confirm the silent-FULL list has **not** grown. This
   is the check that §3b is doing its job; `page` and `jobsListResource` are the
   two to look at, since they carry the CTE alias and the non-public schema read.
5. `query_db` on `live_state_snapshot` to confirm `tables_read` is unchanged for
   existing resources (the blast radius is zero — a change here means the filter
   is letting something through).
