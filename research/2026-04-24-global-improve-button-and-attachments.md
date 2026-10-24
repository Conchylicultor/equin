# Improve button + attachments plugin

## Context

Today the toolbar's `+New Task` button creates a bare top-level task. We want to turn it into a fire-and-forget **Improve** channel that lets a user capture app-level feedback (bug, tweak, idea) without leaving their current flow — while also producing **actionable context** for the agent who picks up the task: the URL they were on, and optionally a screenshot of the page.

That need drives two distinct pieces of work:

1. **Improve button (replaces `+New Task`)**: renamed toolbar button, popover captures URL + optional screenshot, files the task under a new `IMPROVEMENTS_META_TASK_ID` (grouping like `CRASHES_META_TASK_ID`). The agent prompt sent on launch uses a **user-customizable template** exposed in Settings.
2. **New `attachments` plugin**: a polymorphic file-attachment primitive (tasks today; conversations/crashes later). UUID-named files on disk, staged upload with orphan sweep.

The attachments plugin is the load-bearing piece — Improve is the first consumer.

---

## Architecture overview

Two new plugins, plus two modifications:

| Change | Path | Notes |
|---|---|---|
| ➕ New | `plugins/attachments/` | Polymorphic attachment storage (web + server + shared) |
| ➕ New | `plugins/improve/` | Toolbar button, meta-task, prompt-template config |
| ✏️ Modify | `plugins/tasks/web/index.ts` | Drop `Shell.Toolbar(NewTaskButton)` contribution |
| ✏️ Modify | `server/src/plugins.ts` + `web/src/plugins.ts` | Register new plugins |
| ✏️ Modify | `server/src/db/schema.ts` | Re-export `_attachments` table |

The existing `plugins/tasks/web/components/new-task-button.tsx` is **deleted** — the new button lives inside the Improve plugin (self-contained, easier to evolve).

---

## Part 1 — `attachments` plugin

### Storage

- **Disk root**: `~/.singularity/attachments/` (matches `plugins/crashes/server/internal/buffer.ts:3` which uses `join(homedir(), ".singularity", "crashes")`).
- **Layout**: flat, UUID-named. Example: `~/.singularity/attachments/a1b2c3d4-....png`.
- Extension derived from original filename (fallback: `.bin`). Preserves filename safely at download time via `Content-Disposition`.

### Schema

New table in `plugins/attachments/server/internal/tables.ts`:

```ts
export const _attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),              // uuid
    ownerType: text("owner_type"),            // nullable => staged (not yet attached)
    ownerId: text("owner_id"),                // nullable => staged
    filename: text("filename").notNull(),     // original filename from client
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    diskPath: text("disk_path").notNull(),    // absolute path under ~/.singularity/attachments/
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("attachments_owner_idx").on(t.ownerType, t.ownerId),
    index("attachments_staged_idx").on(t.createdAt).where(sql`${t.ownerId} is null`),
  ],
);
```

- **No Drizzle `.references()`** — owner is polymorphic. Integrity is soft (ok, the crashes plugin already uses soft FKs per `tables.ts:31-34`).
- `owner_type` is free-form text so new consumers don't need a schema migration. Known values documented in the plugin README: `"task"`, later `"conversation"`, `"crash"`.

### HTTP API

All routes live on `plugins/attachments/server/index.ts`:

| Route | Purpose |
|---|---|
| `POST /api/attachments` | Staged upload — multipart/form-data with `file` field. Writes to disk, inserts row with `owner_id=null`, returns `{ id, filename, mime, size }`. |
| `POST /api/attachments/:id/attach` | Link a staged attachment to an owner. Body: `{ ownerType, ownerId }`. Atomic update, fails if already attached. |
| `GET /api/attachments/:id` | Stream file bytes with correct `Content-Type` + `Content-Disposition: inline; filename="<orig>"`. |
| `GET /api/attachments?ownerType=task&ownerId=...` | List attachments for an owner (for rendering on task details later). |
| `DELETE /api/attachments/:id` | Delete row + disk file. |

**Multipart parsing**: Bun's `req.formData()` (Web API) already works with `Bun.serve()` — no library needed. Pattern:

```ts
const form = await req.formData();
const file = form.get("file");
if (!(file instanceof File)) return new Response("missing file", { status: 400 });
const bytes = new Uint8Array(await file.arrayBuffer());
await Bun.write(diskPath, bytes);
```

Size guard: 20 MB per file (cheap config value, picked to cover full-page PNG screenshots at 2× scale).

