# DataView `attach`: supervised tasks nest under their supervisor in the Queue

Task: task-1793320482-9jhu41 (parent task-1793317229-mbfj5s landed the `managedBy` field, commit 156dd73528).

## Context

A supervisor files tasks and watches them. Each of those tasks then shows in the sidebar Queue as its own top-level row, and moves between Queue and Working according to its own status. The user wants them shown as **expandable child rows under the supervisor's row**. They should move between sections with the supervisor: a child's own status does not decide its section, and only the supervisor counts toward the section count. It must be **controllable per view**.

Today's DataView can't do this:
- `aggregate` (one representative row plus a ×N badge) keeps `members` on the entry, but nothing renders them.
- `hierarchy` is table-only (`nestsHierarchy`). It is typed exclusive with `paging` (`core/internal/types.ts:~1698`), and it turns off fold and manual order. The Queue needs paging (the Done section) and `manualOrder` (rank drag).

So this is a new generic DataView capability. It is **not** a relaxed `hierarchy`. A hierarchy is the source's own structure: rank, moves, creates, and a tree pipeline. What the Queue needs is lighter: a row **attaches** beneath another row *if that row is loaded*, and otherwise stays where it is.

Decisions (user, 2026-10-30):
- A child waiting on the user (`waitingFor` set: a question or a permission prompt) **leaves the nesting** and shows as its own top-level row until it is answered.
- Children start **expanded**.

## Design

### 1. `managerTaskId` reaches the row (watch plugin)

- `taskManagerShape` (`plugins/tasks/plugins/orchestration/plugins/watch/core/internal/manager.ts`) already stores `managerTaskId`. Only the `managedBy` presence is exposed today.
- Add `exposes.fields: { managerTaskId: { label: "Managed by task" } }` beside `presence`. `ExposesDecl` allows both, and the ids are distinct.
- The wire value is `string | null`, where null means the user's own task.
- It lands in `$columns` on every list that reaches a task. In the Queue it is hidden and not groupable (`QUEUE_OVERRIDES`, `queue-fields.ts`). It renders as a task id chip wherever it is shown.

### 2. DataView core: `attach` (`plugins/primitives/plugins/data-view`)

```ts
/** A row drawn beneath another row of the same view WHEN that row is loaded —
 *  never a source structure (that is `hierarchy`). Safe over a partial window. */
export interface DataViewAttachConfig<TRow> {
  /** The row's identity in the attach relation (several rows may share one). */
  getKey: (row: TRow) => string | null;
  /** The key of the row it hangs beneath; null ⇒ top-level. */
  getParentKey: (row: TRow) => string | null;
  /** Children open unless the view's expand map says otherwise. Default false. */
  defaultExpanded?: boolean;
}
```

- `DataViewProps.attach?`. `DataViewRowEntry` gains `children?: readonly DataViewRowEntry<TRow>[]`.
- Typing: `attach?: never` on the hierarchy variant of the in-memory origin union. It is also refused (`never`) on a live `source` in v1, because there sections and order are server-side.
- New pure module `web/internal/attach.ts`:
  - `resolveAttach(rows, attach)` walks each row's parent chain with a visited set. A missing parent, a self-parent or a cycle all mean **top-level**, never a throw: the manager relation is derived from watches, so A↔B can happen.
  - It returns the roots, plus the children grouped by parent key, each child keeping its original flat index (for `rowKey(row, i)`).
  - `attachRoots(rows, attach)` gives the `roots` nesting mode.
- **Pipeline** (`use-data-view-sections.ts`, ~l.639-675):
  1. Split the attached rows out *before* `partitionIntoSections`. Only roots are partitioned, ranked and aggregated. So a child rides with its parent's group for **any** `groupBy`, and its own field value is ignored. This is exactly the "moves with the supervisor" rule.
  2. Then partition, rank and aggregate as today.
  3. Hang each child group under the first root entry whose rows (`entry.members ?? [entry.row]`) contain the parent key.
     - Child order is flat order, which already carries the active sort, then `manualRank` when it is set.
     - Each child list is aggregated with the same `aggregate` config, reusing `aggregateSections` on a synthetic section.
     - The same rule applies recursively for multi-level nesting.
  4. `foldSections`: children never take a `limit` slot. `makeFoldKeep` recurses into `children`, so a selected child keeps its parent.
  5. Section count counts top-level entries only. If any growable (paged) row is attached, the exact `paging.total` count drops to `atLeast`. This is the same rule `aggregateSections` already applies.
- **Per-view control: reuse `ViewState.nesting`** (the "Sub-items" setting: `nested | flat | roots`).
  - `nested` attaches the children.
  - `flat` ignores `attach`: every row sits in its own section.
  - `roots` hides attached rows.
  - Gating changes:
    - A new view-type flag `nestsAttach` (set on `list`).
    - `attachActive = attach && viewType.nestsAttach && nesting === "nested"` (`data-view-body.tsx` ~597).
    - `attach` goes into `renderProps` only while active (~1380). The roots filter goes into the `rows` memo (~606), beside `rootRows`.
    - `hostSettings` (body ~1631, `data-view.tsx` ~464) offer the Sub-items setting when either `hierarchy` or `attach` is set. The `filterScope` part stays hierarchy-only (`sub-items-settings.tsx` ~50).
  - Views without `nestsAttach` (table, gallery, icons) draw flat in v1. That is safe.
