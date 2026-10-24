# Bounded working-set resource contract — design

> **Update 2026-09-23:** the raw `windowResourceDescriptor` / `pointResourceDescriptor`
> factories named below no longer exist. Their codec moved into
> `windowQueryResourceDescriptor` / `pointQueryResourceDescriptor` (`infra/query-resource/core`),
> the only factories now; live-state keeps the descriptor types and hooks. See
> `research/2026-09-23-global-live-state-hygiene.md` §1.

**Parent direction:** [`research/perfs/2026-07-18-bounded-working-set-architecture.md`](./perfs/2026-07-18-bounded-working-set-architecture.md)
(the thrashing-cliff mechanism and the principle: *an interaction's working set must be
O(visible/changed), never O(total state)*). That doc is philosophy + sequencing; **this doc is the
contract design and migration plan**, grounded in a fresh code + data pass (2026-07-18). Where the
two disagree, this doc's corrections (below) supersede.

## Context

Under host memory pressure one pane navigation takes minutes (measured 2026-07-17:
`deliver:conversation-categories` sub-second → 393 s, page load 506 s, main resident 66–150 MB of a
~700 MB footprint) because parts of the live-state pipeline sweep O(total application state):
full-collection loader runs, full-value serialization on the persist/boot paths, and full-array
client materialization. The fix is a per-resource migration to a **row-shaped, delta-synced,
bounded-membership** resource contract — deliberately Zero-*compatible* in shape (a resource ≅ a
windowed query over a row table) so every migration is a step toward a sync-engine endgame, while
the Zero pilot itself stays **frozen** per the recorded decision
(`research/2026-07-02-global-comms-structural-fixes.md` Track 2; `plugins/database/plugins/zero/CLAUDE.md`).

## What the exploration corrected (own conclusions, superseding the direction doc where noted)

1. **The wire is already row-shaped and delta-synced.** Keyed resources ship
   `{upserts, deletes, order?}` deltas (`resource-runtime/core/keyed-diff.ts`), with L2 scoped
   recompute (`ctx.affectedIds`) and M5 incremental membership (`scopedMembership`). The contract
   does NOT need a new wire protocol or client cache — it needs to **bound membership**.
2. **There is no in-memory full-value warehouse.** `RegistryEntry` holds per-pk *hashes*
   (`hashSnapEncoder`, ~16 B/row), not values; full values are built transiently per recompute and
   discarded. The heap cost is **churn** (build + serialize on delivery/persist), confirmed by the
   07-16 A3 heap attribution (~97 MB JS self of a 352–469 MB footprint). Direction-doc rule 1
   ("stop warehousing values in the heap") is therefore about killing the *transient* full-value
   builds, not evicting a cache that doesn't exist.
3. **The offenders are not aggregations — they are unbounded flat collections.** Direction-doc
   rule 2 ("make derived-tables the norm") mostly does not apply: `conversation-categories` is a
   flat single-table SELECT (not the re-aggregating loader the doc assumed); the two genuine
   rollups (`attempt_conv_agg`/`attempt_push_agg`, `task_latest_conversation`) are ALREADY on the
   `derived-tables` primitive. The binding rules are **windowing (rule 4) + row-shape (rule 1)**.
   `derived-tables` stays the tool for real rollups; a windowed resource *over* a rollup is natural.
4. **The top rate×cost offender is `notifications`, not conversation-categories** (measurement
   below). conversation-categories' 393 s span was thrashing-cliff amplification of a mid-size
   unbounded resource, plus a client-side O(n) `.find()` per sidebar row per render.
5. **The persist path is a first-class offender**: `bootCritical` resources FULL-recompute + persist
   the full jsonb value on *every* change **regardless of subscriber count**
   (`live-state-snapshot`), and the boot snapshot ships ~1.8 MB of full collections to every client
   pre-paint.

## Measurement pass (main `singularity` DB, 2026-07-18)

