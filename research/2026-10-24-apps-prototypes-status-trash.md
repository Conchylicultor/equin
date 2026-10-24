# Prototypes: deleted is a status, not a move

## Context

Deleting a prototype today renames its folder into `<prototypes>/_trash/<id>/`
(`files/shared/trash.ts`). From that moment the id names nothing: an open
canvas, a saved present link, a conversation chip and the watcher all keep
asking for it, and the `prototypes.history` / `prototypes.picks` loaders throw
`no such prototype` — a server-caught crash report for an ordinary user action
(report: `prototypes.history: no such prototype: proto-1792786780-p2j9n0`,
which the user had just deleted). Restoring means `mv` by hand; automated
sessions are refused (403) because the agent-write ledger cannot put a moved
folder back.

Make the class of error inexpressible instead of guarding each reader: a
deleted prototype **stays a prototype**. The folder stays where it is; deletion
is a field of its existing status record. Every id that ever existed keeps
resolving, the gallery hides deleted ones by default, a Trash view lists them
with Restore, and the canvas says "This prototype was deleted" with Restore.

Not `infra/trash`: that ledger lives in each instance's Postgres DB (per
worktree fork), while prototypes are host-global and shared by every worktree
and main — a delete from a worktree deploy would land in the wrong ledger. The
per-prototype record store is already host-global and already undone for
automated sessions.

## Design

### Record (`files/core/status.ts`, `files/shared/status.ts`)

- `PrototypeStatus` gains `deletedAt: string | null` (ISO instant; schema
  default `null`, so every existing `_status/*.json` still parses). `equal`
  compares it too.
- Two change types:
  - `PrototypeStatusChange` (the PUT body, unchanged: `done?`, `pinned?`) —
    a client cannot write a timestamp.
  - `PrototypeStatusEdit` = `PrototypeStatusChange & { deletedAt?: string | null }`
    — what the store folds (`applyPrototypeStatusChange` takes it). Only the
    server builds `deletedAt` edits.
- `statusOf` / `NO_PROTOTYPE_STATUS` gain `deletedAt: null`.

### Endpoints (`files/core/prototypes.ts`, `files/server/internal/status.ts`)

- `DELETE /api/prototypes/:name` (`deletePrototype`) — writes
  `{ deletedAt: now }` through the status store, recorded in the
  `prototype-status` agent-write ledger like any status write. **No more 403**:
  an automated session's delete is put back at the end of its run. Deleting a
  deleted prototype is a no-op (keeps the first `deletedAt`). 404 for no folder.
- `POST /api/prototypes/:name/restore` (`restorePrototype`, new) — writes
  `{ deletedAt: null }`, same ledger. 404 for no folder.
- Both move from `handlers.ts` to `status.ts` (they are status writes) and
  notify `prototypes.statuses` like the PUT.
- `shared/trash.ts` (`trashPrototype`, `PrototypeNotFoundError`) is deleted.

### Legacy `_trash/` (`files/shared/legacy-trash.ts`)

`adoptLegacyTrash(root)`: for every `_trash/<id>/` — record
`deletedAt = <its ctime>` in the status store (the rename into `_trash` set
it; deterministic, so racing backends write the same value), then rename the
folder back to `<root>/<id>`. Status first, so the folder never reappears as
live. A lost race (ENOENT on rename) is skipped; a live folder already at
`<root>/<id>` throws loudly (a broken assumption, never overwritten). Run from
the files server's `onReady` before the watcher starts. `TRASH_DIR_NAME` stays
(in this file) for `isInternalDir`, so `_trash` is still never served. Kept as
long as branches with the old delete exist; a later cleanup can drop it.

### Gallery (`gallery/web`)

- `PrototypeGalleryRow` gains `deletedAt: string | null` (joined in
  `joinGalleryRows`).
- The gallery DataView shows rows with `deletedAt === null` only; its header
  gains a **Trash** button (count of deleted, omitted at 0) opening the new
  Trash pane.
- **Trash pane** (`prototypesTrashRoute`, segment `trash`, parent the gallery
  route, declared in `shell/core/routes.ts` beside the others): a DataView of
  the deleted rows, same fields plus **Deleted** (date, default sort desc), same
  thumbnails; activating a card opens the canvas; item actions are a new
  `PrototypeTrashActions` slot whose one contribution is **Restore**. Empty
  state: "Trash is empty." The gallery DataView rendering is factored into one
  component both panes use.
- **Delete** (card and detail header): no confirm dialog any more — the delete
  is reversible — but a toast "Deleted “<title>”" with **Undo** (restore). The
  header action goes back to the gallery after deleting (as today). On a
  deleted prototype the header action is **Restore** instead.

### Canvas (`canvas/web/components/prototype-detail.tsx`)

A deleted prototype opens normally, with a `DeletedBanner` floated over the
canvas (beside `ProblemBanner`'s pattern): "Deleted <relative time>" +
**Restore** (calls `restorePrototype`). Reads `prototypeStatuses`; renders
nothing while pending (no claim either way). Present needs nothing: its link
keeps working.

### CLI (`files/cli/list.ts`)

`prototype list` hides deleted prototypes and ends with
`N deleted prototype(s) not shown` when there are any. `log`, `options`,
`checkpoint`, `restore` keep working on a deleted id.

### Unchanged on purpose

History, picks, thumbnails and checkpoints: a deleted prototype still exists,
so they need nothing. Their loaders still throw for an id that never existed.
The watcher fix (no history re-read for a vanished folder) stays: a folder can
still be removed by hand.

## Files

- `files/core/status.ts`, `files/core/prototypes.ts`, `files/core/index.ts`
- `files/shared/status.ts`, `files/shared/legacy-trash.ts` (new),
  `files/shared/trash.ts` (deleted)
- `files/server/internal/status.ts`, `files/server/internal/handlers.ts`,
  `files/server/index.ts`
- `files/cli/list.ts`
- `shell/core/routes.ts`
- `gallery/web/{slots.ts,panes.tsx,index.ts}`,
  `gallery/web/components/{prototype-gallery.tsx,delete-prototype.tsx}`,
  new `gallery/web/components/trash.tsx`, `gallery/web/internal/gallery-fields.tsx`
- `canvas/web/components/prototype-detail.tsx`
- Docs: `files/CLAUDE.md` (DELETE route, Status), `gallery` description,
  `prototypes/CLAUDE.md` if it mentions `_trash`.

## Verification

- `./equin test plugins/apps/plugins/prototypes` — extend `shared/status.test.ts`
  (deletedAt fold, old files parse) and add `shared/legacy-trash.test.ts`
  (adopt moves back + records, lost race, collision throws).
- `./equin build` (checks).
- Browser on the worktree deploy: delete a throwaway prototype from a card →
  toast Undo restores; delete again → gone from gallery, listed in Trash;
  open it from Trash → banner, Restore → back in the gallery. The automated
  session's writes are undone by the ledger at the end of the run.
- `p2j9n0` (in `_trash/` today) is back on disk and listed in Trash after boot.
- No `prototypes.history` / `prototypes.picks` "no such prototype" reports.
