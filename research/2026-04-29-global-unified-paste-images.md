# Unified paste-images primitive across all prompt-style inputs

## Context

Today, **only one** input in the entire app supports pasting images: the conversation prompt-input
(`plugins/conversations/plugins/conversation-view/plugins/prompt-input/`). It uses a Lexical
editor with a custom `ImageNode` and renders pasted images as inline rich thumbnails (hover-×
to remove). Every other free-form text surface in the app — *improve* prompt, screenshot
annotation prompt, new-child-task body, task description, quick-prompts body, agent system
prompt — is a bare `<textarea>` with no paste support.

Worse, the existing prompt-input flow is bespoke and bypasses the `attachments` primitive entirely:
images are kept as in-memory data-URLs, then re-encoded as multipart `FormData` with
`<<<image:N>>>` token substitution at the `/api/conversations/:id/turn` endpoint. The *improve*
plugin, in contrast, already uses `uploadAttachment` and `/api/attachments/:id` — a cleaner pattern
but it doesn't actually let users *paste* into its textarea.

The goal is to unify all of this on a single, modern primitive: one Lexical-based editor
component used by every prompt-style field, paste-image support everywhere, attachments
uploaded immediately and referenced by ID, persisted as markdown image links, displayed as
rich UI elements (hover-× remove, click-to-expand lightbox).

## Decisions confirmed with user

- **Scope:** prompt-like fields only — improve prompt, screenshot prompt, new-child-task body,
  task description, quick-prompts body, agent description/prompt, conversation prompt-input.
  Skip titles, names, config strings.
- **Storage model:** clean modern design — Lexical editor everywhere, images as first-class
  decorator nodes, serialize to markdown with `/api/attachments/:id` image refs, link
  attachments to owner rows via `Attachments.defineLink`.
- **Rich UI element:** thumbnail + hover × + click-to-expand lightbox.
- **prompt-input migration:** last, after other inputs validate the design.
- **Plugin home:** new `plugins/primitives/plugins/paste-images/`.

## Design

### The primitive: `plugins/primitives/plugins/paste-images/`

A new sub-plugin under `primitives/`, alongside `editable-field` and `launch`.

**Public web exports** (`web/index.ts`):

```ts
// The full editor (replaces bare textareas in prompt-style fields)
export function PromptEditor(props: {
  value: string;                                    // markdown
  onChange: (markdown: string) => void;
  onAttachmentsChange?: (ids: string[]) => void;    // ids extracted from markdown
  onSubmit?: () => void;                            // Cmd+Enter
  placeholder?: string;
  rows?: number;                                    // initial visible rows
  className?: string;
  ownerType?: string;                               // for orphan-link bookkeeping
}): JSX.Element;

// Lexical primitives (for prompt-input which keeps its custom layout)
export { ImageUploadPlugin } from "./internal/image-upload-plugin";
export { ImageNode, $createImageNode, $isImageNode } from "./internal/image-node";

// The thumbnail itself, exposed for any custom layout
export function AttachmentThumbnail(props: {
  attachmentId: string;
  alt?: string;
  onRemove?: () => void;
  expandable?: boolean;                             // default true
}): JSX.Element;

// Markdown ↔ attachment-id helpers
export function extractAttachmentIds(markdown: string): string[];
export function rewriteAttachmentMarkdown(
  markdown: string,
  rewrite: (id: string) => string,                 // e.g. id → @/disk/path
): string;
```

**Behavior:**

- `PromptEditor` is a Lexical-based rich text component visually equivalent to a `<textarea>`.
  Plain text is just plain text. Pasted images become inline `ImageNode` nodes.
- On image paste, `ImageUploadPlugin` immediately calls
  `uploadAttachment(blob, "pasted.png", blob.type)` (from
  `@plugins/infra/plugins/attachments/web`) and inserts the resulting `attachmentId` into the
  `ImageNode`. No data-URLs.
- `ImageNode` renders `<AttachmentThumbnail attachmentId={...}>` which:
  - Displays `<img src="/api/attachments/:id" class="max-h-16 max-w-32 rounded border ...">`.
  - Hover shows a `×` button to remove (deletes the Lexical node).
  - Click opens a lightbox modal (full-size `<img>` over a backdrop). Reuse the dialog primitive
    already used by `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/plugins/image/`
    if practical, otherwise a small new lightbox in `paste-images`.
- Serialization: editor state → markdown via Lexical's markdown transformers. Images become
  `![alt](/api/attachments/:id)`. Plain text passes through unchanged.
- Deserialization (loading existing values): markdown → editor state via the same transformers.
  Markdown image links pointing at `/api/attachments/:id` become `ImageNode`s; other links/images
  remain as-is.

### Server normalization

