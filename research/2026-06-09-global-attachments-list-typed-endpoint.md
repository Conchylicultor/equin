# Empty the `endpoints:typed-web-fetches` allowlist — typed attachment list

Date: 2026-06-09
Category: global (infra/attachments + tasks + endpoints check)

## Context

The `endpoints` migration is complete except for **one** holdout: the generic web
helper `listAttachments(ownerType, ownerId)` in
`plugins/infra/plugins/attachments/web/internal/list.ts`, which builds its URL at
runtime:

```ts
const res = await fetch(`/api/${ownerType}s/${encodeURIComponent(ownerId)}/attachments`);
```

It is the sole entry in the `endpoints:typed-web-fetches` check allowlist
(`plugins/infra/plugins/endpoints/check/typed-web-fetches.ts`). While it exists, the
check cannot reject all hardcoded `/api/...` web fetches unconditionally.

This is a **route** problem, not an encoding one: a single `defineEndpoint` can't
back it because the route fans out over `ownerType`. But that polymorphism is
**speculative** — the codebase has exactly one attachment *list* route today:

- **One server route**, already a typed endpoint: `getTaskAttachments`
  (`GET /api/tasks/:id/attachments`) in `plugins/tasks/core/endpoints.ts:122`,
  served by `implement(getTaskAttachments, …)` in
  `plugins/tasks/server/internal/handle-task-attachments.ts` (calls
  `taskAttachments.list(params.id)`).
- **One web call site**: `listAttachments("task", taskId)` in
  `plugins/tasks/plugins/task-attachments/web/components/task-attachments.tsx:19`.
- Every other `defineLink` consumer (conversations, agents, page/image,
  sonata/library) only uses `.set()`/`.add()` — none has a list route.

The server is already **polymorphism-free per consumer**: attachments owns the
generic primitive (`AttachmentLink.list()`), and each owner wraps it in its own
typed endpoint + handler. The web `listAttachments` is the one helper that
re-introduced runtime polymorphism. The fix is to make the **web symmetric with the
server**: delete the generic web helper; the single consumer consumes its existing
typed endpoint directly. A factory (`defineListEndpoint(ownerType)`) is rejected —
a runtime-built route string collapses `defineEndpoint`'s literal-derived
`{ id: string }` param type to `Record<string, never>` and breaks the
`typed-handlers` literal-route check, so it fights the type system to serve a
one-instance abstraction.

Intended outcome: the allowlist empties, the check rejects all raw `/api/` web
fetches unconditionally, and the attachment record shape is owned by the
attachments plugin (not re-declared in tasks).

## Approach (recommended: Option A)

### 1. attachments: own the canonical record shape in a new `core/` runtime

attachments has no `core/` today. Add one whose sole job is the canonical wire
shape of an attachment row (owned by the plugin that owns the `_attachments`
table), so consumers stop re-declaring it.

- New `plugins/infra/plugins/attachments/core/index.ts` (barrel) exporting
  `AttachmentSchema` (value) and `Attachment` (type).
- New `plugins/infra/plugins/attachments/core/internal/schema.ts`:

  ```ts
  import { z } from "zod";
  import { dateString } from "@plugins/infra/plugins/endpoints/core";

  // Canonical wire shape of an attachment row (matches AttachmentLink.list()).
  export const AttachmentSchema = z.object({
    id: z.string(),
    filename: z.string(),
    mime: z.string(),
    size: z.number(),
    createdAt: dateString(),
  });
  export type Attachment = z.infer<typeof AttachmentSchema>;
  ```

  - Dependency `attachments → endpoints` already exists (attachments server uses
    `implement`); no cycle, DAG preserved.
- Add a `core` entry to `plugins/infra/plugins/attachments/package.json` exports if
  the package mirrors other runtimes' export maps (match an existing sibling
  plugin that has all three runtimes — e.g. copy the `core` export block shape
  byte-for-byte).

### 2. tasks: use the canonical schema, drop the duplicate

In `plugins/tasks/core/endpoints.ts`:
- Delete the local `TaskAttachmentSchema` (lines 114–120).
- Import `AttachmentSchema` from `@plugins/infra/plugins/attachments/core`.
- `getTaskAttachments` response becomes `z.array(AttachmentSchema)`.

`handle-task-attachments.ts` already returns
`{ id, filename, mime, size, createdAt }` — unchanged; it now validates against the
shared schema. (`createdAt` Date → string is handled by `dateString()` +
`JsonCompat` widening, same as today.)