`live_state_snapshot` value sizes × `live_state_changelog` churn (24.7 h window, 20,910 rows):

| Resource | Value | Rows | Churn | rate×cost verdict |
|---|---|---|---|---|
| `notifications` | 138 KB | 1,387 | **14,348 U-statements/day** (count/lastSeenAt bumps) | **#1**: every U forces FULL recompute (`recompute:{full}` — the `dismissed=false` mutable-membership where) + full 138 KB persist ⇒ ~2 GB/day rebuild+persist churn |
| `pushes` | **525 KB** | 3,042 | low (~34 I/day) | **#1 by size**: `mode:"push"`, NO where/limit/identityTable — full-table re-select + full re-broadcast per push; largest boot payload |
| `attempts` | 448 KB | 3,561 | `conversations` U ≈ 1,120/day cascades | tree/graph-shaped (see Decisions) |
| `tasks` | 445 KB | 3,793 | ~130 I+U/day | tree-shaped (see Decisions) |
| `conversation-categories` | 73 KB | 2,688 | INSERT per classification ⇒ FULL membership re-diff | unbounded growth + O(n) client point-read per sidebar row (`useCategoryFor` `.find`) |
| `conversation-progress` | 66 KB | 2,603 | 64 U/day | twin of categories |
| `config-v2.values`, `page-block-doc`, `build.history`, `conversations-active` | — | — | — | already bounded (O(1) reads / per-key params / LIMIT 50 / M5-filtered) — not offenders |

