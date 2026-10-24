---
name: Attachments — FK link tables (v2)
description: Replace polymorphic ownership with per-consumer FK link tables, declared in one line per consumer via Attachments.defineLink().
---

# Attachments — FK link tables (v2)

## What changed from v1

v1 had consumers hand-writing the link table (~10 lines of Drizzle). That contradicted the original "one line per consumer" pitch. v2 introduces `Attachments.defineLink(ownerTable)` — a create-and-register helper that matches the project's existing `defineConfig` / `defineAction` / `defineTriggerEvent` pattern. The Context, sweep design, migration, and verification sections are unchanged from v1; only the consumer-facing API and helper internals change.

## Context (unchanged)

`_attachments` has polymorphic `(owner_type, owner_id)` with no FK (`plugins/attachments/server/internal/tables.ts:9`). When an owner is deleted (e.g., `deleteTask` at `plugins/tasks-core/server/internal/mutations/tasks.ts:116`), attachments leak: DB row and on-disk file both remain. The orphan sweep at `plugins/attachments/server/internal/orphan-sweep.ts` only catches staged uploads (`owner_id IS NULL`, 24h TTL) — not attached-but-owner-gone.

Fixing this with "remember to call `deleteAttachmentsForOwner` in every owner-delete path" is a convention new consumers will forget. The right primitive is a DB-enforced FK cascade: each consumer declares its own link table with `ON DELETE CASCADE`, and a sweep collects `_attachments` rows that no link references. Multi-ownership (same file attached to a task *and* a future comment/crash) falls out for free.

Only one consumer exists today (`improve` → `task`). The `_taskDependencies` join table (`plugins/tasks-core/server/internal/tables.ts:53`) validates the shape.

## Design

### Consumer-facing API: one line per consumer

```ts
// NEW FILE: plugins/tasks-core/server/internal/schema-attachments.ts
import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { _tasks } from "./tables";

export const taskAttachments = Attachments.defineLink(_tasks);
```

Three lines including imports. The `defineLink` helper:
- Creates a pgTable named `<owner>_attachments` (e.g. `tasks_attachments`).
- Columns: `owner_id` (FK → `ownerTable.id`, `ON DELETE CASCADE`), `attachment_id` (FK → `_attachments.id`, `ON DELETE CASCADE`), `created_at`.
- Composite PK `(owner_id, attachment_id)`.
- Side effect: registers the returned table with the orphan-sweep's link registry, so the consumer cannot forget.

This file cannot live in `plugins/tasks-core/server/internal/tables.ts` because that file is a documented load-order leaf (`tables.ts:13-20`) that may not import from other plugins. A sibling file in the same plugin can import `@plugins/infra/plugins/attachments/server` freely.

### Helper internals

```ts
// NEW FILE: plugins/attachments/server/internal/define-link.ts
import { getTableName, type AnyPgColumn } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp, type PgTable } from "drizzle-orm/pg-core";
import { _attachments } from "./tables";

type WithIdColumn = PgTable & { id: AnyPgColumn };

const linkSources: Array<{ table: PgTable; attachmentIdCol: AnyPgColumn }> = [];

export function defineLink<T extends WithIdColumn>(ownerTable: T) {
  const name = `${getTableName(ownerTable)}_attachments`;
  const link = pgTable(
    name,
    {
      ownerId: text("owner_id")
        .notNull()
        .references(() => ownerTable.id as AnyPgColumn, { onDelete: "cascade" }),
      attachmentId: text("attachment_id")
        .notNull()
        .references(() => _attachments.id, { onDelete: "cascade" }),
      createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    },
    (t) => [primaryKey({ columns: [t.ownerId, t.attachmentId] })],
  );
  linkSources.push({ table: link, attachmentIdCol: link.attachmentId });
  return link;
}

export function getRegisteredLinks(): ReadonlyArray<{ table: PgTable; attachmentIdCol: AnyPgColumn }> {
  return linkSources;
}
```

Exposed via the `Attachments` namespace object in `plugins/attachments/server/api.ts`:

```ts
// plugins/attachments/server/api.ts
import { defineLink } from "./internal/define-link";
export const Attachments = { defineLink };
export { _attachments } from "./internal/tables";
export { getAttachment, deleteAttachment } from "./internal/api";
```

### Consumers use `ownerId`, not `taskId`

Trade-off: the helper can't know the owner's semantic name, so the FK column is always `owner_id`. Queries look like `eq(taskAttachments.ownerId, taskId)` rather than `eq(taskAttachments.taskId, taskId)`. Slightly less self-documenting than the hand-rolled `_taskDependencies.taskId`, but the helper's win is huge (1 line vs 10) and multi-consumer symmetry is a feature: every link table has the same shape, so generic code across them works.

### Orphan sweep (unchanged from v1)