Every owner that wants persisted paste-image content gets a link table via
`Attachments.defineLink(<ownerTable>)`. The text column stays as-is; markdown is just text.
On save, the server extracts attachment IDs from the markdown and upserts the link rows.

**Helper** (new export from `@plugins/infra/plugins/attachments/server`):

```ts
export async function syncOwnerAttachments(
  link: ReturnType<typeof Attachments.defineLink>,
  ownerId: string,
  text: string,
): Promise<void>;
```

It calls `extractAttachmentIds(text)` (shared util in `@plugins/primitives/plugins/paste-images/shared`),
diffs against current link rows for the owner, inserts new ones, deletes ones no longer present.
Idempotent. Used by every save path that accepts markdown text.

**Agent-launch substitution**: when text is handed to an agent (Claude reads files via `@<path>`
syntax in `runtime-tmux`), call `rewriteAttachmentMarkdown(text, id => "@" + diskPathFor(id))`.
`diskPathFor` is `getAttachment(id).diskPath`. This is the server-side equivalent of today's
`<<<image:N>>>` substitution, but driven off the standard attachments table.

### Lightbox / click-to-expand

`AttachmentThumbnail` accepts `expandable: true` (default). Click opens a centered overlay
with the full image plus a close button. Implemented with the project's existing dialog
primitives (shadcn `Dialog`). Lives entirely inside `paste-images`.

## Migration order

Each step is independently shippable. Each migrated input gets `PromptEditor` (or the
lightweight Lexical `ImageUploadPlugin` for surfaces that already have a custom layout).

1. **Create `paste-images` primitive plugin.** No consumers. Ship `PromptEditor`,
   `AttachmentThumbnail`, the markdown helpers, the lightbox. Register in `web/src/plugins.ts`.
   Add `syncOwnerAttachments` to `attachments/server`.
2. **Improve form** (`plugins/improve/web/components/improve-form.tsx`). Replace `<textarea>`
   with `<PromptEditor>`. Replace the bare `<img>` thumbnail block with the editor's inline
   image rendering. `prefilledAttachments` is injected as initial markdown
   (`![](/api/attachments/<id>)` lines). Submit handler extracts ids via
   `extractAttachmentIds` and sends them in `attachmentIds[]` to `/api/improve/submit`.
   Server already has `_taskAttachments` linkage for the meta task — extend it to call
   `syncOwnerAttachments` for the created task.
3. **Screenshot prompt-form** (`plugins/screenshot/web/components/prompt-form.tsx`).
   `<textarea>` → `<PromptEditor>`. The screenshot blob continues to be uploaded via the
   existing `/api/screenshots/:id/file` flow; pasted *additional* images go through
   `uploadAttachment`. Final prompt to Claude: markdown rewritten via
   `rewriteAttachmentMarkdown` with `@<path>` for both the screenshot path and any pasted-image
   disk paths.
4. **New-child-task popover**
   (`plugins/conversations/plugins/conversation-view/plugins/new-child-task/`). The textarea
   currently sends only `title` to `POST /api/tasks`. Repurpose into a `description` (or
   accept both): swap to `<PromptEditor>`, link attachments to the new task via the existing
   `_taskAttachments` link from `tasks-core`.
5. **Task description**
   (`plugins/tasks/plugins/task-description/web/components/description-view.tsx`). The
   highest-value migration. Use `<PromptEditor>`; on `useEditableField` save, send the
   markdown text and call `syncOwnerAttachments(_taskAttachments, taskId, text)` server-side
   inside `PATCH /api/tasks/:id`. The existing `task-attachments` panel keeps showing the
   linked images.
6. **Quick-prompts body**
   (`plugins/conversations/plugins/conversation-view/plugins/quick-prompts/`). `<textarea>` →
   `<PromptEditor>`. Stored markdown contains attachment refs; when a chip is clicked, the
   prompt is sent through the conversation-turn pipeline. Add a `_quickPromptAttachments`
   link table via `Attachments.defineLink`.
7. **Agent description + system prompt**
   (`plugins/agents/web/components/agent-detail.tsx`). `<textarea>` → `<PromptEditor>`. Same
   pattern; add `_agentAttachments` link table.
8. **Conversation prompt-input** (the original). Refactor in two parts:
   - Switch its custom Lexical setup to import `ImageUploadPlugin`, `ImageNode`,
     `AttachmentThumbnail` from `@plugins/primitives/plugins/paste-images/web`. Delete the
     duplicated copies in
     `plugins/conversations/plugins/conversation-view/plugins/prompt-input/web/components/editor/`.
   - Migrate the wire format: `PromptDraft` becomes `{ markdown: string }`; delete
     `PromptImageDraft`, `<<<image:N>>>`, `draftToTurnFormData`. `/api/conversations/:id/turn`
     accepts JSON `{ text, attachmentIds }`; server resolves disk paths via `getAttachment`
     and substitutes `@<path>` before calling `sendTurn`. Link attachments via a new
     `_conversationAttachments = Attachments.defineLink(_conversations)`.

