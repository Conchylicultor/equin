# Bounded-membership migration: `tasks-auto-start` (point) + `pages-starred` (window)

> Executes the two follow-ups filed by
> [`research/2026-08-18-global-scoped-membership-sweep.md`](./2026-08-18-global-scoped-membership-sweep.md)
> under Phase 2 of the bounded working-set contract
> ([`research/2026-07-18-global-bounded-working-set-resource-contract.md`](./2026-07-18-global-bounded-working-set-resource-contract.md)).

## Context

Two per-parent 1:1 side tables still ship their whole collection to every client
through the legacy unbounded `queryResource`:

| Resource | Table | Rows on main | Consumers |
|---|---|---|---|
| `tasks-auto-start` | `tasks_ext_auto_start` | 65 (of 4,250 tasks) | `useTaskAutoStart(taskId)` → `.find()` — the Queued chip on each task row, and the auto-start model select on the open task |
| `pages-starred` | `page_blocks_ext_starred` | 1 (of 80 pages) | `useStar(pageId)` → `.some()` — the two star toggles; plus `StarredField`, which reads the whole set into a `Set` to project the `starred` bool field of the `pages-sidebar` DataView |

Neither is `bootCritical`, neither carries a `dependsOn`/`rel(…)` edge, and neither
resource key is referenced outside its own plugin (verified by grep) — so both are
self-contained migrations with no cross-plugin ripple.

The problem is the shape, not today's row counts: every arm/disarm and every
star/unstar is a membership change, which under plain `queryResource` forces a
**FULL recompute of the whole table** plus a full reship to every subscriber, and
every subscriber holds an O(collection) snapshot. Both tables grow with tasks /
pages, which are unbounded.

**Outcome:** both become membership-bounded, so a write costs O(changed) and no
client ever holds the whole table. Wire shape stays a keyed row array; no new
frames, versions or epochs (a bounded selector is just a params tuple).

## The two shapes, and why they differ

Each resource gets the shape its consumers actually need. This is a deliberate
split from the sweep doc, which pencilled both in as `point`:

- **`tasks-auto-start` → point.** Every consumer asks about ONE task, and the
  answer must be exact: the launch-option binding drives a select control and a
  write, so a windowed miss would silently render an armed task as "Off" and a
  subsequent edit would be wrong. Mirrors the `conversation-categories` pilot.

- **`pages-starred` → window.** Its dominant consumer, `StarredField`, needs
  starred-ness for **every row the DataView filters over** — a point subscription
  would have to name every page id, which is O(pages), i.e. it does not bound the
  working set at all, it just moves it into a params string. What *is* bounded
  here is the favorites set itself. The sibling plugin
  `plugins/apps/plugins/pages/plugins/agent-origin` already solved exactly this
  shape — same `PageTree.Fields` slot, same `Set`-based field over an entity-
  extension marker table — with a bounded window, and its own code comment names
  `starred` as the legacy counter-example still pending migration. We mirror that
  precedent byte-for-byte.

  **Accepted boundary:** past `maxLimit` favorites the oldest-starred page reads
  as unstarred (hollow star, absent from Favorites). Sized at
  `defaultLimit: 500` / `maxLimit: 1000` — favorites are user-curated and have no
  TTL, so this is set well above the other four window precedents (200/500).

---

## Part A — `tasks-auto-start` → point

Template: `plugins/conversations/plugins/conversation-category` (shared descriptor
→ server spec → web hook). Three code files.

### A1. `plugins/tasks/plugins/auto-start/shared/resources.ts`

`queryResourceDescriptor` → `pointQueryResourceDescriptor` (same key, schema, pk).
Row schema unchanged.

```ts
import { pointQueryResourceDescriptor } from "@plugins/infra/plugins/query-resource/core";

export const taskAutoStartResource = pointQueryResourceDescriptor<TaskAutoStartRow>(
  "tasks-auto-start",
  TaskAutoStartRowSchema,
  "parentId",
);
```

