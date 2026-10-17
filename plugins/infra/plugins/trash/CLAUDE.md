# trash

Generic soft-delete primitive: user content is never hard-deleted by a user
action — it is **trashed** (the domain flips a `deleted_at` flag; FK cascades
never fire, so descendants, side-tables, CRDT docs, and version history all
survive) and only **purged** (real `DELETE`, cascades intended) after a 30-day
grace period or an explicit "Delete permanently". Born from the 2026-07-10
sub-page cascade wipe — see
`research/2026-07-11-global-trash-soft-delete-primitive.md`.

## Model

- **`trash_entries`** — the operation ledger: ONE row per trashed **root**
  entity (`sourceId`, `rootEntityId`, `label` captured at trash time, `meta`
  opaque per-source payload). Deliberately NO FK to any consumer table (mirror
  of `entity_versions`' decoupling): the domain rows carry their own
  `deleted_at` flags, and the ledger row is the handle to restore/purge them.
- **`defineTrashSource({ id, restore, purge })`** — the consumer registry,
  mirroring `defineHistorySource` (module-level `Map` + `Registration` consumed
  in the plugin's `register: [...]`). The primitive never names a source.
  `restore(entry)` clears the domain's flags; `purge(entries)` runs the
  domain's destroy hooks then hard-deletes the roots. **A source may consume
  its own entry inside `restore`** — delete the ledger row in the same
  transaction that clears the flags (the page editor does). The lifecycle's
  delete-after-action then finds nothing, which is fine: the two are one fact,
  and a source that keeps them in one transaction keeps the invariant below by
  construction. One domain may register SEVERAL sources over one ledger
  mechanism when only the LISTING differs (the page editor's `pages` for what
  the Pages Trash shows, `page-blocks` for content-row entries that are undo +
  purge only).
- **`recordTrashEntry(tx, …)`** — MUST be called inside the same transaction as
  the domain's `deleted_at` UPDATE, so the ledger and the flags cannot
  disagree. Returns the entry id for the domain to stamp onto its flagged rows
  (e.g. `page_blocks.trash_entry_id`), making restore an exact
  `WHERE trash_entry_id = :id` with no subtree re-walk.
- **Endpoints** — `GET /api/trash/:sourceId` (for agents / curl; the UI reads
  the live collection), `POST /api/trash/:sourceId/:entryId/{restore,purge}`. A consumed (already
  restored/purged) entry is a typed `404`, never a silent no-op; an
  unregistered source id is a LOUD throw (config error). Action-before-delete
  ordering makes both retryable: a failing `restore`/`purge` leaves the entry.
- **`trashEntries` live collection** (`core/resources.ts`, key
  `trash-entries`) — the ledger as a bounded window, newest-deleted first
  (pages of 100; at most 500 rows to a reader with no viewport),
  `filterable: { sourceId, label }`; a source's trash is
  `useLive(trashEntries, { where: { sourceId } })`, or — as the Pages Trash
  dialog lists it — a DataView over
  `liveDataSource(trashEntries, { searchable: ["label"] }).scoped({ where: { sourceId } })`,
  which pages by its viewport with no depth cap. Served by
  `serveCollection(trashEntries, { from: _trashEntries })`. No hand-notify
  anywhere: the L4 change-feed on `trash_entries` moves every subscribed window
  on every mutation, in-process or not.
- **`trashPurge`** — `defineRetention` over `deletedAt` (30 days,
  `perWorktree`), using retention's `beforeDelete` seam to run each source's
  `purge` over its expired entries before the ledger sweep. This is the ONE
  place a source's domain rows are finally hard-deleted on a schedule.

## The "trashed → undoable" seam (`web`)

A trashing mutation is undoable **generically** — the fact is the same for every
source: the mutation hands back a ledger handle, undo is
`POST /api/trash/:sourceId/:entryId/restore`, redo re-runs the mutation and mints
a *new* entry. So the seam lives here, not in each delete button:

```ts
const trashWithUndo = useUndoableTrash();

await trashWithUndo({
  label: `Delete ${title}`,
  trash: () => fetchEndpoint(deleteBlock, { id: pageId }), // → Promise<TrashOutcome>
  onUndo: () => openPane(pageDetailPane, { pageId }),      // optional
});
```

- **`TrashOutcome`** (`core/schemas.ts`) is a discriminated union, never
  `{trashed, entryId?}` — a nullable id is an absorbable failure. A trashing
  endpoint declares `response: TrashOutcomeSchema` and returns
  `{ trashed: true, sourceId, entryId }` or `{ trashed: false }`.
- **`trashed: false` records nothing.** It means NOTHING EXISTED to trash (the
  id was unknown or already trashed) — never "the domain hard-deleted instead":
  user content is never hard-deleted by a user action, so a delete of a live
  row always hands back a handle. There is nothing to restore and the seam does
  not pretend otherwise.
- **The seam is source-agnostic.** It restores against whatever `sourceId` the
  mutation answered — a page delete comes back as `pages`, a paragraph delete
  as `page-blocks` — so a consumer never assumes the source.
- **Plain `useUndoRedo()`, not the scoped variant.** The thunks are pure server
  calls keyed by a ledger id — valid anywhere in the tab — so the entry rightly
  outlives the pane that recorded it (delete, navigate away, Cmd+Z still
  restores).
- **Redo reassigns the captured `entryId`.** Re-trashing mints a NEW ledger row;
  keeping the old id would make the next undo restore a consumed entry and take
  the typed 404. Load-bearing.
- **No toast, no navigation here.** Those are the consumer's job — raising a toast
  from `infra` would invert `infra → shell`. The web barrel depends only on
  `undo-redo` + `endpoints` + this plugin's own core.

## Invariants

- **An entry exists ⇔ at least one domain row carries its id** — the
  recommended rule for a source. Both halves are transactional: the flags are
  set in the same transaction as `recordTrashEntry`, and cleared in the same
  transaction that deletes the entry (restore consumes its entry). Back it in
  the domain's own schema where you can — the page editor's
  `CHECK ((deleted_at IS NULL) = (trash_entry_id IS NULL))` on `page_blocks`
  rejects a row that is flagged but names no entry. The one reachable
  exception is a purge that crashed between the row delete and the ledger
  sweep, which is why `purge` must be idempotent and a restore of an entry
  with no rows must consume it rather than fail.
- A source's `purge` must be **idempotent** (the entry sweep can retry after a
  mid-flight failure) and must itself run whatever destroy hooks a direct hard
  delete would have run — purge IS the deferred hard delete.
- Restore semantics on conflict belong to the source (re-rank, reparent, …);
  the primitive treats `rootEntityId`/`meta` as opaque.

## Tests

`server/internal/trash.test.ts` (bun:test, real DB via `db-test-fixture` +
`runMigrations`) — requires the running embedded cluster (`./singularity build`
first):

```bash
bun test plugins/infra/plugins/trash
```

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Web seam of the trash primitive: useUndoableTrash() runs a trashing mutation and records ONE entry on the tab's undo stack (undo = restore the minted trash entry, redo = re-trash and re-capture the new entry id), so every trash source gets Cmd+Z restore without hand-rolling it. Generic trash primitive: the trash_entries operation ledger, a defineTrashSource registry, list/restore/purge endpoints, the trash-entries live collection (filterable by source), and the 30-day purge sweep — so user content is soft-deleted (restorable) instead of hard-deleted, and FK cascades fire only at purge.
- Web:
  - Contributes: `IdKinds.Kind` "trash"
  - Uses:
    - `ids.IdKinds`
    - `infra/endpoints.fetchEndpoint`
    - `primitives/undo-redo.useUndoRedo`
  - Exports (types):
    - `UndoableTrash`
    - `UndoableTrashArgs`
  - Exports (values): `useUndoableTrash`
- Server:
  - Contributes:
    - `ids.kind` "trash"
    - `resource.declare` "trash-entries"
    - `resource.declare` "trash-entries:groups"
    - `resource.declare` "trash-entries:rows"
  - Uses:
    - `database.db`
    - `ids.IdKinds`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `infra/retention.defineRetention`
    - `network/live.serveCollection`
  - DB schema: `plugins/infra/plugins/trash/server/internal/tables.ts`
  - Exports (types):
    - `TrashExecutor`
    - `TrashSource`
  - Exports (values):
    - `_trashEntries`
    - `defineTrashSource`
    - `getTrashSource`
    - `recordTrashEntry`
  - Register: `defineJob('retention.trash_entries')`
  - Resources:
    - `trash-entries` (keyed, window)
    - `trash-entries:groups` (push)
    - `trash-entries:rows` (keyed, point)
  - Routes:
    - `GET /api/trash/:sourceId`
    - `POST /api/trash/:sourceId/:entryId/restore`
    - `POST /api/trash/:sourceId/:entryId/purge`
- Core:
  - Uses:
    - `fields.fieldsToZodObject`
    - `fields/date/config.dateField`
    - `fields/json/config.jsonField`
    - `fields/text/config.textField`
    - `ids.defineIdKind`
    - `ids.idKindField`
    - `ids.IdOf`
    - `infra/endpoints.defineEndpoint`
    - `infra/entities.entityRef`
    - `network/live.liveCollection`
  - Exports (types):
    - `TrashEntry`
    - `TrashEntryId`
    - `TrashOutcome`
  - Exports (values):
    - `listTrash`
    - `purgeTrash`
    - `restoreTrash`
    - `trashEntries`
    - `trashEntriesEntityRef`
    - `trashEntryFields`
    - `trashEntryIdKind`
    - `TrashEntrySchema`
    - `TrashOutcomeSchema`
- Cross-plugin:
  - Imported by:
    - `apps/pages/page-tree`
    - `page/editor`

<!-- AUTOGENERATED:END -->