### 3. task-attachments.tsx: consume the typed endpoint declaratively

Replace the `useState` + `useEffect` + manual `listAttachments` fetch with
`useEndpoint`:

```tsx
import { getTaskAttachments } from "@plugins/tasks/core";
import { useEndpoint } from "@plugins/infra/plugins/endpoints/web";

export function TaskAttachments({ taskId }: { taskId: string }) {
  const { data: attachments } = useEndpoint(getTaskAttachments, { id: taskId });
  if (!attachments || attachments.length === 0) return null;
  // …unchanged render…
}
```

- `getTaskAttachments` is exported from the tasks core barrel (confirmed in
  `tasks/CLAUDE.md` core exports); `task-attachments` → `@plugins/tasks/core` is a
  legal cross-plugin import.
- Drops the `Attachment` type import and the `notifications.toast` error handler
  (errors now flow through `useEndpoint`'s default reporting). Remove the now-unused
  `toast` import; update the task-attachments facet/CLAUDE.md `Uses` line via docgen
  (regenerated by `./equin build`).
- This also removes a `useEffect`-driven server fetch, so it stays clear of the
  `no-reactive-server-io` lint.

### 4. attachments/web: delete the generic helper

- Delete `plugins/infra/plugins/attachments/web/internal/list.ts`.
- In `plugins/infra/plugins/attachments/web/index.ts` remove the
  `listAttachments` and `Attachment` re-exports (keep `uploadAttachment` /
  `UploadedAttachment`). Consumers that want the type import it from
  `@plugins/infra/plugins/attachments/core`.

### 5. endpoints check: empty the allowlist

In `plugins/infra/plugins/endpoints/check/typed-web-fetches.ts`:
- Replace the `ALLOWED` map body with an empty map and rewrite the comment to state
  the migration is complete (the check now rejects every hardcoded `/api/...` web
  fetch). Keep the `ALLOWED`/cap machinery so a future exception is a one-line add,
  or simplify to a hard "zero offenders" check — match the companion
  `typed-handlers` check, which already uses an empty `Set` (mirror its shape).

### 6. Docs

`./equin build` regenerates `docs/plugins-*.md` and per-plugin CLAUDE.md
autogen blocks (attachments gains a `core` runtime + `AttachmentSchema`/`Attachment`
exports; loses web `listAttachments`/`Attachment`; tasks core drops
`TaskAttachmentSchema`). The `plugins-doc-in-sync` check enforces this.

## Critical files

| File | Change |
|---|---|
| `plugins/infra/plugins/attachments/core/index.ts` | **new** barrel |
| `plugins/infra/plugins/attachments/core/internal/schema.ts` | **new** `AttachmentSchema` |
| `plugins/infra/plugins/attachments/package.json` | add `core` export |
| `plugins/infra/plugins/attachments/web/index.ts` | drop `listAttachments`/`Attachment` re-exports |
| `plugins/infra/plugins/attachments/web/internal/list.ts` | **delete** |
| `plugins/tasks/core/endpoints.ts` | drop `TaskAttachmentSchema`, use `AttachmentSchema` |
| `plugins/tasks/plugins/task-attachments/web/components/task-attachments.tsx` | `useEndpoint(getTaskAttachments, …)` |
| `plugins/infra/plugins/endpoints/check/typed-web-fetches.ts` | empty allowlist + comment |

## Verification

1. `./equin build` — compiles (TS infers `attachments` as `Attachment[]` from
   the endpoint), regenerates migrations (none expected — no schema change) and docs.
2. `./equin check` — run the full suite; specifically:
   - `endpoints:typed-web-fetches` passes with an empty allowlist.
   - `plugin-boundaries` passes (new `attachments/core` barrel; tasks → attachments
     core import is legal).
   - `eslint` (`no-reactive-server-io`, `no-floating-promises`) passes.
   - `plugins-doc-in-sync` passes after build regenerates docs.
3. Manual: open a task that has attachments at
   `http://<worktree>.localhost:9000` (Tasks → a task with an image/file attachment)
   and confirm the Attachments section still renders images and file rows.
   Use `e2e/screenshot.mjs` against the task detail to capture before/after if a
   seeded task with attachments is available.
4. Negative check: temporarily add `fetch("/api/foo")` in any `web/` file and
   confirm `endpoints:typed-web-fetches` now fails (then revert) — proves the check
   rejects unconditionally.
5. IDE: hover `useEndpoint(getTaskAttachments, { id })` → data typed
   `Attachment[]`; omitting `id` is a type error.
