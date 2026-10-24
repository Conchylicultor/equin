# A1 Query-Resource Primitive — M1–M3 Implementation Plan

> Status: approved plan (execution). Track 1 (M1–M3) of
> [comms structural fixes](./2026-07-02-global-comms-structural-fixes.md).
> M4 (cascade `rel()` migration) and M5 (scoped membership) are follow-up tasks.

## Context

73 resource definitions exist; ~51 are SQL-shaped, yet every loader is
hand-written, `identityTable` strings are hand-authored (can drift from what
the loader reads), and only 3 resources have scoped recompute — the rest
FULL-recompute on every covered write. This plan builds a declarative compiler,
`plugins/infra/plugins/query-resource/`, that turns a constrained drizzle-based
declaration into the object the existing two-arg
`defineResource(contract, ServerResourceOptions & ScopePolicy)` already accepts
— deriving the loader, the scoped loader, `identityTable`, and the client
`keyOf` from one source. **Zero changes to `resource-runtime`.**

### Verified facts the design rests on

- Two-arg contract: `plugins/framework/plugins/resource-runtime/core/runtime.ts:696-706`;
  `ScopePolicy` (L258) = `{identityTable} | {recompute:{kind:"full",reason}}`;
  loader = `(params, ctx?: {affectedIds}) => Promise<T>|T`. Scoped keyed loads
  return a **partial array** merged into the snapshot.
- Scoping fires only for `op:"U"` with ids, when
  `change.origin === identityTable && change.identityBase === identityTable`
  (L2330-2351). INSERT/DELETE ⇒ FULL until M5.
- Client keyed merge (`live-state/web/keyed-delta-merge.ts`): when `order` is
  omitted (every scoped delta), changed rows are swapped **by id in place, no
  re-sort** — a scoped update that changes sort position stays put until the
  next FULL reships `order`. Identical to `conversationsActive` today; accepted.
- Push loaders must **ignore** `ctx.affectedIds` (a partial array would be
  pushed as the whole value). Hence the compiler emits **keyed-only**.
- `relationIdentityBase(relation)` is exported from
  `@plugins/database/plugins/derived-views/server` — maps a declared 1:1
  identity view to its base table, returns the input unchanged when unresolved
  (our loud-throw signal).
- PK derivation: `getTableColumns(table)` → the `.primary` column;
  `getTableConfig(table).name` → DDL name. `Entity.table` is a real PgTable;
  `Entity.name` is the table name; `Entity.wireColumns` is the default
  projection. (PK metadata is not on the Entity object — use getTableConfig.)
- push→keyed conversion is invisible to `useResource` consumers (both yield
  `T[]`); boot-snapshot ships full arrays for keyed the same way (sub-ack/HTTP
  fallback always full). No boot-snapshot changes.
- Test conventions: no live DB anywhere — throwaway `pgTable`,
  `new PgDialect().sqlToQuery(...)` string assertions, and the
  `runtime.test.ts` fake-ws harness for end-to-end.

## The new plugin

```
plugins/infra/plugins/query-resource/
  package.json                    # @singularity/plugin-infra-query-resource
  CLAUDE.md
  core/
    index.ts                      # web-safe barrel: queryResourceDescriptor (NO drizzle)
    internal/descriptor.ts
  server/
    index.ts                      # queryResource, rel, compileQuery, spec types
    internal/spec.ts              # QueryResourceSpec / Edge types
    internal/identity.ts          # resolveIdentity(from, identity?, select?) → {tableName, pkColumn, keyField, selectMap}
    internal/compile.ts           # compileQuery(spec) → {serverOpts, keyField, identityTableName}
    internal/rel.ts               # rel(...) → Edge (dependsOn affectedMap closure)
    internal/compile.test.ts      # SQL/derivation bun:tests
    internal/compile-runtime.test.ts  # fake-ws end-to-end bun:tests
```

### API