Rewrite the block comment: bounded POINT resource; `point.by` **is** the identity
pk (the ext table's `parent_id`), so one subscribed id names exactly one task's
marker; the change feed routes an arm/disarm to a tuple iff the changed ids
intersect its set, so arming one task never sweeps the table. Point resources are
never `bootCritical` (recorded decision — post-mount hydration); this one already
wasn't, so nothing changes at boot.

### A2. `plugins/tasks/plugins/auto-start/server/internal/resource.ts`

`queryResource` → `windowQueryResource` with `point: { by: … }`. Projection
unchanged; no `orderBy` (point sets are unordered — callers index by id).

```ts
import { windowQueryResource } from "@plugins/infra/plugins/query-resource/server";

const t = _tasksAutoStartExt;

export const tasksAutoStartResource = windowQueryResource(taskAutoStartDescriptor, {
  from: t,
  select: {
    parentId: t.parentId,
    autoStartAt: t.autoStartAt,
    autoStartModel: t.autoStartModel,
  },
  point: { by: t.parentId },
});
```

`Resource.Declare(tasksAutoStartResource)` in `server/index.ts` is unchanged
(same call shape as `agentPagesServerResource`). All write paths
(`setTaskAutoStart`, `claimAutoStart`, `cancelAutoStartOnDropJob`,
`sweepArmedDroppedTasks`) already ride the L4 change feed — untouched.

### A3. `plugins/tasks/plugins/auto-start/web/hooks.ts`

`useResource(…).data.find(…)` → `usePointResources`. The public signature and
return type are **unchanged** (decided): `TaskAutoStartRow | null`, pending reads
as `null`.

```ts
export function useTaskAutoStart(taskId: string | null | undefined): TaskAutoStartRow | null {
  // `usePointResources` rather than `usePointResource`: the signature is
  // nullish-tolerant and a hook cannot be called conditionally. An empty id set
  // encodes to `{ ids: "" }`, which the server point loader short-circuits with
  // no query at all — the same "nothing chosen" arm as `CategoryAvatarRow`.
  const ids = useMemo(() => (taskId ? [taskId] : []), [taskId]);
  const result = usePointResources(taskAutoStartResource, ids);
  if (result.pending) return null;
  return result.data[0] ?? null;
}
```

Consumers (`queued-chip-action.tsx`, `launch-option/web/internal/binding.ts`) are
**untouched**.

**Behavioural note (not a regression):** the resource was already not
`bootCritical`, so the Queued chip already appeared after mount. It now hydrates
per task row instead of once for the list — a row scrolled into view shows its
chip one local round-trip later, then keep-alive caches it. The tasks tree
windows its rows above 100 visible rows (`VIRTUALIZE_THRESHOLD` in
`plugins/primitives/plugins/tree/web/internal/tree-list.tsx`), so the subscription
count is bounded by the visible window — the contract's decided default
("per-row point subs … absorbed by keep-alive/sub-batch").

---

## Part B — `pages-starred` → bounded window

Template: `plugins/apps/plugins/pages/plugins/agent-origin` (`pages-origin`).
Four code files plus two doc fixes.

### B1. `plugins/apps/plugins/pages/plugins/starred/shared/resources.ts`

The wire row gains `createdAt`: the compiler derives the window's order signature
from the wire row and **throws at module eval if an order column is unprojected**.

```ts
import { windowQueryResourceDescriptor } from "@plugins/infra/plugins/query-resource/core";

export const StarredPageRowSchema = z.object({
  parentId: z.string(),
  createdAt: z.coerce.date(),   // when it was starred — the window's order key
});

export const starredPagesResource = windowQueryResourceDescriptor<StarredPageRow>(
  "pages-starred",
  StarredPageRowSchema,
  "parentId",
  { defaultLimit: 500 },
);
```

### B2. `plugins/apps/plugins/pages/plugins/starred/server/internal/resource.ts`

```ts
import { windowQueryResource } from "@plugins/infra/plugins/query-resource/server";

const t = _pageBlocksStarredExt;

export const starredPagesServerResource = windowQueryResource(starredPagesDescriptor, {
  from: t,
  select: { parentId: t.parentId, createdAt: t.createdAt },
  orderBy: { col: t.createdAt, dir: "desc" },
  window: { maxLimit: 1000 },
});
```

Comment the order-stability argument, as `agent-origin` does: `pageBlocksStarred.upsert(pageId, {})`
writes `createdAt` once at insert and only ever touches `updatedAt` on conflict, so
the window's order column is UPDATE-stable by construction. Star = membership
entry, unstar = membership exit; both ship incremental deltas, never a
whole-collection recompute.

`server/index.ts`, `mutations.ts` and `routes.ts` are unchanged.

### B3. NEW `plugins/apps/plugins/pages/plugins/starred/web/internal/use-starred-ids.ts`

One shared read so the field and the toggles cannot drift, and both land on the
same `(key, paramsKey)` tuple (one subscription for the whole app):

```ts
/** The starred page ids of the bounded favorites window. */
export function useStarredPageIds(): { ids: ReadonlySet<string>; pending: boolean } {
  const result = useWindowResource(starredPagesResource);
  const ids = useMemo(() => {
    if (result.pending) return EMPTY_IDS;
    return new Set(result.data.map((r) => r.parentId));
  }, [result]);
  return { ids, pending: result.pending };
}
```

### B4. `web/internal/use-star.ts` and `web/components/starred-field.tsx`

Both swap their `useResource(starredPagesResource)` for `useStarredPageIds()`:

- `useStar`: `const isStarred = ids.has(pageId);` — the `toggle` mutation and the
  returned `{ isStarred, toggle, pending }` shape are unchanged, so `StarButton`,
  `StarRowAction` and `StarHeaderAction` are untouched. Net effect: **zero**
  per-row subscriptions where before every mount read the whole table.
- `StarredField`: `const { ids } = useStarredPageIds();`, field def unchanged
  (`id: "starred"`, `type: "bool"`, `filterable: false`, `groupable` left off).
  Its existing pending rationale ("an empty set while pending is the least wrong
  of the three options") stays valid verbatim and should be kept.

**The `starred` field id is a user-config contract** — the Favorites view is a
user-authored view instance whose filter rule is `{ fieldId: "starred",
operatorId: "is", value: true }` (`config/apps/pages/page-tree/pages-sidebar.jsonc`).
Do not rename the field or change its type.

### B5. Doc fixes (these go stale the moment this lands)

- `plugins/apps/plugins/pages/plugins/starred/CLAUDE.md` — the hand-written bullet
  "the keyed resource is the default identityTable-scoped one (a star/unstar ships
  a cheap keyed delta)" becomes the bounded window + the ≤1000-favorites boundary.
- `plugins/apps/plugins/pages/plugins/agent-origin/shared/resources.ts` (comment at
  the descriptor) — drop the "NOT the unbounded `queryResource` the sibling
  `starred` plugin uses" clause; the sibling is no longer the counter-example.
- `research/2026-08-18-global-scoped-membership-sweep.md` — append a two-line
  implementation note under "Follow-ups filed": both landed, `pages-starred` as a
  **window** rather than a point, with the reason (its whole-set consumer would
  have made the point id set O(pages)).

The autogenerated `## Plugin reference` blocks in both plugins' `CLAUDE.md` (and
`docs/plugins-details.md` / `docs/plugins-compact.md`) regenerate during
`./equin build` — do not hand-edit; the `plugins-doc-in-sync` check will
fail if they drift.

