# Image Block for the Page Editor

## Context

The block-based page editor (`plugins/page/`) currently supports text, bulleted-list,
to-do, toggle, and page-link blocks. It has no way to embed an image. This plan adds an
**image block type** so a user can drop a picture into a page and have it stored, served,
and resized inline — the same affordance Notion offers.

Goal: insert an image block, fill it by **paste / drag-and-drop / file picker**, display
the image, and **resize it to a free width via a drag handle**. Images are uploaded and
served through the existing **attachments primitive**, and the upload UX reuses the
**paste-images** plugin's helpers.

Two confirmed scope decisions:
- **Resize** = free-width **drag handle** (arbitrary px width persisted on the block).
- **Upload scope** = **into an empty image block's placeholder only**. Dropping/pasting an
  image elsewhere in the editor does NOT auto-create a block (kept out for a clean,
  insert-then-fill flow that mirrors `page-link`).

The work is a new sub-plugin `plugins/page/plugins/image/` (core + web + server), mirroring
two existing precedents byte-for-byte: **`page-link`** (custom non-text block renderer) and
**`links`** (server-side `blocksChanged` → job reconcile of a per-block side-table).

## Why this shape

- Block `data` is a **schemaless `jsonb`** column on `page_blocks`. Storing
  `{ attachmentId, width, alt }` needs **no editor change and no block migration**.
- Custom blocks render by contributing to the `Editor.Block` dispatch slot — exactly how
  `page-link` works. The slash menu, "+" gutter, and "turn into" menus **auto-discover** the
  new type from its `label`+`icon`, so no menu wiring is needed.
- Attachments are reclaimed by an hourly **orphan-sweep** unless linked to an owner row.
  The owner is the **block** (`page_blocks.id`). There is **no synchronous block lifecycle
  hook** — the only block-change signal is the `blocksChanged` trigger event. So ownership
  is reconciled by a job bound to `blocksChanged`, identical to how `links` keeps `page_links`
  in sync. FK cascade on the link table handles block/document hard-delete automatically.

## File tree

```
plugins/page/plugins/image/
  package.json
  core/
    index.ts                 # re-export imageBlock
    image-block.ts           # defineBlock(...)
  web/
    index.ts                 # PluginDefinition: Editor.Block contribution
    components/
      image-block.tsx        # ImageBlock renderer (empty + filled states + resize)
  server/
    index.ts                 # ServerPluginDefinition: Trigger + register
    internal/
      tables.ts              # imageBlockAttachments = defineLink(_blocks); export .table
      reconcile.ts           # reconcileDocumentImages(documentId)
      reconcile-job.ts       # reconcileImageAttachmentsJob (defineJob)
```

`package.json` mirrors siblings (`page-link`, `links`) — **no `dependsOn` key** (deps are
derived from imports at build time):

```json
{
  "name": "@singularity/plugin-page-image",
  "description": "Image block type: upload (paste/drop/picker), free-width resize, served via attachments.",
  "private": true,
  "version": "0.0.1"
}
```

## 1. Core — `core/image-block.ts`

```ts
import { z } from "zod";
import { MdImage } from "react-icons/md";
import { defineBlock } from "@plugins/page/plugins/editor/core";

export const imageBlock = defineBlock({
  type: "image",
  schema: z.object({
    attachmentId: z.string().optional(),
    width: z.number().int().positive().optional(),
    alt: z.string().optional(),
  }),
  label: "Image",
  icon: MdImage,
  empty: () => ({}),   // no attachmentId → placeholder UI
});
```

`core/index.ts`: `export { imageBlock } from "./image-block";`

All schema fields are `.optional()`, so `imageBlock.parse({})` succeeds and yields the empty
state. No `markdownPrefixes`/`marker`/`placeholder`/`toggle` — this is a custom (non-text) block.

## 2. Web — `web/components/image-block.tsx`

`ImageBlock({ block, isFocused, editor }: BlockRendererProps)` parses `block.data`, then:

**Empty state** (`!attachmentId`) — a dashed-border placeholder supporting all three inputs:
- **File picker**: hidden `<input type="file" accept="image/*">`, clicked from the placeholder button. Reset `e.target.value = ""` after pick so the same file can be re-selected.
- **Drag-and-drop**: `onDragOver`/`onDragLeave`/`onDrop` on the placeholder; on drop take `e.dataTransfer.files?.[0]`.
- **Paste**: a `window`-level `paste` listener registered in a `useEffect` **gated on `isFocused && !attachmentId`** — so at most one block's listener is live, keyed by the editor's existing focus model (`editor.onFocus()` sets `focusedBlockId`). The placeholder is `tabIndex={0}` and calls `editor.onFocus()` on click/focus to arm it. Filter `clipboardData.items` for `kind === "file" && type.startsWith("image/")`, mirroring `paste-images`' `image-upload-plugin.tsx`. **No polling.**