**core (web-safe):**

```ts
export function queryResourceDescriptor<Row, P = {}>(
  key: string,
  rowSchema: ZodType<Row>,
  pkField: keyof Row & string,
  opts?: { bootCritical?: true },
): QueryResourceContract<Row, P>;
// = keyedResourceDescriptor(key, z.array(rowSchema), [], row => String(row[pkField]), opts)
//   + { queryPk: pkField }  — records the identity field for the server assertion
```

**server:**

```ts
interface QueryResourceSpec<P> {
  from: PgTable | PgView | Entity;
  identity?: { table?: string; pk: PgColumn };   // required for PgView / override
  select?: Record<string, PgColumn | SQL.Aliased>; // default: wireColumns (Entity) or all columns
  where?: SQL | ((params: P) => SQL | undefined);
  orderBy?: SQL | SQL[];                          // static
  limit?: number;
  recompute?: { kind: "full"; reason: string };   // FULL opt-out (windowed/LIMIT resources)
  edges?: Edge[];                                 // rel() output — compiled now, used in M4
  debounceMs?: number;
  db?: DbHandle;                                  // test seam, defaults to real db
}

function compileQuery<Row, P>(spec): { serverOpts: ServerResourceOptions<Row[],P> & ScopePolicy; keyField: string; identityTableName: string | null };
function queryResource<Row, P>(descriptor: QueryResourceContract<Row,P>, spec: QueryResourceSpec<P>): Resource<Row[], P>;
// asserts descriptor.queryPk === derived keyField — LOUD throw at module eval (boot crash on drift)

function rel(upstream: Resource, upstreamTable: PgTable, keys: { fk: PgColumn; upstreamPk: PgColumn }, opts?: { signature? }): Edge;
// emits: affectedMap = ids => db.selectDistinct({fk}).from(upstreamTable).where(inArray(upstreamPk,[...ids])).map(r=>r.fk)
```

### Derivation rules

1. **Identity**: Entity → `entity.name` + `.primary` column of
   `getTableColumns(entity.table)`; PgTable → `getTableConfig().name` + primary
   column; PgView → requires `identity.pk`; `identity.table` defaults to
   `relationIdentityBase(viewName)`, **throw** if unresolved (returns view name).
   Composite PK (>1 primary, no explicit single `identity.pk`) → **throw**
   (stay on plain push defineResource).
2. **keyField**: with `select`, the projection key whose column identity-equals
   the pk column (throw if pk not projected); without, the pk's JS prop name.
3. **Full query**: `db.select(selectMap).from(rel)[.where][.orderBy][.limit]`.
4. **Scoped query** (only when `identityTable` policy): same select/where
   composed with `and(where, inArray(pkColumn, affectedIds))` — **no
   orderBy/limit** (partial refill; a limit would truncate it).
5. **Loader**: `(params, ctx) => ctx?.affectedIds && scoped ? scopedQuery : fullQuery`.
   With `recompute:{full}`, loader always runs the full query and ScopePolicy
   is `{recompute}`.
6. `mode` never set — keyed-ness comes from the contract. The compiler emits
   **keyed resources only**; push resources keep plain `defineResource`.

## Migration table

Every migration touches the descriptor file (`resourceDescriptor` →
`queryResourceDescriptor(..., pkField)`) and the server resource file
(`defineResource` → `queryResource(descriptor, {from, ...})`). Wire shape stays
`T[]` ⇒ no consumer changes. Descriptors stay in the same module (eager-graph /
boot-snapshot safety).

**K/scoped** = keyed + identityTable. **K/full** = keyed + `recompute:{full}`
(windowed LIMIT reads — scoped refill of an out-of-window row would corrupt the
snapshot; still gains Layer-1 keyed diffing).

### M2 (prove the compiler on the safe edge)

