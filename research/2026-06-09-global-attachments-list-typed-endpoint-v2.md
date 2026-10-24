# Empty the `endpoints:typed-web-fetches` allowlist — single registry-backed attachment-list endpoint

Date: 2026-06-09
Category: global (infra/attachments + tasks + endpoints check)
Supersedes: `2026-06-09-global-attachments-list-typed-endpoint.md` (v1 — per-consumer
endpoints; rejected because it left the server-side list path duplicated per
consumer).

## Context

The `endpoints` migration is complete except for one holdout: the generic web
helper `listAttachments(ownerType, ownerId)` in
`plugins/infra/plugins/attachments/web/internal/list.ts`, which builds its URL at
runtime (`/api/${ownerType}s/${ownerId}/attachments`). It is the sole entry in the
`endpoints:typed-web-fetches` allowlist
(`plugins/infra/plugins/endpoints/check/typed-web-fetches.ts`), and while it exists
the check can't reject all hardcoded `/api/...` web fetches unconditionally.

The task framed this as a **route** problem (the URL template varies by ownerType),
not an encoding one. v1 proposed deleting the web helper and having each consumer
consume its own typed endpoint. But that only removes the *web* duplication and
leaves the **server** list path duplicated per consumer — route string + response
schema + `link.list()` + `diskPath`-strip map — which every future consumer would
re-write. (Confirmed: only `tasks` has a list route today; `getTaskAttachments` +
`handleTaskAttachments` already re-implement the generic path.)

The clean fix dissolves the polymorphism instead of fanning it out. attachments
already keeps a self-registering link registry (`linkSources`, populated by
`defineLink` at module load, consumed by the orphan sweep). One typed endpoint owned
by attachments can dispatch through that registry — making `ownerType` a **path
value**, not a template hole. This is the collection-consumer separation the codebase
mandates: attachments owns the registry + the one generic route; consumers contribute
handles via `defineLink`; **adding a list consumer requires zero route code.**

Outcome: the allowlist empties, the check rejects all raw `/api/` web fetches
unconditionally, and the per-consumer list boilerplate disappears (tasks loses its
endpoint + handler + route).

## Key facts (verified)

- `AttachmentLink.list(ownerId)` (`define-link.ts:99`) returns the **internal**
  `shared/types.Attachment` shape — which includes `diskPath` (an absolute server
  filesystem path). `createdAt` is already an ISO string.
- The wire shape excludes `diskPath` — the existing tasks handler strips it via a
  field-picking `.map()`. This strip must live in the **one** central handler.
- `getTaskAttachments` is referenced only inside the tasks plugin (server index +
  handler + core barrel) — safe to delete.
- The framework router matches param routes by segment count + literal segments, so
  `GET /api/attachments/by/:ownerType/:id` (5 segments) does not collide with the
  existing `GET /api/attachments/:id` (3 segments). Confirm during impl.

## Approach (Option C)

### 1. attachments `core/` (new runtime) — canonical wire shape + the one endpoint

attachments has no `core/` today (only server/web/shared). Add it.

- `core/internal/schema.ts` — wire shape (no `diskPath`):

  ```ts
  import { z } from "zod";
  import { dateString } from "@plugins/infra/plugins/endpoints/core";

  // Canonical wire shape of an attachment row. diskPath (server-only) is
  // intentionally excluded — the list handler strips it before responding.
  export const AttachmentSchema = z.object({
    id: z.string(),
    filename: z.string(),
    mime: z.string(),
    size: z.number(),
    createdAt: dateString(),
  });
  export type Attachment = z.infer<typeof AttachmentSchema>;
  ```

- `core/internal/endpoints.ts` — the single, literal-route endpoint:

  ```ts
  import { z } from "zod";
  import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
  import { AttachmentSchema } from "./schema";

  // ownerType is the owner table name (e.g. "tasks") — see defineLink registry.
  export const listAttachmentsEndpoint = defineEndpoint({
    route: "GET /api/attachments/by/:ownerType/:id",
    response: z.array(AttachmentSchema),
  });
  ```

