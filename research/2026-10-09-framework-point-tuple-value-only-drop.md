# Point tuples drop a value-only change to a non-member

## Context

A `:rows` (point) subscription holding an id that is **not** a member of its collection reloads
that id on every write to its row, even a write that cannot make it a member. The cause is in
`shapeForTuple` (`plugins/framework/plugins/resource-runtime/core/runtime.ts` ~:6355). Its point
branch keeps every requested id in `affected ∪ valueOnly`, member or not. The window/alias branch
beside it already drops a value-only host its snapshot does not hold, as long as the tuple is
quiescent.

Found during the pages.tree migration (`research/2026-10-08-global-page-tree-and-agents-routed.md`).
`useBlockTarget` subscribed `pages.tree:rows` on content-block ids, so each typing projection
(about once a second) cost a `:rows` load of a row that can never be a page. That reader was fixed
at the hook. Any other point reader of a non-member id still pays one load per write to that row.

Goal: one shaping rule for every membership kind. A value-only change to a host the tuple does
not hold loads nothing while the tuple is quiescent. The proof is a real-Postgres differential
oracle, including a positive control where the row does enter.

## Why the drop is sound (verified by reading the code)

A change is `valueOnly` for a tuple in two cases. Either it reached the tuple only through
value-role routes, or it was a `U` whose `unchanged` set covers every column in its membership
use's `moves`. So soundness rests on one fact: a point tuple's `moves` include every column that
decides membership.

- **Point membership is the id set ∧ the collection's base `where` ∧ its required joins.**
  - For `all` collections, `scopedSql(ids, "absent")` reads `WHERE where AND pk IN ids`
    (`plugins/infra/plugins/query-resource/server/internal/compile-alias.ts` ~:427).
  - For window collections, `pointQuery` (`.../arm-plan.ts` ~:460) does the same.
  - Client filters and defaults never reach `:rows` (`network/live/server/internal/serve-collection.ts` ~:186).
- **`moves` is derived once, in `routedReads` (`arm-plan.ts` ~:323).** It covers the base
  `where` columns, the order columns, and the `on` columns of the joins read as membership.
  - A point tuple passes the same `where` (`arm-plan.ts` ~:435).
  - An `all` collection's `:rows` shares the whole set's `uses` map (`compile-alias.ts` ~:546), a superset.
  - A rollup join is `MEMBERSHIP_ANY`, meaning every column. A function `where` without `whereReads` reads every column.