## Critical files

New:
- `plugins/primitives/plugins/paste-images/package.json`
- `plugins/primitives/plugins/paste-images/web/index.ts`
- `plugins/primitives/plugins/paste-images/web/components/prompt-editor.tsx`
- `plugins/primitives/plugins/paste-images/web/components/attachment-thumbnail.tsx`
- `plugins/primitives/plugins/paste-images/web/internal/image-node.tsx`
- `plugins/primitives/plugins/paste-images/web/internal/image-upload-plugin.tsx`
- `plugins/primitives/plugins/paste-images/web/internal/markdown-transformers.ts`
- `plugins/primitives/plugins/paste-images/shared/index.ts` (`extractAttachmentIds`,
  `rewriteAttachmentMarkdown`)
- `plugins/primitives/plugins/paste-images/CLAUDE.md`

Modified:
- `web/src/plugins.ts` — register the new primitive.
- `plugins/infra/plugins/attachments/server/index.ts` — export new `syncOwnerAttachments` helper.
- `plugins/improve/web/components/improve-form.tsx` — adopt `PromptEditor`.
- `plugins/improve/server/internal/handle-submit.ts` — call `syncOwnerAttachments` on the new
  task; accept markdown body.
- `plugins/screenshot/web/components/prompt-form.tsx` — adopt `PromptEditor`; rewrite final
  prompt with `rewriteAttachmentMarkdown`.
- `plugins/tasks/plugins/task-description/web/components/description-view.tsx` — adopt
  `PromptEditor`.
- `plugins/tasks-core/server/internal/mutations/cross-table.ts` (or the relevant file under
  `tasks-core`) — `PATCH /api/tasks/:id` should call `syncOwnerAttachments`.
- `plugins/conversations/plugins/conversation-view/plugins/new-child-task/web/components/new-child-task-action.tsx`
  — adopt `PromptEditor`.
- `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/web/components/quick-prompts-settings.tsx`
  — adopt `PromptEditor`. Add `_quickPromptAttachments` link table.
- `plugins/agents/web/components/agent-detail.tsx` — adopt `PromptEditor`. Add
  `_agentAttachments` link table.
- `plugins/conversations/plugins/conversation-view/plugins/prompt-input/web/components/editor/*`
  — delete `image-paste-plugin.tsx`, `image-node.tsx`; import from `paste-images`.
- `plugins/conversations/plugins/conversation-view/plugins/prompt-input/web/components/editor/serialize.ts`
  — drop `<<<image:N>>>` machinery and `draftToTurnFormData`.
- `plugins/conversations/plugins/conversation-view/web/prompt-draft-context.tsx` — `PromptDraft`
  becomes `{ markdown: string }`.
- `plugins/conversations/server/internal/handle-post-turn.ts` — JSON `{ text, attachmentIds }`;
  use `getAttachment` + `rewriteAttachmentMarkdown`.
- `plugins/conversations/server/schema.ts` — add `_conversationAttachments` link.

## Verification (per-step)

After **each** migration step:

1. Run `./equin build` from this worktree.
2. Open `http://att-1777478253-pdii.localhost:9000`.
3. Visit the migrated surface. Type some text. Paste an image (Cmd+V from clipboard).
   - Confirm the thumbnail appears inline as a rich element.
   - Confirm hover-× removes it.
   - Confirm click opens the lightbox.
4. Save / submit. Inspect the server response and the relevant DB tables (e.g.
   `_taskAttachments`) to confirm the link row was created.
5. Reload the page. Confirm the saved markdown re-hydrates with the image visible.
6. For surfaces that launch agent runs: confirm the agent receives an `@<disk-path>` reference
   to the pasted image (check the conversation transcript / tmux pane).

After step 8 (full `prompt-input` migration), additionally:

- Send a turn with a pasted image. Confirm `/api/conversations/:id/turn` was called with JSON
  `{ text, attachmentIds }`, no multipart.
- Confirm Claude's transcript shows `@<absolute-path>` and the file exists at that path.
- Confirm `_conversationAttachments` has rows linking the conversation to the uploaded
  attachments.
- Run `./equin check` and confirm no plugin-boundary or migration drift.

## Open follow-ups (not blocking the design)

- Draft persistence for `prompt-input`: today the draft text persists to localStorage but
  data-URL images don't. Post-migration, attachment IDs *could* persist to localStorage too —
  recommend doing so as a small follow-up after step 8.
- Orphan sweep for paste-then-abandon: `attachments` already has a TTL-based orphan sweep.
  Audit it once the new flow is in production to confirm the TTL is short enough.