- `core/index.ts` — barrel: re-export `AttachmentSchema`, `Attachment`,
  `listAttachmentsEndpoint`. (Barrel purity: imports + re-exports + a single
  `export default definePlugin(...)` if a core runtime needs a plugin def — mirror an
  existing `core/index.ts` byte-for-byte, e.g. a sibling infra plugin with a core
  runtime.)
- `package.json` — add the `core` export entry, mirroring the existing `web`/`server`
  entries' shape.
- Dependency `attachments → endpoints` already exists (server uses `implement`); no
  new cycle.

### 2. `defineLink` — register each handle by owner-type key

In `plugins/infra/plugins/attachments/server/internal/define-link.ts`:
- Derive `ownerType = getTableName(ownerTable)` (already computed for the join-table
  name).
- Build the handle, then register it: `links.set(ownerType, handle)` in a
  module-level `Map<string, AttachmentLink>` alongside the existing
  `linkSources.push(...)`.
- Export `getLink(ownerType: string): AttachmentLink | undefined`.
- Leave `linkSources`/`getRegisteredLinks` (orphan sweep) untouched.

### 3. attachments `server/` — the one dispatching handler

New `server/internal/handle-list-attachments.ts`:

```ts
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { listAttachmentsEndpoint } from "../../core";
import { getLink } from "./define-link";

export const handleListAttachments = implement(listAttachmentsEndpoint, async ({ params }) => {
  const link = getLink(params.ownerType);
  if (!link) throw new HttpError(404, `Unknown attachment owner type: ${params.ownerType}`);
  const rows = await link.list(params.id);
  return rows.map(({ diskPath, ...wire }) => wire); // strip server-only path
});
```

Register in `server/index.ts` `httpRoutes`:
`[listAttachmentsEndpoint.route]: handleListAttachments`. (`params` is typed
`{ ownerType: string; id: string }` from the literal route. `createdAt` is already a
string; `JsonCompat`/`dateString` cover the type check.)

### 4. attachments `web/` — drop the raw-fetch helper

- Delete `web/internal/list.ts`.
- In `web/index.ts` remove the `listAttachments` and `Attachment` re-exports (keep
  `uploadAttachment` / `UploadedAttachment`). No web list wrapper is added —
  consumers use `useEndpoint`/`fetchEndpoint` against `listAttachmentsEndpoint`.

### 5. tasks — delete the now-redundant per-consumer list path

- `tasks/core/endpoints.ts`: delete `TaskAttachmentSchema` and `getTaskAttachments`.
- `tasks/core/index.ts`: drop `getTaskAttachments` from the barrel.
- `tasks/server/index.ts`: drop the `getTaskAttachments` import + its `httpRoutes`
  entry.
- Delete `tasks/server/internal/handle-task-attachments.ts`. (`taskAttachments`
  handle stays in tasks-core — still used for `.add()`/`.set()` elsewhere.)

### 6. task-attachments component — consume the typed endpoint declaratively

`plugins/tasks/plugins/task-attachments/web/components/task-attachments.tsx`:

```tsx
import { listAttachmentsEndpoint } from "@plugins/infra/plugins/attachments/core";
import { useEndpoint } from "@plugins/infra/plugins/endpoints/web";

export function TaskAttachments({ taskId }: { taskId: string }) {
  const { data: attachments } = useEndpoint(listAttachmentsEndpoint, {
    ownerType: "tasks",
    id: taskId,
  });
  if (!attachments || attachments.length === 0) return null;
  // …existing render unchanged (img/file rows still use /api/attachments/:id)…
}
```

