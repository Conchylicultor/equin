# Custom DataView column deletion — collision-proof ids + cascade cleanup

## Context

Deleting a custom DataView column today only rewrites the per-surface config: the
`deleteColumn` action in the definitions controller filters the column out of the
`customColumns` config_v2 key and writes it back. Nothing touches the
`data_view_custom_values` DB table, so **every per-row value for that column stays
behind**, keyed by its now-unreferenced `columnId`. Two distinct problems follow:

1. **Reappear (a correctness bug).** If a *new* column is later created with the
   **same id**, those stale rows silently re-attach to it. This is only possible
   because column ids are weak: `columnId()` returns
   `cc-${Math.random().toString(36).slice(2, 10)}` — ~41 bits, not collision-proof.
2. **Accumulation (storage waste).** Orphaned rows are unreachable but sit in the
   table forever, growing without bound.

The clean fix treats these as separate concerns and fixes each at its root:

- **Reappear** is a *weak-id* symptom → make id reuse **structurally impossible**
  by switching to `crypto.randomUUID()` (the established browser-safe unique-id
  idiom in this repo). A new column can then never share a deleted column's id, so
  orphaned rows can never re-attach — no cleanup logic is needed to prevent
  reappearance, and pre-existing `cc-…` orphans (never regenerated) are permanently
  inert.
- **Accumulation** is a *lifecycle* gap → have the definitions controller (the
  single owner of column lifecycle) **cascade the value deletion** when a column is
  removed, so orphans never accumulate going forward.

No sweep of pre-existing orphans: with collision-proof ids they are harmless dead
rows, and reconciling them would require the server to read every surface's
config_v2 doc to compute the live `columnId` set — disproportionate to the
low-stakes data.

## Current shape (confirmed)

- **Definitions controller** — `plugins/primitives/plugins/data-view/plugins/custom-columns/web/internal/use-custom-column-defs.ts`
  - `columnId()` (lines 20-22): weak random id generator.
  - `deleteColumn` (lines 114-119): `commit(mirror.filter((c) => c.id !== id))` — config-only, no value cleanup.
  - Signature `useCustomColumnDefs(descriptor)` — **does not currently receive the `dataViewId`**.
- **Values store** — table `data_view_custom_values`, PK `(dataViewId, rowKey, columnId)`, in `.../custom-columns/server/internal/tables.ts`.
- **Existing upsert/delete-on-empty endpoint** — mirror this exactly:
  - Core contract: `.../custom-columns/core/internal/endpoints.ts` (`setCustomColumnValue`, `SetCustomColumnValueBodySchema`).
  - Server handler: `.../custom-columns/server/internal/handle-set-custom-column-value.ts`.
  - Web hook: `useSetCustomColumnValue()` in `.../custom-columns/web/internal/use-custom-column-values.ts` (fire-and-forget `useEndpointMutation`).
  - Route registration: `.../custom-columns/server/index.ts` `httpRoutes`.
  - Live resource recomputes automatically via the **L4 DB change-feed** on any write to the table — no `notify`/`dependsOn` needed.