`plugins/attachments/server/internal/orphan-sweep.ts` rewrite:
- Pull `getRegisteredLinks()`.
- Build `NOT IN (UNION ALL of SELECT attachmentIdCol FROM source.table)`.
- Predicate: `createdAt < cutoff AND id NOT IN (<union>)`.
- Delete matching rows + unlink disk files.
- TTL shortened from 24h to **1h**. Sweep still runs hourly.

The `attachments_owner_idx` and `attachments_staged_idx` indexes go away with the columns.

### Removed API (unchanged from v1, confirmed via grep)

- `attachAttachment()` — no cross-plugin callers after improve migrates. `isNull(ownerId)` CAS guard dies with the column; link-table PK provides concurrent-insert safety.
- `deleteAttachmentsForOwner()` — superseded by CASCADE.
- `listAttachmentsForOwner()` — no callers.
- `POST /api/attachments/:id/attach` — no callers.
- `GET /api/attachments?ownerType=X&ownerId=Y` — no callers.
- `web/internal/list.ts` — no callers.

### Kept API

- `POST /api/attachments` — staged upload (used by web `uploadAttachment`).
- `GET /api/attachments/:id` — download (used by improve's rendered markdown).
- `DELETE /api/attachments/:id` — manual-delete surface.
- `_attachments`, `getAttachment(id)`, `deleteAttachment(id)`.
- **New**: `Attachments.defineLink(ownerTable)`.

### Multi-ownership semantics

A `_attachments` row stays alive while any link table references it. When the last link disappears, the sweep collects it on the next tick. Explicit feature — consumers should not assume 1:1.

## Changes by file

**Attachments plugin** (`plugins/attachments/`):
- `server/internal/tables.ts` — drop `ownerType`, `ownerId`, and both owner indexes.
- `server/internal/api.ts` — delete `attachAttachment`, `deleteAttachmentsForOwner`, `listAttachmentsForOwner`. Keep `getAttachment`, `deleteAttachment`. Update `toAttachment` to drop owner fields.
- `server/internal/define-link.ts` — **new** (per above).
- `server/internal/orphan-sweep.ts` — rewrite sweep per above; TTL = 1h.
- `server/internal/handle-list.ts` — **delete**.
- `server/internal/handle-attach.ts` — **delete**.
- `server/api.ts` — export `Attachments` namespace (with `defineLink`); drop removed exports.
- `server/index.ts` — drop the two removed HTTP routes.
- `shared/types.ts` — drop `ownerType`, `ownerId` from `Attachment`.
- `web/internal/list.ts` — **delete** (no callers).

**Tasks-core plugin** (`plugins/tasks-core/`):
- `server/internal/schema-attachments.ts` — **new**. Three lines: import, import, `export const taskAttachments = Attachments.defineLink(_tasks)`.

**Improve plugin** (`plugins/improve/`):
- `server/internal/handle-submit.ts` — replace the `attachAttachment(att.id, "task", task.id)` loop (line 43-45) with a bulk `db.insert(taskAttachments).values(ids.map(id => ({ ownerId: task.id, attachmentId: id })))`. Drop the `row.ownerId !== null` precheck at line 28-34 (the column is gone; PK protects against double-insert). Drop `OWNER_TYPE = "task"` constant.

**Schema aggregator**:
- `server/src/db/schema.ts` — add `export * from "@plugins/tasks-core/server/internal/schema-attachments"`.

**Plugins doc**:
- `docs/plugins.md` — update `attachments` and `tasks-core` entries; run `./equin check` (includes `plugins-doc-in-sync`).

## Data migration

Hand-edit the drizzle-kit-generated migration to interleave a data copy between create and drop:

```sql
-- (auto) CREATE TABLE tasks_attachments (...);
INSERT INTO tasks_attachments (owner_id, attachment_id, created_at)
  SELECT owner_id, id, created_at FROM attachments
  WHERE owner_type = 'task' AND owner_id IS NOT NULL;

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

1. `./equin build` — regenerate migration, apply, restart. Zero warnings.
2. `./equin check` — `migrations-in-sync`, `plugins-doc-in-sync`, `plugin-boundaries` all pass.
3. End-to-end at `http://<worktree>.localhost:9000`:
   - Submit via Improve with an attachment → task + `tasks_attachments` row + `_attachments` row + disk file all exist.
   - Delete the task → `tasks_attachments` row gone (CASCADE), `_attachments` row still present, file still on disk.
   - Trigger sweep (restart or wait with short TTL override) → unreferenced `_attachments` row + file collected.
4. Staged-orphan case: upload a file, don't link within TTL → sweep deletes it (preserved behavior).
5. Multi-link smoke (optional): register a second dummy link table in a test, insert two link rows for the same attachment, delete one → survives; delete the other → collected on next sweep.

## Out of scope

- Per-owner list endpoints. Each consumer can add its own route later joining through its own link table; nothing needs it today.
- Immediate (non-sweep) cleanup of unreferenced `_attachments`. The 1h TTL is fine.
- Backfilling named columns (`taskId` instead of `ownerId`) via generics. Could be added to `defineLink` later with a type parameter if the ergonomics matter enough, but not worth it for one consumer.