Removes `useState`/`useEffect`/`toast`/`listAttachments`/`Attachment` imports (errors
now flow through `useEndpoint`'s default reporting); also removes a `useEffect`-driven
fetch, keeping clear of `no-reactive-server-io`.

### 7. endpoints check — empty the allowlist

In `plugins/infra/plugins/endpoints/check/typed-web-fetches.ts`: empty the `ALLOWED`
map and rewrite the comment to state the migration is complete and the check now
rejects every hardcoded `/api/...` web fetch. Mirror the companion `typed-handlers`
check's already-empty shape.

### 8. Docs

`./equin build` regenerates `docs/plugins-*.md` + per-plugin CLAUDE.md autogen
blocks: attachments gains a `core` runtime (`AttachmentSchema`, `Attachment`,
`listAttachmentsEndpoint`) + a new route, loses web `listAttachments`/`Attachment`;
tasks loses `getTaskAttachments`/`TaskAttachmentSchema` + the
`GET /api/tasks/:id/attachments` route. `plugins-doc-in-sync` enforces it.

## Critical files

| File | Change |
|---|---|
| `plugins/infra/plugins/attachments/core/index.ts` | **new** barrel |
| `plugins/infra/plugins/attachments/core/internal/schema.ts` | **new** `AttachmentSchema`/`Attachment` |
| `plugins/infra/plugins/attachments/core/internal/endpoints.ts` | **new** `listAttachmentsEndpoint` |
| `plugins/infra/plugins/attachments/package.json` | add `core` export |
| `plugins/infra/plugins/attachments/server/internal/define-link.ts` | register handle by owner-type; `getLink()` |
| `plugins/infra/plugins/attachments/server/internal/handle-list-attachments.ts` | **new** dispatching handler |
| `plugins/infra/plugins/attachments/server/index.ts` | register the route |
| `plugins/infra/plugins/attachments/web/index.ts` | drop `listAttachments`/`Attachment` |
| `plugins/infra/plugins/attachments/web/internal/list.ts` | **delete** |
| `plugins/tasks/core/endpoints.ts` | delete `TaskAttachmentSchema` + `getTaskAttachments` |
| `plugins/tasks/core/index.ts` | drop `getTaskAttachments` export |
| `plugins/tasks/server/index.ts` | drop import + route entry |
| `plugins/tasks/server/internal/handle-task-attachments.ts` | **delete** |
| `plugins/tasks/plugins/task-attachments/web/components/task-attachments.tsx` | `useEndpoint(listAttachmentsEndpoint, …)` |
| `plugins/infra/plugins/endpoints/check/typed-web-fetches.ts` | empty allowlist + comment |

## Verification

1. `./equin build` — compiles (component data typed `Attachment[]`), regenerates
   migrations (none expected — no schema change) and docs.
2. `./equin check`:
   - `endpoints:typed-web-fetches` passes with an **empty** allowlist.
   - `plugin-boundaries` passes (new `attachments/core` barrel; tasks
     `task-attachments` → `attachments/core` import is legal).
   - `eslint` (`no-reactive-server-io`, `no-floating-promises`) passes.
   - `plugins-doc-in-sync` passes after build.
3. Manual: open a task with attachments at `http://<worktree>.localhost:9000`
   (Tasks → a task with an image/file attachment) and confirm the Attachments section
   still renders images + file rows. Capture before/after with `e2e/screenshot.mjs`
   against the task detail if a seeded task exists.
4. `curl http://<worktree>.localhost:9000/api/attachments/by/tasks/<taskId>` returns
   the attachment array **without** `diskPath`; an unknown ownerType
   (`/api/attachments/by/nope/x`) returns 404.
5. Negative: temporarily add `fetch("/api/foo")` in any `web/` file → confirm
   `endpoints:typed-web-fetches` now fails (then revert) — proves unconditional
   rejection.
6. IDE: `useEndpoint(listAttachmentsEndpoint, { ownerType, id })` → data typed
   `Attachment[]`; omitting `ownerType`/`id` is a type error.
```