- **Expand state** uses the view's `expanded` map with a prefixed key `attach:<entryKey>`, so it doesn't collide with the list's `detail` disclosure (`list-view.tsx:579`).
  - Effective open is `expanded[k] ?? (containsSelected(entry) || defaultExpanded)`. A selected child under a collapsed parent is then still revealed and scrolled to.
- **Paging safety**: `viewportTargets` (body ~1163) reports the first and last visible keys in read order. An attached *paged* row hung far from its page would pin every page in between live.
  - Rule: a row for which `paging.isPaged(row)` is true is **never attached** (enforced in `resolveAttach`).

### 3. List view rendering (`plugins/list/web/components/list-view.tsx`)

- `renderEntry` (~565) returns the parent `ListEntry`, then (when open) an indented stack of child `ListEntry`s.
  - The children sit **outside** `ManualOrderRow`, so dragging a child never drags its parent.
  - They have `rank={null}` and no `DropRow`, so they are neither sortable nor drop targets. `manualOrderItems` / `paintedSequence` (~1256) only see `section.entries`, so they stay top-level by construction.
- The indent reuses the tree indent token. The disclosure is an `IconButton` with `expandIcon` / `collapseIcon` in the row's actions (the precedent is the detail toggle ~1093), always visible, with a child count when collapsed.
- `VirtualRows` measures dynamically, so a taller item is fine. Child props are passed as primitives so `ListEntry`'s memo holds.

### 4. Queue consumer (`conversations-view/plugins/data-view/plugins/queue`)

```ts
const QUEUE_ATTACH: DataViewAttachConfig<QueueRow> = {
  getKey: (r) => r.taskId,
  getParentKey: (r) =>
    r.section === "done" || r.waitingFor != null ? null : managerTaskIdOf(r),
  defaultExpanded: true,
};
```

- `sidebar-queue.tsx` passes `attach: QUEUE_ATTACH`.
- `getKey` is separate from `QUEUE_AGGREGATE.getKey`, because that one is null outside pinned / queued / working.
- A Done child is never attached. This is the paging rule, and it is also the right UX: finished work goes to Done.
- When the supervisor ends, its watch ends and `refreshTaskManagers` clears the row, so its children become top-level on their own.
- **Rank flags fix** (`use-queue-rows.ts` ~286-307):
  - `isTop`, `isBottom` and `canStepDown` are computed over `pinnedGroups` / `waitingGroups`. A nested child would still occupy a slot there, so the step arrows would be wrong.
  - Compute those indices over the groups that stay top-level (the same predicate as `getParentKey`, shared as one helper in the plugin).
  - The neighbour-based reorder on the server is unaffected.

## Critical files

- `plugins/tasks/plugins/orchestration/plugins/watch/core/internal/manager.ts`: expose `managerTaskId`.
- `plugins/primitives/plugins/data-view/core/internal/types.ts`: `DataViewAttachConfig`, `children`, the prop, union exclusions, the `nestsAttach` flag on the view contribution.
- `plugins/primitives/plugins/data-view/web/internal/attach.ts` (new) and `use-data-view-sections.ts`, `fold-sections.ts`.
- `plugins/primitives/plugins/data-view/web/components/data-view-body.tsx`, `sub-items-settings.tsx`, `data-view.tsx`.
- `plugins/primitives/plugins/data-view/plugins/list/web/components/list-view.tsx` (and its contribution: `nestsAttach: true`).
- `plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/queue/web/components/{sidebar-queue.tsx,use-queue-rows.ts,queue-fields.ts}`.
- Docs: data-view `CLAUDE.md` (an `attach` section, contrasted with `hierarchy` and `aggregate`), `core/internal/nesting.ts` doc (Sub-items now also covers `attach`), `watch/CLAUDE.md`. Also fix the stale "aggregate NOT implemented" comment at `types.ts:~1072`.

## Verification

- Unit tests (`./equin test plugins/primitives/plugins/data-view`):
  - `attach.test.ts`: the orphan stays top-level; a cycle and a self-parent both go top-level; multi-level; a paged row is never attached.
  - `use-data-view-sections.test.ts`: a child rides its parent's section under `groupBy`; the count excludes children; `atLeast` downgrade; the aggregate inside children; manual rank order among children.
  - `fold-sections.test.ts`: a selected child keeps its parent, and children take no limit slot.
- jsdom (`data-view/plugins/list/web/__tests__`):
  - Children render indented, and the disclosure toggles `attach:<key>`.
  - `nesting: flat` / `roots` behave as described.
  - A child has no drag handle.
- Queue: a unit test of the rank flags with a hidden child (`use-queue-rows` / classify tests).
- Watch: `watch.test.ts` checks that `managerTaskId` is exposed on a task row.
- `./equin check` (type-check, boundaries, docs in sync), then `./equin build`.
- Real data via the `browser_*` tools on my build:
  1. Start a supervisor run that files 2 tasks.
  2. The sidebar Queue shows one supervisor row with expanded children, and moves Queue → Working with it.
  3. A child asking a question pops out as its own row.
  4. The Sub-items setting set to Flat restores today's layout.
  5. Rank drag still works on top-level rows.
  - Screenshot each step.