- **Controller call site has the id** — `.../custom-columns/web/components/custom-columns-setting.tsx`: `CustomColumnsFieldsSetting` already reads `storageKey` from `useDataViewSettings()` (and `storageKey` *is* the `dataViewId` — it's what `useCustomColumnValues(dataViewId)` and the field-extension `{ storageKey, rowKey }` key on). It just isn't threaded into the controller yet.

## Part A — Collision-proof column ids (fixes reappear structurally)

**File:** `.../custom-columns/web/internal/use-custom-column-defs.ts`

Replace the id generator (keeping the `cc-` prefix, whose documented purpose is to
namespace custom-column ids away from consumer `FieldDef` ids in the shared schema):

```ts
// was: return `cc-${Math.random().toString(36).slice(2, 10)}`;
function columnId(): string {
  return `cc-${crypto.randomUUID()}`;
}
```

`crypto.randomUUID()` is available in browser web code here (localhost is a secure
context; precedent: `data-view/web/internal/filter-tree-ops.ts:18`,
`fields/enum/.../enum-options-editor.tsx:22`). Existing `cc-<8char>` ids in
committed configs keep working unchanged — this only affects newly created columns,
and the two id spaces never collide.

*(Out of scope but worth flagging to the user: the sibling generators in
`use-sort-presets.ts`, `use-filter-presets.ts`, and `view-core/.../use-views-config.ts`
share the same weak pattern. Not touched here; a follow-up could unify them.)*

## Part B — Cascade value deletion on column removal (fixes accumulation)

Mirror the existing `setCustomColumnValue` endpoint end-to-end.

1. **Core contract** — `.../custom-columns/core/internal/endpoints.ts`

   ```ts
   export const DeleteCustomColumnValuesBodySchema = z.object({
     dataViewId: z.string(),
     columnId: z.string(),
   });
   export type DeleteCustomColumnValuesBody = z.infer<typeof DeleteCustomColumnValuesBodySchema>;

   /** Delete every per-row value for one column across a surface (column removal). */
   export const deleteCustomColumnValues = defineEndpoint({
     route: "POST /api/data-view/custom-values/delete-column",
     body: DeleteCustomColumnValuesBodySchema,
   });
   ```
   Export both from `core/index.ts` alongside the existing symbols.

2. **Server handler** — new `.../custom-columns/server/internal/handle-delete-custom-column-values.ts`

   ```ts
   export const handleDeleteCustomColumnValues = implement(
     deleteCustomColumnValues,
     async ({ body }) => {
       const { dataViewId, columnId } = body;
       await db.delete(_dataViewCustomValues).where(
         and(
           eq(_dataViewCustomValues.dataViewId, dataViewId),
           eq(_dataViewCustomValues.columnId, columnId),
         ),
       );
     },
   );
   ```
   (Same shape as `handleSetCustomColumnValue`'s delete branch, minus the `rowKey`
   predicate so it clears the column across all rows. The change-feed refreshes the
   live resource automatically.)

3. **Register the route** — `.../custom-columns/server/index.ts`

   ```ts
   httpRoutes: {
     [setCustomColumnValue.route]: handleSetCustomColumnValue,
     [deleteCustomColumnValues.route]: handleDeleteCustomColumnValues,
   },
   ```

4. **Web hook** — `.../custom-columns/web/internal/use-custom-column-values.ts`, mirroring `useSetCustomColumnValue`:

   ```ts
   export function useDeleteCustomColumnValues(): (args: DeleteCustomColumnValuesBody) => void {
     const { mutate } = useEndpointMutation(deleteCustomColumnValues);
     return useCallback((args) => mutate({ body: args }), [mutate]);
   }
   ```

5. **Thread `dataViewId` into the controller + cascade in `deleteColumn`** — `use-custom-column-defs.ts`

   - Signature: `useCustomColumnDefs(descriptor, dataViewId: string)`.
   - Call `const deleteValues = useDeleteCustomColumnValues();` at the top.
   - `deleteColumn` cascades before the optimistic config write:

     ```ts
     const deleteColumn = useCallback(
       (id: string) => {
         deleteValues({ dataViewId, columnId: id });
         commit(mirror.filter((c) => c.id !== id));
       },
       [commit, mirror, deleteValues, dataViewId],
     );
     ```
     Fire-and-forget matches the existing cell clear (`setCustomColumnValue` with
     `value: ""`); the mutation surfaces errors loudly on failure. Because ids are
     now UUIDs, even a failed delete can never cause reappearance — the worst case
     is a single leaked row, identical to a failed cell-clear today.

6. **Pass `storageKey` at the call site** — `.../custom-columns/web/components/custom-columns-setting.tsx`

   `CustomColumnsFieldsSetting` already has `storageKey`; forward it into `Fields`,
   which passes it as the new `dataViewId` arg:

   ```tsx
   return <Fields descriptor={descriptor} storageKey={storageKey} />;
   // ...
   function Fields({ descriptor, storageKey }: { descriptor: ...; storageKey: DataViewId }) {
     const { defs, ...actions } = useCustomColumnDefs(descriptor, storageKey);
     ...
   }
   ```

## Files to change

- `.../custom-columns/core/internal/endpoints.ts` — add contract + schema.
- `.../custom-columns/core/index.ts` — export them.
- `.../custom-columns/server/internal/handle-delete-custom-column-values.ts` — **new** handler.
- `.../custom-columns/server/index.ts` — register the route.
- `.../custom-columns/web/internal/use-custom-column-values.ts` — add `useDeleteCustomColumnValues`.
- `.../custom-columns/web/internal/use-custom-column-defs.ts` — UUID id gen; `dataViewId` param; cascade in `deleteColumn`.
- `.../custom-columns/web/components/custom-columns-setting.tsx` — thread `storageKey` into the controller.

(No `tables.ts` / migration change — schema is unchanged.)

## Verification

1. `./equin build` (from the worktree dir). No new migration expected.
2. Drive the flow on a DataView surface with custom columns (e.g. a `/tasks` or
   Sonata library view) via Playwright / `e2e/screenshot.mjs`:
   - Add a custom column, type a value into a row's cell.
   - Confirm the row landed:
     `query_db: SELECT column_id, count(*) FROM data_view_custom_values GROUP BY column_id;`
   - Open Fields (settings gear), delete the column.
   - Re-run the query → **no rows remain for that `column_id`**.
3. New-id check: add a column, note its id shape — confirm it's `cc-<uuid>` (not
   `cc-<8char>`), so a subsequent add can never collide with a prior deletion.
4. `./equin check` (type-check + boundaries).