### Lifecycle & orphan sweep

- **Attach flow** (staged): upload → return id → consumer submits with id → consumer calls `/api/attachments/:id/attach` with its owner info (single transaction).
- **Orphan sweep**: `setInterval` in `onReady()`, runs every **1 hour**, deletes rows where `owner_id IS NULL AND created_at < now() - interval '24 hours'` + unlinks the disk file.
  - Matches existing polling pattern (`plugins/conversations/server/internal/poller.ts`, `plugins/build/server/internal/auto-build-watcher.ts`).
  - Graphile-Worker (in `plugins/events`) is overkill for this; stays reserved for event dispatch.
- **Cascade on owner deletion**: the attachments plugin exposes `deleteAttachmentsForOwner(ownerType, ownerId)` as part of its `api.ts`. Consumers (tasks, crashes, conversations) call it from their own delete paths. **MVP: not wired into task deletion** — noted as deferred; orphan sweep won't clean these since `owner_id IS NOT NULL`.

### Public exports (`plugins/attachments/server/api.ts`)

```ts
export { _attachments } from "./internal/tables";
export { attachAttachment, deleteAttachmentsForOwner, getAttachment } from "./internal/api";
```

No web-side exports needed for MVP beyond a client helper (see below).

### Client helper (`plugins/attachments/web/index.ts`)

Exports one small utility for consumers:

```ts
// Uploads a Blob and returns the attachment id. The caller then passes the id
// to its own flow (e.g. /api/improve/submit) which calls /api/attachments/:id/attach.
export async function uploadAttachment(file: File | Blob, filename: string, mime: string): Promise<string>;
```

### Plugin scaffolding

```
plugins/attachments/
├── package.json            # @singularity/plugin-attachments
├── server/
│   ├── index.ts            # ServerPluginDefinition { httpRoutes, onReady }
│   ├── api.ts              # Public exports (attachAttachment, deleteAttachmentsForOwner, getAttachment)
│   └── internal/
│       ├── tables.ts       # _attachments schema
│       ├── paths.ts        # attachmentsRoot(), diskPathFor(id, ext)
│       ├── handle-upload.ts
│       ├── handle-attach.ts
│       ├── handle-get.ts
│       ├── handle-list.ts
│       ├── handle-delete.ts
│       ├── orphan-sweep.ts # setInterval loop
│       └── api.ts          # attachAttachment / deleteAttachmentsForOwner / getAttachment impls
├── web/
│   ├── index.ts            # PluginDefinition (no contributions — utility-only for MVP) + uploadAttachment()
└── shared/
    └── types.ts            # Attachment type exported to both sides
```

---

## Part 2 — `improve` plugin

### Files

```
plugins/improve/
├── package.json
├── server/
│   ├── index.ts            # ServerPluginDefinition { httpRoutes, onReady }
│   └── internal/
│       ├── meta-improvements.ts  # IMPROVEMENTS_META_TASK_ID = "task-meta-improvements"
│       ├── config.ts             # defineConfig for prompt template
│       ├── handle-submit.ts      # POST /api/improve (task + link attachments + optional launch)
│       └── render-prompt.ts      # template substitution
├── web/
│   ├── index.ts            # PluginDefinition, contributes Shell.Toolbar + Config.Section
│   └── components/
│       ├── improve-button.tsx       # Popover-hosting toolbar button
│       ├── improve-form.tsx         # Form body (textarea, URL row, screenshot toggle, action buttons)
│       └── prompt-template-settings.tsx  # Config.Section UI (textarea editor)
└── shared/
    └── types.ts            # SubmitBody type
```

### Meta-task

`plugins/improve/server/internal/meta-improvements.ts`:

```ts
import { ensureMetaTask } from "@plugins/tasks-core/server";
export const IMPROVEMENTS_META_TASK_ID = "task-meta-improvements";
export async function ensureImprovementsMetaTask(): Promise<void> {
  await ensureMetaTask(IMPROVEMENTS_META_TASK_ID, "Improvements");
}
```

Called from `onReady()` — identical to `plugins/crashes/server/index.ts:22`.

### Button UI (`improve-button.tsx`)

Toolbar button with `MdAdd` icon, label `Improve`, opens a `Popover` (reuse `@/components/ui/popover`). Replaces the current `NewTaskButton` — contributed via `Shell.Toolbar({ component: ImproveButton, group: "actions" })`.

### Form (`improve-form.tsx`)