Ranking instruments (all exist, reuse for every phase's re-validation):
`pg_column_size(live_state_snapshot.value)`, `get_runtime_profile` loader stats,
`GET /api/resources/_debug` (`loaderStats.ratePerMin`, `readSet`, `subShortCircuits`),
live-state-churn monitor `noopRate`.

## The contract: bounded-membership keyed resource

**One primary shape.** A keyed resource (wire + client cache unchanged) whose **membership is a
bounded selector carried in the sub params**, with two kinds:

- **ordered window** — `{limit, cursor?, filter?}` → `WHERE … ORDER BY … LIMIT n`, membership
  maintained incrementally (below). For hot lists ship **fixed-cap windows only** (no user
  cursor/filter surface until a consumer actually paginates).
- **explicit point** — `{ids}` → `WHERE pk IN (ids)` — O(1) per-row reads.

The **mail-inbox endpoint+tick** pattern (`data-view/server-query` + revision tick +
`useServerDataSource`) stays the documented **secondary** shape for deep infinite-scroll long tails
(mail inbox, all-conversations history). It already ships and is already O(window); don't rebuild it.

Why this and not "generalize the endpoint+tick": (a) it is the Zero-compatible shape — consumers
keep `useResource`-family APIs and row deltas, so a later sync engine can take over the read path
without reshaping consumers; (b) the delta wire, client merge (`mergeKeyedDelta`), version
counters, sub-batch replay, and watermark rules all apply per `(key, paramsKey)` — **a window is
just a params tuple**, so no new frames, versions, or epochs; (c) it is the *smallest* diff: it is
M5 `scopedMembership` with the unbounded `orderOf` replaced by a bounded `windowIdsOf` — the
existing M5-vs-`limit` incompatibility (`query-resource` throws on `scopedMembership`+`limit`)
exists only because today's `orderOf` is unbounded.

### Client API (`plugins/primitives/plugins/live-state`)

```ts
// core/resource.ts — web-safe. Still keyed under the hood; schema stays z.array(element).
type WindowParams = { w: string } | { ids: string }; // encoded selectors (ResourceParams are strings)

windowResourceDescriptor<El>(key, elementSchema, keyOf, opts?: {
  defaultLimit?: number; point?: true; bootCritical?: true;
}): ResourceDescriptor<El[], WindowParams> & { keyed: { keyOf } }

// web — thin wrappers over useResource; cache shape unchanged.
useWindowResource(resource, { limit?, cursor?, filter? })   // El[]
usePointResource(resource, id)                              // El | null — no array, no O(n) find
```

### Server API (`plugins/infra/plugins/query-resource`)

```ts
windowQueryResource(descriptor, {
  from, identity: { table?, pk },
  select?, where?,            // server-fixed scope
  orderBy?,                   // window total order; PK tiebreaker auto-appended
  window?: { defaultLimit, maxLimit, filterColumns? },
  point?: { by: PgColumn },
  edges?: Edge[],             // rel() cascades, unchanged
})
```

The compiler derives: (1) the **windowed loader** (`where ∧ filter ∧ seekPredicate`, orderBy,
LIMIT — O(window)); (2) the **point loader** (`pk IN ids` — the existing scoped loader exposed as a
sub); (3) **`windowIdsOf(params)`** — bounded ordered id list (M5 `orderOf`, bounded); (4)
**`tailCursorOf`** — the window's last-row keyset tuple, kept beside the snapshot for the boundary
skip.

### Server runtime (`resource-runtime/core/runtime.ts`)

`ServerResourceOptions.membership` generalizes (and subsumes) `scopedMembership`:

```ts
membership?:
  | { kind: "window"; windowIdsOf; tailCursorOf }   // bounded M5
  | { kind: "point" }
```

- `drainMembershipScoped` generalized: membership-affecting change → `windowIdsOf(params)`
  (O(window)) → the **existing** `diffKeyedScopedMembership` against the per-window snapshot;
  entered ids scoped-refilled (O(entered)), leavers ship as deletes, `order` = bounded id list.
  In-place changes skip `windowIdsOf` (same cost model as M5). Working set:
  **O(window ∪ changed)** — the full value is never built.
- **Boundary skip**: a scoped change whose ids are all outside the snapshot AND whose keyset tuples
  sort past `tailCursorOf` is a no-op for that window — a write deep in the collection never
  touches a small window's working set.
- **`point` kind**: change-feed ids ∩ subscribed id-set → scoped upsert/delete; no ids query at all.
- `scopedMembership` stays as a thin alias (= unbounded window) so `conversations-active`/`-system`
  are byte-identical. Windowed entries use `hashSnapEncoder` (no persistence ⇒ no
  `retainSnapEncoder` carve-out needed).
- Watermark rule B′ holds: a membership delta asserts the full bounded `order` ⇒
  watermark-eligible; an in-place scoped upsert ships none. Version short-circuit, sub-batch,
  gate-after-dedup: unchanged per `(key, paramsKey)`.

### Keyset extraction (layering prerequisite)

Promote the pure field-agnostic keyset machinery (`buildSortKeys`, `seekPredicate`,
`orderByClauses`, `keyValuesOf`, cursor codec) out of
`plugins/primitives/plugins/data-view/plugins/server-query/` into a new leaf primitive
(`plugins/primitives/plugins/keyset/`); `server-query` keeps the `FilterGroup`→SQL compiler and
re-imports. This keeps `query-resource` from dragging the data-view type graph into every migrated
resource.

### Persistence / boot: the DB is the warehouse

**Migrated resources are NOT persisted** (`shouldPersist` excludes membership-bounded resources,
generically — never by name):

- Deletes the largest jsonb rows AND the "FULL recompute + persist on every change with zero
  subscribers" churn (the notifications 2 GB/day).
- No catch-up needed for these keys (nothing persisted to reconcile); reconnect re-subscribes the
  window and gets a fresh bounded sub-ack with a fresh watermark.
- **boot-snapshot** serves a windowed `bootCritical` resource by running its bounded
  default-window loader via the existing `loadResourceByKey` fallback — O(window) under the read
  gate. Point-only resources are simply not boot-critical (post-mount hydration — decided below).
- Fallback **only if measured** boot latency under squeeze is unacceptable: a generic per-row
  `snapshot_rows(key, pk, row jsonb)` table maintained at write time. Do not build speculatively.

## Reused verbatim (the point of the design)

`keyed-diff.ts` (all three diffs + encoders) · WS frames + client merge + version guard ·
`flushNotifies` DAG + serialize-once broadcast · single-flight + gate-after-dedup + version
short-circuit + sub-batch/per-tab replay · `applyDbChange`/change-feed routing · `rel()` cascade
edges · watermark capture/Rule B′ · churn monitor · `useResource`/`ResourceView`/optimistic-mutation.

## Implementation phases

**Acceptance gate for the whole track** (from the direction doc): with the backend artificially
squeezed (`debug/paging-probe` pressure), any pane paints **< 2 s** from last-known state.

- **Phase 0 — primitive.** Extract `primitives/keyset`; add `membership` to resource-runtime +
  `windowQueryResource` to query-resource; alias `scopedMembership`. Zero behavior change for
  existing resources (runtime invariant suites green: `runtime-*.test.ts`, `keyed-diff.test.ts`,
  query-resource compile tests). New bun:test suite pinning: bounded membership delta, boundary
  skip, point routing, window-order correctness under concurrent membership churn.
- **Phase 1 — pilot trio** (covers both selector kinds + the top rate×cost offender):
  - `pushes` → ordered window (`desc(createdAt)`, defaultLimit 100, maxLimit 500); push-mode →
    keyed; drop persistence. The `attempts` `rel(pushesResource,…)` edge is unchanged.
  - `notifications` → ordered window (`dismissed=false` where + `desc(createdAt)` LIMIT ~200);
    `recompute:{full}` → window membership (a dismiss = where-flip leave, handled incrementally);
    drop persistence.
  - `conversation-categories` → point (`point: {by: parentId}`); drop `bootCritical`;
    `useCategoryFor` → `usePointResource` (O(n) `.find` → O(1) row sub).
  - *Validate:* snapshot table shrinks ~736 KB; `deliver:pushes`/`deliver:notifications` ship
    single-row deltas (churn monitor + `_debug`); notifications persist churn ≈ 0; paging-probe
    run: sidebar + pushes panes < 2 s under squeeze.
- **Phase 2 — flat lists + twins.** `conversation-progress` (point twin), `queue-ranks` /
  `conversation-preprompts` / `conversation-notes` (per ranking), `agents` if warranted.
  **Trees deferred** (decision below): `tasks`/`attempts` get retention/archive caps on done
  tasks + ended attempts to shrink the collections; a dedicated follow-up designs windowed tree
  hydration (window = expanded nodes). *Validate:* boot-snapshot assembly O(Σ windows);
  A4 controlled-pressure run reproduces the 506 s/393 s cases < 2 s.
- **Phase 3 — full sweep.** Migrate ALL remaining DB-backed collection resources by ranking
  (~25–30 mechanical migrations, parallelizable agent work once Phase 1 proves the shape).
  Long-tail scroll surfaces stay on endpoint+tick. Prerequisite for Phase 4: the windowed-tree
  design lands and migrates `tasks`/`attempts`/page tree. *Validate:* acceptance re-run on
  `singularity` live.
- **Phase 4 — delete the legacy path (the end state; avoids a permanent dual system).** Once no
  resource persists: delete the `live-state-snapshot` plugin (persist/catch-up/boot-init + its
  DB-backed harness), delete the `live_state_changelog` write from the change-feed triggers (its
  only consumer is catch-up — this removes a per-write amplifier paid by EVERY DB write today),
  delete `retainSnapEncoder` + the persisted-M5 reconstruction, retire the `scopedMembership`
  alias (one membership algorithm remains), and drop boot-snapshot's persisted-jsonb fast path
  (boot = bounded default-window loaders, one code path). Add the fence: a `./equin check`
  that rejects any DB-backed keyed resource without a bounded membership (or an explicit,
  justified `recompute:{full}` over a provably-bounded query) — so the unbounded shape cannot be
  reintroduced. **Gate:** boot re-validated under paging-probe squeeze with loaders replacing the
  jsonb read (the one capability persistence uniquely provided); fall back to the per-row
  `snapshot_rows` option (b) only if that measurement fails.

**What deliberately remains after Phase 4 (not duplication — different truth sources/access
patterns):** external/git/file resources on the ETag-revalidate contract (`edited-files`,
`commits-graph`, jsonl-events, prototypes files — no identityTable, no change-feed; already
bounded per worktree/conversation); schema-bounded scalar push ticks (revision ticks,
`mainAheadCount` — degenerate 1-row values, foldable into the contract later if desired);
endpoint+tick for deep pagination (shares the keyset primitive).

## Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — `membership` selector,
  generalized `drainMembershipScoped`, boundary skip, point routing.
- `plugins/framework/plugins/resource-runtime/core/keyed-diff.ts` — reused; possibly a
  window-order helper.
- `plugins/infra/plugins/query-resource/server/internal/compile.ts` (+ `spec.ts`) —
  `windowQueryResource`.
- `plugins/primitives/plugins/keyset/` (new leaf) ←
  `plugins/primitives/plugins/data-view/plugins/server-query/` (extraction).
- `plugins/primitives/plugins/live-state/core/resource.ts` + `web/` —
  `windowResourceDescriptor`, `useWindowResource`, `usePointResource`.
- `plugins/database/plugins/live-state-snapshot/server/internal/persist.ts` — exclude
  membership-bounded resources.
- `plugins/infra/plugins/boot-snapshot/server/internal/handle-boot-snapshot.ts` — bounded
  default-window boot loads.
- Pilot: `plugins/tasks/plugins/tasks-core/server/internal/resources.ts` (`pushes`),
  `plugins/shell/plugins/notifications/{shared,server}` ,
  `plugins/conversations/plugins/conversation-category/{shared,server,web}`.

## Verification

1. `bun test plugins/framework/plugins/resource-runtime/core` + the DOM hazard suites
   (`bun run test:dom plugins/primitives/plugins/live-state plugins/primitives/plugins/networking`).
2. `./equin build` → live worktree: `_debug` shows bounded `loaderStats`, single-row deltas
   in the live-state trace, snapshot rows gone for migrated keys.
3. `benchmark_boot` MCP before/after (boot-snapshot working set), `get_runtime_profile` loader
   avg/max for migrated keys.
4. Paging-probe controlled-pressure run (user-gated, A4) → pane paint < 2 s from last-known state.

## Decisions recorded (user, 2026-07-18)

- **Pilot scope: trio** — pushes (window) + notifications (window, top churn) + categories (point).
- **Trees: deferred** — retention/archive caps bound tasks/attempts first; windowed tree hydration
  is a dedicated follow-up design.
- **Point-read boot: post-mount hydration** — categories not boot-critical; avatar keeps its
  title-glyph fallback for the one bounded round-trip after mount.

## Implementation log (2026-07-18, this worktree — Phase 0 + Phase 1 landed)

Phase 0 and the pilot trio are implemented. Deviations and additions vs the design above, all
recorded from the implementing agents' reports:

- **Two descriptor factories, not one**: `windowResourceDescriptor` and `pointResourceDescriptor`
  (a union params type on one descriptor would break paramsKey identity). Codecs live ON the
  descriptor (`window.encode/decode`, `point.encode/decode`) and are the single source shared by
  hooks, boot, and the server compiler; `decode` is strict (malformed params throw — `{}` can
  never alias the default window). `defaultLimit` lives ONLY on the descriptor; the spec carries
  `maxLimit`.
- **`orderBy` is `{col, dir}` pairs, not raw SQL** — enables the auto pk tiebreaker and the
  derived order signature; a future cursor reuses the same `SortKey[]`.
- **Order-signature seam (added mid-implementation)**: `membership.window` carries an
  auto-derived `orderSignatureOf(row)`; a refilled member whose order-column signature changed is
  membership-affecting (one bounded `windowIdsOf` + membership delta with fresh `order`), while
  content-only refills stay in-place with zero ids queries. This HANDLES order-column updates
  (the notifications resurface `createdAt` bump), downgrading the "update-stable orderBy" rule to
  a cost note. No tail cursor was built — one bounded ids query is both entrant arbiter and
  tail-pull; a DELETE outside the snapshot is a structural no-op.
- **Pilot outcome — pushes**: the global window could not keep zero subscribers alive because
  commits-graph depends on `pushes` via a value-aware `map` (needs the whole value). Final shape:
  all 7 web consumers moved to a NEW `pushes-by-attempt` keyed resource (params `{attemptId}`,
  page-block-doc precedent — bounded per attempt, correct for arbitrarily old attempts, fixes the
  hasPush destructive-gating regression); the global `pushes` reverted to a param-less push-mode
  **cascade carrier** with `bootCritical` dropped (525 KB persist churn + boot payload + all
  broadcasts gone; zero subscribers). **Follow-up:** commits-graph.delta/.graph consume `pushes`
  via value-`map` (not id-based `affectedMap`), forcing one full-table pushes select per push
  (~34/day) on the carrier; converting commits-graph to id-routing retires the last O(table) read
  and possibly the carrier itself.
- **Pilot outcome — notifications**: bounded window (defaultLimit 200 / maxLimit 500,
  `where dismissed=false`, `desc(createdAt)`); `recompute:{full}` deleted — dismiss = membership
  exit, resurface = order-signature re-derive. The 14 K/day count-bump churn now ships in-place
  single-row deltas with no persist.
- **Pilot outcome — conversation-categories**: point resource, bootCritical dropped,
  `useCategoryFor` = `usePointResource` (O(1)); the only whole-collection reader (stats chart)
  already used its own SQL endpoint.
- **Stale-snapshot sweep (generalized)**: at boot, `clearSnapshotsExceptKeys(db, keepKeys)` with
  `keepKeys = bootCriticalKeys() \ boundedMembershipKeys()` deletes every `live_state_snapshot`
  row outside the persistable set (bounded windows, points, de-bootCritical'd and removed keys),
  before the snapshot endpoint is reachable — a migrated key can never serve its stale unbounded
  value.
- **Boot seam**: `handle-boot-snapshot` falls back to `loadResourceByKey(key,
  descriptor.defaultParams)` and the client hydrates the identical default-window tuple — pinned
  by a DOM test.

**Post-deploy validation (this worktree, 2026-07-18):** build green; `live_state_snapshot` rows
for pushes/notifications/conversation-categories swept at boot; `_debug` shows notifications as
keyed window membership (no `recompute:{full}`), the pushes carrier, `pushes-by-attempt`, and the
categories point resource; the boot snapshot no longer carries pushes/categories and notifications
is exactly 200 rows (was 1,387); sidebar category avatars hydrate via per-row point subs.
**Measurement note for Phase 2:** rank by *serialized* boot-payload size, not `pg_column_size`
(compressed TOAST understates badly — `conversation-preprompts` is 628 KB serialized vs 34 KB on
disk; current boot payload is dominated by `attempts` 1.93 MB + `tasks` 1.79 MB serialized, the
deferred trees, then preprompts 628 KB, progress 321 KB).

## Open items

- Per-row point subs (default; mirrors `page-block-doc`, absorbed by keep-alive/sub-batch) vs a
  coalesced `{ids: visible}` sub — revisit only if Phase 1 measurement shows sub-storm cost.
- Read-admit gate (`READ_LOAD_CONCURRENCY=6`): keep as-is; retune only on Phase 2 data.
- `snapshot_rows` (option b) only if measured boot latency under squeeze demands it.
- Windowed tree hydration design (tasks/attempts/pages) — follow-up doc.
- Host-layer fixes (fleet memory admission, duress-gating deploys) remain out of scope, owned by
  the host-saturation track.