| Resource | Files | Decision | Notes |
|---|---|---|---|
| `tasksAutoStartResource` | `plugins/tasks/plugins/auto-start/{shared/resources.ts, server/internal/resource.ts}` | K/scoped | select projection {parentId,autoStartAt,autoStartModel}, pk `parentId`, identity `tasks_ext_auto_start` |
| `conversationProgressResource` | `plugins/conversations/plugins/conversation-progress/{shared,server/internal}/` | K/scoped | exercises alias rename if pk column is `parentId` exposed as `conversationId` — read source first |
| `notificationsResource` | `plugins/shell/plugins/notifications/` | K/scoped | where `dismissed=false`, orderBy desc(createdAt), pk `id`; in-place read/mute flips are the payoff |

### M3 sweep

| Resource | Plugin | Decision | Notes |
|---|---|---|---|
| `reportsResource` | reports | K/scoped | pk id, orderBy desc(lastSeenAt) |
| `slowOpsResource` | debug/slow-ops | K/scoped | Entity; heavy in-place aggregate updates — best win |
| `pluginHealthReviewsResource` | plugin-meta/plugin-health | K/scoped | pk id |
| `browserBookmarksServerResource` | apps/browser/bookmarks | K/scoped | Entity path |
| `storyGeneratedUnitsResource` | apps/story/generation | K/scoped | Entity + wireColumns default |
| `mailLabelsServerResource` | apps/mail/mailbox | K/scoped [verify array shape] | where accountId+type, pk id |
| `threadMessagesServerResource` | apps/mail/reading-pane | K/scoped [verify] | per-param `where:(p)=>eq(threadId,p.threadId)` |
| `releaseHistoryResource` | release | K/full | LIMIT 50 window, reason documented |
| `buildHistoryResource` | build | K/full | same shape |
| conversation-view ext resources (notes, turn-summary, categories, preprompts, summaries), `starredPagesServerResource` | — | [verify each] | bare-array ones → K/scoped; Map/reshape ones → SKIP |

### SKIP (reasons recorded in plan; leave as-is)

`stagedConfigDefaults` + `trackViewLive` (composite PK), `claudeCliCalls`
(append-only LIMIT window, immutable rows — revisit after M5),
`deadJobs`/`eventEmissions`/`eventTriggers`/`jobsList` (object payloads /
invalidate / non-feed schema), `workflowDefinitions`/`workflowExecutions`
(Date→ISO serialize / join), mail revision ticks + syncState (scalar/object),
`queueRanks` (two queries), scalar tick resources.

### DEFER to M4 (load-bearing cascade — do NOT touch)

Everything in `plugins/tasks/plugins/tasks-core/server/internal/resources.ts`
(conversations*, pushes, taskDetail, tasks, attempts) and
`plugins/conversations/plugins/agents/` (agents view, agentLaunches). Upstream
`dependsOn` references keep working unchanged.

Honest expected count: **12–16 keyed migrations** (the super-plan's ~34 counted
reshapes/composite-PK/aggregate resources that are not keyed-able; quality of
classification over the number — remainder recorded as SKIP reasons + follow-up
tasks).

## Test plan (M1, bun:test, no live DB)

compile.test.ts: PgTable/Entity identity derivation; full-query SQL string;
scoped SQL = where AND `pk in (...)` with no order/limit; and() composition;
per-param where; alias-rename projection (scoped where uses the column, not the
alias); recompute:full ignores affectedIds; composite-PK / view-without-pk /
unresolved-view / pk-not-projected throws; queryPk mismatch throws; rel()
affectedMap SQL matches the hand-written attempts↔conversations closure;
signature passthrough. Fake chainable db records built SQL and returns scripted
rows.

compile-runtime.test.ts (fake-ws harness like `runtime.test.ts`): sub-ack full
array; `applyDbChange(op:"U", origin=identityTable)` ⇒ one scoped keyed upsert,
no order; `identityBase !== identityTable` dropped; empty scoped set ⇒ no send;
K/full ⇒ full recompute diffed to changed rows.

