---
name: Attachments — FK link tables
description: Replace polymorphic (owner_type, owner_id) with per-consumer FK link tables so owner deletion cascades to attachments automatically.
---

# Attachments — FK link tables

## Context

Today `_attachments` owns a polymorphic `(owner_type, owner_id)` pair with no foreign keys (`plugins/attachments/server/internal/tables.ts:9`). When an owner is deleted, nothing cleans up its attachments — the DB row and the on-disk file both leak. Concretely, `deleteTask` at `plugins/tasks-core/server/internal/mutations/tasks.ts:116` never calls `deleteAttachmentsForOwner`, so every deleted task that had attachments leaves garbage behind. The orphan sweep at `plugins/attachments/server/internal/orphan-sweep.ts` only catches staged uploads (`owner_id IS NULL`, 24h TTL); attached-but-owner-gone rows are invisible to it.

A simple fix is "remember to call `deleteAttachmentsForOwner` in every owner-delete path", but that's a convention any new consumer will forget. The right primitive is a DB-enforced FK cascade: each consumer declares its own link table with `ON DELETE CASCADE` on the owner side, and the orphan sweep deletes any `_attachments` row that no link table references. This also supports multi-ownership (same file attached to both a task and a future comment/crash) for free.

Only one consumer exists today (`improve` → `task`), so the migration cost is small and the pattern is validated by the existing `_taskDependencies` join table (`plugins/tasks-core/server/internal/tables.ts:53`).

## Design

### Schema shape

One link table per (attachments, owner) pair. First and only one today:

```ts
// NEW FILE: plugins/tasks-core/server/internal/schema-attachments.ts
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { _attachments } from "@plugins/infra/plugins/attachments/server";
import { registerAttachmentLink } from "@plugins/infra/plugins/attachments/server";
import { _tasks } from "./tables";

export const _taskAttachments = pgTable(
  "task_attachments",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => _tasks.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => _attachments.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.attachmentId] })],
);

// Module-load side effect: tell the attachments sweep this table references attachments.
registerAttachmentLink({ table: _taskAttachments, attachmentIdCol: _taskAttachments.attachmentId });
```

Why a new file and not `tables.ts`: `tables.ts` is explicitly a load-order leaf (see comment at `plugins/tasks-core/server/internal/tables.ts:13-20`) and cannot import from other plugins. A sibling file in the same plugin is free to import `@plugins/infra/plugins/attachments/server`.

### Attachments registry + sweep

New helper in attachments:

```ts
// NEW FILE: plugins/attachments/server/internal/link-registry.ts
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export interface AttachmentLinkSource {
  table: PgTable;
  attachmentIdCol: PgColumn;
}

const sources: AttachmentLinkSource[] = [];

export function registerAttachmentLink(source: AttachmentLinkSource): void {
  sources.push(source);
}

export function getRegisteredLinks(): readonly AttachmentLinkSource[] {
  return sources;
}
```

Re-exported from `plugins/attachments/server/api.ts` (alongside `_attachments`) so consumers can import `registerAttachmentLink` through the public barrel.

Orphan sweep rewrite (`plugins/attachments/server/internal/orphan-sweep.ts`):
- Collect registered link sources.
- Build a Drizzle `NOT IN (UNION ALL of SELECT attachmentIdCol FROM source)` query.
- Predicate: `createdAt < cutoff AND id NOT IN (<union>)`.
- Delete matching rows + unlink disk files.
- Keep TTL (grace period for upload→link race and for just-unlinked rows). Shorten from 24h to **1h** — there's no reason to keep unreferenced data around longer once the cascade is DB-enforced. Sweep already runs hourly.

The `attachments_owner_idx` and `attachments_staged_idx` (on `owner_type`/`owner_id` and `owner_id IS NULL`) go away with the columns.

### API surface