---

## Critical files

```
plugins/tasks/plugins/auto-start/shared/resources.ts              A1  descriptor → point
plugins/tasks/plugins/auto-start/server/internal/resource.ts      A2  → windowQueryResource + point
plugins/tasks/plugins/auto-start/web/hooks.ts                     A3  → usePointResources

plugins/apps/plugins/pages/plugins/starred/shared/resources.ts            B1  descriptor → window
plugins/apps/plugins/pages/plugins/starred/server/internal/resource.ts    B2  → windowQueryResource + orderBy
plugins/apps/plugins/pages/plugins/starred/web/internal/use-starred-ids.ts  B3  NEW shared read
plugins/apps/plugins/pages/plugins/starred/web/internal/use-star.ts        B4
plugins/apps/plugins/pages/plugins/starred/web/components/starred-field.tsx B4
plugins/apps/plugins/pages/plugins/starred/CLAUDE.md                       B5
plugins/apps/plugins/pages/plugins/agent-origin/shared/resources.ts        B5  stale comment
research/2026-08-18-global-scoped-membership-sweep.md                      B5  implementation note
```

Reference implementations to copy from, not reinvent:

- point: `plugins/conversations/plugins/conversation-category/{shared/schemas.ts,server/internal/resource.ts,web/internal/use-conversation-categories.ts}`
- window: `plugins/apps/plugins/pages/plugins/agent-origin/{shared/resources.ts,server/internal/resource.ts,web/components/origin-field.tsx}`
- hooks: `usePointResources` / `useWindowResource` in `plugins/primitives/plugins/live-state/web/window-hooks.ts`