All three funnel into one `ingest(file)`:
```ts
async function ingest(file: File | Blob) {
  if (!file.type?.startsWith("image/")) { setError("Only image files are supported."); return; }
  setError(null); setUploading(true);
  try {
    const filename = file instanceof File ? file.name : "image";
    const res = await uploadAttachment(file, filename, file.type);
    editor.update({ attachmentId: res.id, width: DEFAULT_W }); // persist immediately
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e)); // fail loud, no silent catch
  } finally {
    setUploading(false);
  }
}
```
- `uploadAttachment` from `@plugins/infra/plugins/attachments/web` (`(file, filename, mime) → { id, ... }`; throws on non-2xx).
- `uploading` disables the button and shows "Uploading…"; `error` renders `<Placeholder tone="error">` (from `@plugins/primitives/plugins/placeholder/web`).

**Filled state** (`attachmentId` set) — render the image at persisted `width` with a resize handle:
- `<img src={attachmentUrl(attachmentId)}>` (`attachmentUrl` from `@plugins/primitives/plugins/text-editor/plugins/paste-images/web`), inside a `relative inline-block` wrapper styled `width: w`.
- **Resize handle** on the right edge using **pointer events**: `onPointerDown` → `setPointerCapture` → track `pointermove` updating a **local `liveWidth`** state (60fps, no network) → **commit once on `pointerup`** via `editor.update({ attachmentId, width, alt })`. Clamp to `[MIN_W(80), containerParent.clientWidth]`. Committing only on release (not debounced-during-drag) avoids spamming the block PATCH endpoint and the `blocksChanged` → reconcile job on every frame.
- **Click-to-expand**: reuse `Lightbox` from the paste-images web barrel (`<Lightbox attachmentId alt onClose>`).
- **Remove/replace**: a hover `×` button calling `editor.update({ alt })` (clears `attachmentId`+`width`, returning to the placeholder).

`web/index.ts`:
```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { imageBlock } from "../core";
import { ImageBlock } from "./components/image-block";

export { imageBlock } from "../core";

export default {
  name: "Image Block",
  description: "Image block type: upload via paste/drop/picker into an empty block, free-width resize, served via attachments.",
  contributions: [
    Editor.Block({ match: imageBlock.type, block: imageBlock, component: ImageBlock }),
  ],
} satisfies PluginDefinition;
```

## 3. Server — attachment ownership (mirror `links`)

**`server/internal/tables.ts`** — declare the block↔attachment link (creates `page_blocks_attachments`, composite PK, FK cascade both sides), mirroring `tasks-core/server/internal/schema-attachments.ts`:
```ts
import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { _blocks } from "@plugins/page/plugins/editor/server";

export const imageBlockAttachments = Attachments.defineLink(_blocks);
// Re-export the pgTable so drizzle-kit's schema glob generates the migration.
export const _imageBlockAttachmentsTable = imageBlockAttachments.table;
```

**`server/internal/reconcile.ts`** — load every block in the document; `set` each image block's link to `[attachmentId]` (or `[]`), and `set([])` for non-image blocks so an image→other conversion drops stale links. `set()` is an idempotent reconcile (insert new, delete removed):
```ts
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _blocks } from "@plugins/page/plugins/editor/server";
import { imageBlock } from "../../core";
import { imageBlockAttachments } from "./tables";

export async function reconcileDocumentImages(documentId: string): Promise<void> {
  const blocks = await db
    .select({ id: _blocks.id, type: _blocks.type, data: _blocks.data })
    .from(_blocks)
    .where(eq(_blocks.documentId, documentId));
  for (const block of blocks) {
    if (block.type === imageBlock.type) {
      const { attachmentId } = imageBlock.parse(block.data);
      await imageBlockAttachments.set(block.id, attachmentId ? [attachmentId] : []);
    } else {
      await imageBlockAttachments.set(block.id, []); // cheap no-op unless it was an image
    }
  }
}
```

**`server/internal/reconcile-job.ts`** — mirrors `reindex-job.ts` exactly:
```ts
import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { reconcileDocumentImages } from "./reconcile";

export const reconcileImageAttachmentsJob = defineJob({
  name: "page.image.reconcile",
  input: z.object({}).default({}),
  event: z.object({ documentId: z.string() }),
  dedup: "none", // reconcileDocumentImages is idempotent (set()-based)
  run: async ({ event }) => { if (!event) return; await reconcileDocumentImages(event.documentId); },
});
```