- **The point snapshot is exactly the members the loader returned.**
  - It is seeded on sub-ack (`runtime.ts` ~:5447, and never regressed past `baseVersion`) and on every FULL drain.
  - It is evicted at N→0 and never persisted (`membershipBounded`).
  - `diffKeyedScopedMembership` (`keyed-diff.ts` ~:232) records no entrant for a requested id the refill does not return.
  - A membership drain whose loads all fail (the scoped refill, then its FULL fallback) has consumed
    its pending, so a snapshot left as it was could miss the entrant it admitted. It evicts the
    snapshot instead (`drainMembershipFull`; a persisted alias's kept snapshot excepted), so the
    tuple is not quiescent and its next change is a FULL re-seed.
  - So "not in the snapshot" means "not a member" on every path.
- **The only stale window is a drain that is admitting the host.** The existing quiescence guard
  covers it: no pending, not draining, snapshot present (`RegistryEntry.draining`, ~:1027).
  Point tuples simply start honouring it.
- **Example: pages.tree** (`plugins/page/plugins/editor/server/internal/page-rows.ts`) has
  `where = type = page ∧ deletedAt IS NULL`, so `moves = [createdAt, deletedAt, type]`.
  - Typing into a paragraph (a `data`-only `U`) is value-only. It is dropped for a non-member.
  - A turn-into-page (`type`) or a trash/restore (`deletedAt`) stays membership. It is loaded.

## Change

### 1. `shapeForTuple`: one rule, point restriction first (`runtime.ts` ~:6345)

Restructure the function so the membership kind only narrows the candidate sets. The quiescent
value-only rule then applies to every kind:

```ts
const membership = entry.membership!;
let { affected, valueOnly, deleted } = outcome;
if (membership.kind === "point") {           // a point tuple holds only its own ids
  const ids = new Set(membership.idsOf(params));
  affected = keep(affected, ids); valueOnly = keep(valueOnly, ids); deleted = keep(deleted, ids);
}
const snapshot = entry.snapshots?.get(pk);
const quiescent = snapshot !== undefined && !entry.pendingNotifies.has(pk) && !entry.draining.has(pk);
for (const id of valueOnly) if (!quiescent || snapshot.has(id)) affected.add(id);
return { kind: "scoped", affected, deleted,
  unresolved: quiescent ? outcome.unresolved : outcome.unresolved.map(u => ({ ...u, role: "membership" })) };
```

- The point branch now also lifts unresolved reverse routes to `membership` when the tuple is not
  quiescent. Today it passes them through as they are. That was harmless only because
  `reverseWithin` ignored the role for point tuples (see §2).
- Rewrite the header comment as one rule: "a point tuple first keeps only its own ids; then,
  whatever the kind…".
- `idsOf` throwing behaves as today: it propagates to the caller's report → FULL path.

### 2. `reverseWithin`: value-role point readers resolve within their members (`runtime.ts` ~:4783)

The same leak exists through reverse routes. Today a value-role reverse resolution for a point
tuple is bounded by the whole requested set, so a lookup-table write can still load a non-member.

- **Membership role:** keep `idsOf(params)` as the bound (an entrant may come in).
- **Value role:**
  - With a snapshot, bound by `idsOf(params) ∩ snapshot keys`, the members.
  - Without a snapshot, bound by `idsOf(params)`, as today.
- The shape mirrors the window arm, and the non-quiescent lift from §1 keeps the race safe.

No change to `routing.ts`, the compiler, or `moves`: the router already reports `valueOnly`
correctly, and only the shaping was asymmetric.

## Tests

### Runtime unit tests (`plugins/framework/plugins/resource-runtime/core/runtime-table-routing.test.ts`)

- **`describe("moves — a membership use's membership-neutral U")` (:837).** Turn it into a
  `describe.each` over `kind: "window" | "point"`. A point tuple's params are an id set that
  includes a non-member (for example `{ ids: "h1,h4" }` with h4 outside the predicate). Each of
  the six cases then runs for point too:
  - a non-member's neutral `U` loads nothing;
  - a `U` on a moving column stays a candidate entrant (the positive control);
  - the quiescence guard holds while a pending is open;
  - the admitting-drain race ends fresh (via `park()`);
  - an unknown `unchanged`, an `I` and a `D` stay membership;
  - a reverse route resolves within the members, or unbounded when it touches a moving column.
- **"point membership: …" (:1023).**
  - Flip the assertion that a value-role ext write to h3, a requested non-member, loads `["h3"]`. It now loads `[]`.
  - Add a member's ext write that still loads that member.
  - The reverse-route `resolveLog` assertion changes to `within: ["h1"]` (members only) for the value-role reader.
- **Value-role non-member ack (:405).** Add a point twin: loads `[]`, the writer still gets its ack, and no version moves.

### Differential oracles (real Postgres, real change feed)

**`plugins/page/plugins/editor/server/internal/pages-tree-oracle.test.ts`**

Subscribe a second `:rows` tuple over `[A, P]`, where P is a content paragraph: the exact
`useBlockTarget` shape. Assert its view equals the FULL load restricted to those ids after every
step, at an exact cost:

1. **typing** (a `data`-only `U` on P) → `rowLoads: []`. This is the regression; today it loads `[P]`.
2. **positive control: turn P into a page** (a `type` `U`) → `rowLoads: [{ ids: [P] }]`, and P enters the view.
3. **typing on P, now a member** → P is refilled.
4. **turn P back into content** → an exit, and P leaves the view.
5. **trash, then restore, a non-member content block in the set** (a `deletedAt` `U`) → it stays membership and loads, but nothing enters.

**`plugins/network/plugins/live/server/internal/serve-collection-all-oracle.test.ts`**

Add a non-member id to the watched point set, or add a third `:rows` tuple. Then:

- the scripted value-only write (title, child aggregate) on that row costs no point load;
- its where-flip back in is an entrant (a positive control on a second schema, with a joined child aggregate).

Existing exact-cost assertions that change are updated, never loosened.

## Verification

```bash
./equin test plugins/framework/plugins/resource-runtime
./equin test plugins/network/plugins/live
./equin test plugins/infra/plugins/query-resource
./equin test plugins/page/plugins/editor
./equin check
./equin build   # backgrounded
```

Then, on the deployed worktree: open a page, type in a paragraph, and confirm `pages.tree:rows`
shows no loads, using the runtime profile (`get_runtime_profile`) or the live-state debug panel.

## Files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts`: `shapeForTuple`, `reverseWithin`, comments.
- `plugins/framework/plugins/resource-runtime/core/runtime-table-routing.test.ts`
- `plugins/page/plugins/editor/server/internal/pages-tree-oracle.test.ts`
- `plugins/network/plugins/live/server/internal/serve-collection-all-oracle.test.ts`