**Removed** (no callers):
- `attachAttachment()` — the `isNull(ownerId)` CAS guard disappears with the columns. Consumers insert into their own link table directly.
- `deleteAttachmentsForOwner()` — superseded by the CASCADE.
- `listAttachmentsForOwner()` — ungreppable as a cross-plugin call; web helper at `plugins/attachments/web/internal/list.ts` has no callers either (confirmed via grep).
- `POST /api/attachments/:id/attach` — no callers (`uploadAttachment` at `plugins/attachments/web/internal/upload.ts:12` only uses `POST /api/attachments`; the attach step happens server-side inside improve's submit handler today).
- `GET /api/attachments?ownerType=X&ownerId=Y` — no callers.

**Kept**:
- `POST /api/attachments` — staged upload, used by web.
- `GET /api/attachments/:id` — download, used by improve's rendered markdown link (`plugins/improve/server/internal/handle-submit.ts:82`).
- `DELETE /api/attachments/:id` — keep for now; manual-delete surface.
- `_attachments`, `getAttachment(id)` — kept; used by improve's submit validation.

**New export**: `registerAttachmentLink(source)` from `@plugins/infra/plugins/attachments/server`.

### Multi-ownership semantics

A single `_attachments` row may appear in multiple link tables (future case: same file attached to a task and a comment). It stays alive as long as **any** link row references it. When the last link goes, the sweep collects it. This is a feature, not a bug — stating it explicitly so consumers don't assume 1:1.

## Changes by file

**Attachments plugin** (`plugins/attachments/`):
- `server/internal/tables.ts` — drop `ownerType`, `ownerId`, `attachments_owner_idx`, `attachments_staged_idx`.
- `server/internal/api.ts` — delete `attachAttachment`, `deleteAttachmentsForOwner`, `listAttachmentsForOwner`. Keep `getAttachment`, `deleteAttachment`. Update `toAttachment` / shared `Attachment` type to drop owner fields.
- `server/internal/link-registry.ts` — **new**, per above.
- `server/internal/orphan-sweep.ts` — rewrite sweep predicate per above; TTL 1h.
- `server/internal/handle-list.ts` — **delete file**.
- `server/internal/handle-attach.ts` — **delete file**.
- `server/api.ts` + `server/index.ts` — drop removed exports, add `registerAttachmentLink`, drop the two deleted HTTP routes from `httpRoutes`.
- `shared/types.ts` — drop `ownerType`, `ownerId` from `Attachment`.
- `web/internal/list.ts` — **delete file** (no callers).

**Tasks-core plugin** (`plugins/tasks-core/`):
- `server/internal/schema-attachments.ts` — **new**, per above. Owns `_taskAttachments` and calls `registerAttachmentLink`.

**Improve plugin** (`plugins/improve/`):
- `server/internal/handle-submit.ts` — replace the `attachAttachment(att.id, "task", task.id)` loop (line 43-45) with a single `db.insert(_taskAttachments).values(ids.map(...))`. Update the precheck at line 28-34 to accept any attachment whose row exists (drop the `row.ownerId !== null` check — the column is gone; concurrent-submit protection is now handled by the PK on `_taskAttachments` + `onConflictDoNothing` or equivalent). Drop the `OWNER_TYPE = "task"` constant.

**Schema aggregator**:
- `server/src/db/schema.ts` — add `export * from "@plugins/tasks-core/server/internal/schema-attachments"`.

**Plugins doc**:
- `docs/plugins.md` — update the `attachments` and `tasks-core` entries to reflect the new exports and table; run the `plugins-doc-in-sync` check via `./equin check` after building.

## Data migration

The drizzle-kit-generated migration will create `task_attachments` and drop the two columns/indexes. **Hand-edit the generated SQL** to interleave a data copy between create and drop, in a single migration:

```sql
-- (auto) CREATE TABLE task_attachments (...);
INSERT INTO task_attachments (task_id, attachment_id, created_at)
  SELECT owner_id, id, created_at FROM attachments
  WHERE owner_type = 'task' AND owner_id IS NOT NULL;
-- Safety: any non-'task' owner_type would be silently orphaned. Fail loudly if present.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM attachments WHERE owner_type IS NOT NULL AND owner_type <> 'task') THEN
    RAISE EXCEPTION 'unexpected owner_type values in attachments; aborting migration';
  END IF;
END $$;
-- (auto) DROP INDEX attachments_owner_idx;
-- (auto) DROP INDEX attachments_staged_idx;
-- (auto) ALTER TABLE attachments DROP COLUMN owner_type;
-- (auto) ALTER TABLE attachments DROP COLUMN owner_id;
```

## Verification

1. `./equin build` — regenerates migration, applies it, restarts server. Migration must succeed with zero warnings.
2. `./equin check` — `migrations-in-sync` and `plugins-doc-in-sync` must pass.
3. `./equin check --plugin-boundaries` — confirm the new `@plugins/infra/plugins/attachments/server` imports from tasks-core and the new file pass.
4. End-to-end via the app at `http://<worktree>.localhost:9000`:
   - Open the Improve button, paste text + attach a file, submit. Task is created; attachment row and `task_attachments` row both exist (check via `psql` or a debug query). File exists on disk under `~/.singularity/attachments/`.
   - Delete the task (from the Tasks pane, or via `DELETE /api/tasks/:id`). Verify: `task_attachments` row gone (FK cascade), `_attachments` row still present, file still on disk.
   - Force a sweep (restart server or wait an hour with a short TTL override). Verify: the unreferenced `_attachments` row is deleted and file is unlinked.
5. Unit-level (manual): upload a file, do not link it within TTL → sweep deletes it (existing staged behavior preserved).
6. Multi-link smoke (optional now, recommended): register a dummy second link table in a test; insert two link rows for the same attachment; delete one; confirm the attachment survives; delete the other; confirm it's collected on next sweep.

## Out of scope

- A `defineLink(ownerTable)` DSL. Consumers write ~10 lines of plain Drizzle, matching how `_taskDependencies` is done. Add the DSL only if a third consumer repeats the pattern.
- Per-owner list endpoints. Nothing needs a list-by-owner view today; each consumer can add its own route later joining through its own link table.
- Immediate (non-sweep) cleanup of unreferenced `_attachments` rows. The 1h TTL is fine; consumers can optionally add their own cleanup if tighter bounds are ever needed.