**`server/index.ts`** — bind the job to `blocksChanged`, mirroring `links/server/index.ts`:
```ts
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { blocksChanged } from "@plugins/page/plugins/editor/server";
import { reconcileImageAttachmentsJob } from "./internal/reconcile-job";

export default {
  name: "Image Block (server)",
  description: "Links image-block attachments to their page_blocks rows on every blocksChanged emit; FK cascade reclaims on delete.",
  register: [reconcileImageAttachmentsJob],
  contributions: [
    Trigger({ on: blocksChanged, do: reconcileImageAttachmentsJob, with: {}, oneShot: false }),
  ],
} satisfies ServerPluginDefinition;
```

`blocksChanged.emit({ documentId })` fires on every block create/update/delete/move/split/merge/indent/outdent, so the link set converges after any change. Block/document hard-delete is handled by the FK cascade on `page_blocks_attachments` before the orphan sweep runs.

## Edge cases & gotchas

- **Upload failure — fail loud.** `uploadAttachment` throws on non-2xx; the `catch` surfaces the message in `<Placeholder tone="error">`. No silent swallow (repo rule + ESLint `no-bare-catch`).
- **Mime / size.** Client pre-checks `image/*`; 20 MB cap is server-enforced and surfaces as a thrown error string.
- **Orphan-sweep race.** `editor.update({attachmentId})` runs immediately after upload, emitting `blocksChanged` → reconcile job → `set()` — well within the 1h orphan TTL. If the user navigates away before the PATCH lands, the attachment stays orphaned and is correctly reclaimed.
- **Resize commit.** Local `liveWidth` during drag, single `editor.update` on `pointerup` — avoids per-frame PATCH/trigger storms.
- **Focus/collapsed.** Paste listener is inert in the filled state (gated on `!attachmentId`) and when not focused. Resize lives on the block's own content, unaffected by collapse (which hides children).
- **Plugin boundaries (enforced).** Import only runtime barrels: `@plugins/page/plugins/editor/{core,web,server}`, `@plugins/infra/plugins/attachments/{web,server}`, `@plugins/infra/plugins/{jobs,events}/server`, `@plugins/primitives/plugins/text-editor/plugins/paste-images/web`. The `defineLink` table stays in our `internal/`, barrel-exported only as the `imageBlockAttachments` handle. No authored plugin `id:`. No `text-[..]` font sizes (use `text-3xs` etc. only where it's the existing token — none needed here).
- **No manual codegen.** `web.generated.ts` / `server.generated.ts` and the `page_blocks_attachments` migration are regenerated by `./equin build`. Never run drizzle-kit by hand.

## Critical files to mirror

- `plugins/page/plugins/page-link/web/components/page-link-block.tsx` — custom block renderer template (parse data, empty-state affordance, `editor.update`).
- `plugins/page/plugins/links/server/index.ts` + `internal/reindex-job.ts` — `Trigger`+`register` wiring and job shape.
- `plugins/tasks-core/server/internal/schema-attachments.ts` — `defineLink` + `.table` re-export for drizzle-kit discovery.
- `plugins/primitives/plugins/text-editor/plugins/paste-images/web/internal/image-upload-plugin.tsx` — paste/drop item-filtering + `uploadAttachment` handler shape.

## Verification

1. `./equin build` — regenerates registries + the `page_blocks_attachments` migration; restarts the server. App at `http://att-1780611781-wkwl.localhost:9000`.
2. Pre-push sanity: `rg -n 'text-3xs|text-\[' plugins/page/plugins/image` (empty) and confirm no `internal/` cross-plugin imports.
3. **Playwright** (adapt `e2e/screenshot.mjs`): open a page, insert an Image block (slash/"+" menu → "Image"), click the placeholder, drive the hidden input via `page.setInputFiles('input[type=file]', '/path/test.png')`, wait for `<img src="/api/attachments/...">`, then drag the `[aria-label="Resize image"]` handle by a known dx and read back the wrapper `style.width`. Capture before/after.
4. **DB check** via `mcp__singularity__query_db` (load schema via ToolSearch first). Grab the block id from the `data-block-id` ancestor and the attachment id from the `<img src>`, then:
   ```sql
   SELECT owner_id, attachment_id FROM page_blocks_attachments WHERE owner_id = '<blockId>';
   SELECT data->>'width' AS width, data->>'attachmentId' AS attachment_id FROM page_blocks WHERE id = '<blockId>';
   ```
   Expect exactly one link row matching the `<img src>` id, and `width` equal to the post-resize value — proving upload → `editor.update` → `blocksChanged` → reconcile job → `imageBlockAttachments.set` → `page_blocks_attachments` row.