Fields:
- **Textarea** (what's the improvement?) — auto-focus, ⌘-Enter submits Create.
- **URL row** (read-only chip): `window.location.href` captured on popover open, truncated display, always included in submission. No toggle — always on.
- **Screenshot toggle** (Switch or Checkbox): **off by default**. Label: "Attach screenshot of current page".
- **Action buttons** (right-aligned, identical to today): Cancel · Sonnet · Opus · Create.

Submit flow (Create, Sonnet, or Opus):
1. Capture URL: already in state from open.
2. If screenshot toggle on:
   - `flushSync(() => setSubmitting(...))` to disable the popover trigger.
   - **Close popover first** (avoid capturing the popover itself).
   - Two `requestAnimationFrame`s to let the close paint.
   - `domToBlob(document.documentElement, { scale: devicePixelRatio })` — mirrors `plugins/screenshot/web/components/screenshot-button.tsx:19-32`.
   - `uploadAttachment(blob, "page.png", "image/png")` → `attachmentId`.
3. `POST /api/improve/submit` with `{ text, url, attachmentIds: string[], launch?: "sonnet" | "opus" | null }`.
4. Toast result via `ShellCommands.Toast` (reuse existing success/error patterns from `new-task-button.tsx`).

### Submit endpoint (`POST /api/improve/submit`)

Server steps in a single logical flow:
1. Validate body (text required, attachmentIds staged and owned by none).
2. `createTask({ parentId: IMPROVEMENTS_META_TASK_ID, title: firstLineOrTruncate(text), description: renderTaskDescription(body), author: "improve-plugin" })`.
3. For each attachmentId: `attachAttachment(id, "task", task.id)`.
4. If `launch` is `"sonnet" | "opus"`:
   - Render the prompt from the template config (see below).
   - `POST /api/conversations` internally (via direct `createConversation` call from `@plugins/conversations/server`) with `{ taskId: task.id, prompt, model: launch }`.
5. Return `{ taskId, conversationId? }`.

### Task description

Rendered on the server, always:

```
<user text>

---
**URL:** http://...
**Attachments:**
- [page.png](/api/attachments/<id>)
```

### Prompt template (user-customizable via `config` plugin)

The Improve plugin declares a config field using `defineConfig` (see `plugins/conversations/.../quick-prompts/server/internal/tables.ts` and `Config.Section` contribution pattern). The template is multiline text with placeholders:

**Default template:**

```
{{text}}

---
Context:
- URL: {{url}}
- Screenshot: {{attachments}}
```

Available placeholders:
- `{{text}}` — user's typed text
- `{{url}}` — captured URL
- `{{attachments}}` — bullet list of disk paths (e.g. `~/.singularity/attachments/<uuid>.png`) so the agent can `Read` them directly.

The plugin contributes a `Config.Section` ("Improve prompt template") with a `<textarea>` editor — identical pattern to `plugins/conversations/.../quick-prompts` which already contributes `Config.Section "Quick Prompts"` (verified in `docs/plugins.md`).

`render-prompt.ts` does a simple string-replace. Unknown placeholders are left as-is (explicit, no silent data loss).

---

## Part 3 — Modifications

### `plugins/tasks/web/index.ts`

Remove the `NewTaskButton` import + `Shell.Toolbar` contribution (lines 9 and 20–23). The file stays.

**Delete**: `plugins/tasks/web/components/new-task-button.tsx` (superseded).

### `server/src/plugins.ts`

Add imports and entries (order doesn't matter for these — no dependency on runtime plugins or mcp):

```ts
import attachmentsPlugin from "@plugins/infra/plugins/attachments/server";
import improvePlugin from "@plugins/improve/server";
// ...
export const plugins: ServerPluginDefinition[] = [
  // ...existing...
  attachmentsPlugin,
  improvePlugin,
];
```

### `web/src/plugins.ts`

Same pattern, parallel registry.

### `server/src/db/schema.ts`

Add the re-export so Drizzle picks up the new table:

```ts
export * from "@plugins/infra/plugins/attachments/server/internal/tables";
```

Migration is generated automatically by `./equin build` (per `server/CLAUDE.md` schema change workflow). First build after this change will need `--migration-name add-attachments`.

---

## Implementation order

1. **Attachments plugin — server**
   1. Scaffold plugin dirs + `package.json`.
   2. `tables.ts` → add to `server/src/db/schema.ts` barrel.
   3. `paths.ts`, `api.ts`, `orphan-sweep.ts`, handlers.
   4. `index.ts` with `httpRoutes` + `onReady()` starts the sweep.
   5. Register in `server/src/plugins.ts`.
2. **Attachments plugin — web**
   1. `uploadAttachment()` helper in `web/index.ts`.
   2. Register in `web/src/plugins.ts`.
3. **Build + migrate**: `./equin build --migration-name add-attachments`. Verify migration file in `server/src/db/migrations/`.
4. **Improve plugin — server**
   1. `meta-improvements.ts`.
   2. `config.ts` with `defineConfig` (prompt template, default string).
   3. `render-prompt.ts`, `handle-submit.ts`.
   4. `index.ts` with `httpRoutes` + `onReady()` ensures meta-task.
   5. Register in `server/src/plugins.ts`.
5. **Improve plugin — web**
   1. `improve-form.tsx` + `improve-button.tsx`.
   2. `prompt-template-settings.tsx` (Config.Section).
   3. `index.ts` contributes `Shell.Toolbar` + `Config.Section`.
   4. Register in `web/src/plugins.ts`.
6. **Rename cleanup**: edit `plugins/tasks/web/index.ts`, delete `new-task-button.tsx`.
7. **Build + deploy**: `./equin build`.

---

## Deferred / out of scope

- **Attachment rendering on task detail pages.** The `/api/attachments?ownerType=task` endpoint exists; the task-detail UI doesn't call it yet. Screenshots embedded in task description markdown via `/api/attachments/<id>` URL work as a stop-gap for MVP.
- **Cascade delete on task deletion.** `deleteAttachmentsForOwner` is exported but not wired into `plugins/tasks/server/internal/handle-delete.ts`. Deleting a task currently orphans its attachments on disk (rows remain, size is bounded by 20 MB × feedback volume). Follow-up ticket.
- **Drag-and-drop / multi-file upload in Improve form.** The wire (`attachmentIds: string[]`) already supports it; UI ships with screenshot-only.
- **Non-image MIME rendering.** Download link works; in-place preview is a future attachments-plugin feature.
- **Other consumers (conversations, crashes).** `owner_type` schema is ready; actual wiring is a later project.

---

## Verification (end-to-end)

1. `./equin build --migration-name add-attachments` — build succeeds, migration file present.
2. Open `http://<worktree>.localhost:9000` — toolbar shows **+Improve** (replacing +New Task).
3. Click Improve → popover shows URL row populated + screenshot toggle off.
4. Type text, leave screenshot off → click **Create** → toast "Task created". Verify:
   - In Tasks sidebar, under new "Improvements" group, a task exists with description including URL.
   - No row in `_attachments` (since no file uploaded).
5. Re-open, type text, toggle screenshot on → click **Sonnet** → popover closes, page capture occurs, conversation launches. Verify:
   - Task under "Improvements".
   - Conversation created with prompt body matching the template (text + URL + attachment path).
   - `curl http://<worktree>.localhost:9000/api/attachments/<id>` returns PNG bytes.
   - Row in `_attachments` with `owner_type='task'`, `owner_id=<task.id>`.
6. Open **Settings** → "Improve prompt template" section → edit template → save → re-run (5) → confirm new prompt shape appears in the conversation.
7. Orphan sweep: upload a file via `curl -F file=@x.png /api/attachments` but never attach → wait (or temporarily lower the threshold during dev) → confirm file + row removed after TTL.
8. No regressions on `plugins/screenshot` (separate flow) — confirm `ScreenshotButton` in toolbar still works.

---

## Critical files to read before implementing

- `plugins/crashes/server/index.ts` + `internal/meta-crashes.ts` — meta-task pattern to mirror.
- `plugins/crashes/server/internal/record-crash.ts:100-105` — `createTask({ parentId: META_ID, ... })` shape.
- `plugins/screenshot/web/components/screenshot-button.tsx:19-56` — `domToBlob` capture + `flushSync`/rAF dance.
- `plugins/tasks/web/components/new-task-button.tsx` — popover/form baseline to evolve.
- `plugins/conversations/.../quick-prompts/` — `Config.Section` contribution pattern.
- `plugins/tasks-core/server/internal/mutations/tasks.ts:10-51` (`createTask`) + `:177-185` (`ensureMetaTask`).
- `server/CLAUDE.md` — `ServerPluginDefinition`, `defineResource`, schema workflow, `onReady`.
- `plugin-core/CLAUDE.md` — slots/contributions, registering a plugin.