No migration is generated (no schema change), no endpoint changes, no new tables.

## Verification

1. `./equin build` (`run_in_background: true`, end the turn — it also runs
   `./equin check`, which covers `type-check` and `plugins-doc-in-sync`).
   Read the verdict from `~/.singularity/worktrees/<wt>/build-status.json`
   (`status: ok`).
2. **Shapes registered.** `GET http://<worktree>.localhost:9000/api/resources/_debug`
   — `tasks-auto-start` reports point membership, `pages-starred` reports window
   membership; neither reports `recompute:{full}`.
3. **No stale L2 snapshot.** Bounded resources are never persisted and the boot
   sweep (`clearSnapshotsExceptKeys`) drops migrated keys. `query_db`:
   `select key from live_state_snapshot where key in ('tasks-auto-start','pages-starred')`
   → 0 rows.
4. **Auto-start, end to end** — `plugins/tasks/plugins/auto-start/e2e/auto-start-verify.ts`:

   ```bash
   bun plugins/tasks/plugins/auto-start/e2e/auto-start-verify.ts \
     --task <armed taskId> --expect "Opus 5"
   ```

   **Do not verify this with a blind screenshot.** A point resource hydrates
   post-mount, and on a loaded backend one tuple's sub-ack can trail its
   subscription by 10 s+; "Off" is both the pending rendering AND the genuine
   not-armed answer, so a fixed wait reports a live marker as lost. The script
   waits for the control to stop saying Off.

5. **Starred, end to end** — `plugins/apps/plugins/pages/plugins/starred/e2e/starred-verify.ts`:

   ```bash
   bun plugins/apps/plugins/pages/plugins/starred/e2e/starred-verify.ts --page <pageId>
   ```

   Reads the header star's `aria-pressed`, toggles it, waits for the flip, and
   restores the original state — so it exercises both a window membership ENTRY
   and an EXIT, which are the two paths that must ship a delta rather than a
   recompute. Safe to re-run.
6. **Churn check (the actual point of the migration).** With the Pages sidebar and
   the tasks tree open, star/unstar a page and arm/disarm a task while watching
   Debug → Live-State Health: each write should ship a single-row delta, not a
   whole-collection push.

## Implementation log (2026-08-19/20)

Landed as designed; both flows verified against the deployed worktree
(`auto-start-verify` → select settles on "Opus 5"; `starred-verify` →
`before=true after=false restored=true`, no page or console errors).

**Measured, needs a decision — the point sub count.** One page load of `/agents`
opened **176 distinct `tasks-auto-start` point tuples** and sent **704**
subscription messages (~4 re-subscriptions per tuple), where the unbounded
resource had exactly one subscription. Every sub-ack in that session landed in a
single ~12 s burst, which is what made the first screenshot read "Off".

That is the trade the contract already names as an open item ("Per-row point subs
… vs a coalesced `{ids: visible}` sub — revisit only if measurement shows
sub-storm cost"). This is that measurement, and it is on the tasks tree, whose
`VIRTUALIZE_THRESHOLD` is 100 *visible* rows — so 176 tuples means more rows are
mounting than the windowing implies. Worth its own investigation: either the
tree is mounting rows it should be windowing, or `QueuedChipAction` should read a
coalesced set for the visible rows rather than one tuple per row. Not fixed here
— it is a data-view/tree question, not a resource-shape one.