## Verification (after M2 and each M3 batch)

1. `./equin build` + `./equin check` green (boundaries: no drizzle
   in core/; registry/doc in-sync; keyed-resource-scope).
2. Debug → Read-set pane: migrated resources show coveredOrigins == captured
   read-set (scoped, not silent-FULL).
3. Drive a real UPDATE on a migrated table; confirm a single-row keyed delta
   frame on the wire (live-state logs / verboseTrace), not a full array.
4. Boot-snapshot: reload, bootCritical descriptors hydrate before first paint,
   no crash reports.
5. Churn monitor quiet (no new no-op push storms).
6. Playwright drive of affected surfaces (notifications bell, bookmarks,
   slow-ops pane).

## M2 findings

- **Mutable-column `where` + identityTable scoping is UNSOUND** — resolved with
  runtime evidence (`keyed-diff.ts` L97-125): `diffKeyedScoped` merges scoped
  rows into a copy of the prior snapshot and *"`deletes` is necessarily empty"*.
  An UPDATE flipping a `where` column (e.g. `dismissed = false → true`) removes
  the row from the result set, the scoped refill returns nothing for that id,
  nothing merges, and the row sits stale in every client snapshot until the next
  FULL. Rule (recorded in the plugin CLAUDE.md + `spec.where` doc, pinned by two
  end-to-end tests): `where` on immutable-post-insert columns → K/scoped;
  `where` on a mutable column → `recompute: {kind:"full"}` (the FULL diff ships
  the disappearance as a per-row delete while in-place flips still ship as
  single-row upserts). Not statically detectable (column mutability is a
  behavioral fact), so it is a documented review-time rule. M5's scoped
  membership may relax it.
- Consequence: **`notificationsResource` migrated K/FULL, not K/scoped** as the
  M2 table above proposed — the dismiss/dismiss-all endpoints flip `dismissed`
  via UPDATE. It still gains Layer-1 keyed row diffing (read/mute flips ship one
  row). `tasksAutoStartResource` / `conversationProgressResource` are where-less
  pure side-tables → K/scoped as planned (identity tables derive as
  `tasks_ext_auto_start` / `conversations_ext_progress`; conversation-progress
  exercises the alias projection, `conversationId ← parent_id`).
- **Eager-tier scan gap fixed**: `queryResourceDescriptor` added to codegen's
  `DESCRIPTOR_FACTORIES` — `\bresourceDescriptor` does not match inside the new
  identifier, so `bootCritical: true` declared through the wrapper was invisible
  to the eager-tier / reachability scan (harmless for M2's structurally-eager
  owners, a silent boot-snapshot failure for any future app-content plugin).
- M3 heads-up: re-check every candidate against the mutable-`where` rule
  (`mailLabelsServerResource`'s `type` filter and `threadMessagesServerResource`'s
  `threadId` param are immutable → fine; anything filtering on a status-like
  column must go K/full).

## M3 batch A results

Five assigned resources; **3 migrated, 2 skipped** (both on a discovery the plan's
M3 table did not account for — see below). Per-resource:

| Resource | Files | Decision | identityTable | Evidence |
|---|---|---|---|---|
| `pluginHealthReviewsResource` | `plugin-meta/plugin-health/{shared/schemas.ts, server/internal/resource.ts}` | **K/scoped** | `plugin_health_reviews` | Entity (`defineEntity`, inline PK `id`); select-all ≡ wire schema by construction. orderBy `(pluginId, axis)` = the immutable unique-index conflict target (a re-review UPDATEs commitHash/conversationId on the same row, never its sort key) → order never goes stale; consumer order-reliance is moot. |
| `conversationCategoriesResource` | `conversations/conversation-category/{shared/schemas.ts, server/internal/resource.ts}` | **K/scoped** | `conversations_ext_category` | conversation-progress twin: alias projection `conversationId ← parent_id` (compiler keys on the alias, scoped refill filters the real column). orderBy `asc(parentId)` immutable; consumer (`use-category`) is an id-keyed lookup, not an ordered list. bootCritical preserved. |
| `starredPagesServerResource` | `apps/pages/starred/{shared/resources.ts, server/internal/resource.ts}` | **K/full** (`recompute`) | — (null) | orderBy `rank` is MUTABLE: drag-reorder UPDATEs it (`movePageStarred`), and the Favorites sidebar (`favorites-sidebar.tsx`) renders `starredResult.data` in **wire order with no client-side re-sort** → the ordering rule forces FULL (a scoped delta omits `order`, leaving the row stale-positioned). `rank` is a runtime-identity brand (`RankSchema = z.string().transform(Rank.from)`), so a plain `select({parentId, rank})` serializes identically — dropped the old `.map(Rank.from)`, no typing fight (compiler is untyped-through on the select map). |
| `reportsResource` | `reports/` | **SKIP** | — | **`ExcludeFromChangeFeed({ table: _reports })`** (reports/server/index.ts): the table is deliberately kept off the change-feed (documented anti-churn decision — a crash storm UPDATEs the hot dedupe row thousands/min; "pane hydrates on open, never live-ticks"). A keyed query-resource derives its entire value from change-feed deltas, which never fire here → the migration is a pure no-op that also declares a dead `identityTable` policy contradicting the exclusion. No behavioral change, no keyed-diff win. (Absent the exclusion it WOULD be K/scoped: no `where`, and the sole consumer — the Debug→Reports DataView — re-sorts client-side on `lastSeenAt` via its authored `lastSeen desc` views, so the mutable order-by would be safe.) Revisit only if the exclusion is lifted. |
| `slowOpsResource` | `debug/slow-ops/` | **SKIP** | — | Same as reports: **`ExcludeFromChangeFeed({ table: _slowOps })`** (slow-ops/server/index.ts), same self-amplifying-churn rationale, same hydrate-on-open behavior. (Absent the exclusion it WOULD be K/scoped: entity-backed, no `where`; the pane re-sorts client-side by `totalMs` both in-component and via its authored `totalMs desc` view, so the mutable order-by would be safe.) |

Also skip-recorded (pre-classified Record-payload reshapes; wire-shape change would
ripple into consumers): `conversationNotesResource`, `turnSummariesResource`,
`conversationPrepromptsResource`, `conversationSummariesResource`.

**Decision-rule takeaways / new finding for the orchestrator:**

- **`ExcludeFromChangeFeed` is a hard SKIP gate the plan's M3 table missed.** Two of
  the three "K/scoped" entries the plan proposed (`reportsResource`,
  `slowOpsResource`) are on change-feed-excluded tables — the keyed model is
  inapplicable. Every remaining M3/M4 candidate should be checked for
  `ExcludeFromChangeFeed` before migrating; migrating one is a no-op that plants a
  dead scope policy. Worth a `./equin check` (a keyed/query-resource whose
  `identityTable` names a change-feed-excluded table is always dead config).
- **Ordering rule, both outcomes exercised in this batch.** `starred` is the
  positive case (mutable order-by + wire-order-reliant consumer → K/full);
  `plugin-health` / `conversation-category` are the negative case (immutable sort
  key → K/scoped); `reports` / `slow-ops` would have been the "mutable order-by but
  consumer re-sorts client-side → K/scoped" case had they been migratable.

No compiler changes. `bun test plugins/infra/plugins/query-resource` stays green
(24 pass). No consumer edits — all wire shapes stay `Row[]` and export names are
unchanged.

## M3 batch B results

Six assigned resources; **5 migrated, 1 skipped**. Per-resource:

| Resource | Decision | identityTable | Evidence |
|---|---|---|---|
| `browserBookmarksServerResource` | **K/scoped** | `browser_bookmarks` | No `where`; orderBy `asc(createdAt)` insert-immutable. Consumers match by url/id, no wire-order reliance. Uses the raw exported table (select-all ≡ wire; zero server-only cols) rather than the unexported entity const. |
| `storyGeneratedUnitsResource` | **K/scoped** | `story_generated_units` | `from: entity` (wireColumns default keeps prompt/timestamps off the wire). No where/orderBy; status/output mutate in place → single-row keyed deltas are the win. Web hook filters client-side. |
| `mailLabelsServerResource` | **SKIP** | — | Loader does an async `resolveMailAccountId()` pre-query plus a cold-mailbox `return []` guard before the SELECT — not expressible as a static/sync declarative `where`. Genuine shape mismatch, not a compiler gap. |
| `threadMessagesServerResource` | **K/scoped, per-param** | `mail_messages` | `where: ({threadId}) => eq(...)` — threadId immutable (a message never moves threads); sort keys `(internalDate, id)` insert-immutable, so wire-order reliance in the message list is sound. |
| `releaseHistoryResource` | **K/full** | — | LIMIT-50 window ordered by `startedAt desc` → membership not expressible by scoped refill. bootCritical preserved; explicit 12-col select keeps `pid` off the wire. |
| `buildHistoryResource` | **K/full** | — | Same LIMIT-50 window; was push+FULL with no keyed diffing → strict improvement. bootCritical preserved. |

Note: release/build moved `currentWorktreeName()` from per-loader-call to
module-eval (static `where`) — it reads `SINGULARITY_WORKTREE`, constant for the
backend's lifetime (one instance per worktree), matching existing module-eval
env reads.

## Final tally (M1–M3)

**11 resources migrated** (auto-start, conversation-progress, notifications,
plugin-health, conversation-category, starred-pages, browser-bookmarks,
story-generated-units, mail-thread-messages, release-history, build-history):
7 K/scoped (incl. one per-param, two alias-projection, three entity-backed),
4 K/full with documented reasons (mutable-where membership, mutable order-by +
wire-order consumer, two LIMIT windows). Skips all recorded with reasons above;
the tasks-core/agents cascade is deliberately deferred to M4.

## Follow-up tasks to file after landing

- M4: tasks/agents cascade migration via `rel()` (edges replace hand-written
  affectedMaps).
- M5: opt-in scoped membership (DELETE then INSERT) — would relax both the
  mutable-`where` rule and the LIMIT-window rule.
- ~~Check: fail when a keyed resource's `identityTable` names a
  change-feed-excluded table (dead scope policy — the reports/slow-ops finding).~~
  **DONE** — implemented as a boot-time invariant, not a `./equin check`.
  A static check can't reach it: `excludedTableNames()` only populates after server
  boot (contribution registry), and query-resource-derived `identityTable`s are
  runtime drizzle values, not statically parseable. Instead the change-feed's
  `onReadyBlocking` cross-checks `scopedResourceIdentities()` (new resource-runtime
  accessor, threaded through server-core) against `excludedTableNames()` and throws
  loudly (blocks boot) on any collision — the sibling of `warnOnCoverageGaps`, which
  the plugin already documents as replacing a check that "can't reach a live DB".
  See `plugins/database/plugins/change-feed/server/internal/identity-coverage.ts`.
- Resources docgen facet only parses the flat `defineResource({key})` form —
  two-arg descriptor-form resources (most of the repo, now including all
  query-resource migrations) are invisible to the per-plugin "Resources:" doc
  lines.
- Unit-test friction: any server module transitively importing
  `@plugins/database/server` needs a `SINGULARITY_WORKTREE` env shim in tests
  (module-eval throw). Consider a shared test preload or lazy binding.
- Optional: revisit append-only windowed resources (claude-cli-calls) after M5;
  revisit `mailLabelsServerResource` if the account-resolution moves into SQL.
