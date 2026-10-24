# Nested Memory Attachment Sub-Plugin

## Context

The `attachment` umbrella plugin (at `jsonl-viewer/plugins/attachment/`) dispatches attachment events to sub-plugins by `subtype`. Currently no sub-plugins exist — all attachment events render via `GenericAttachmentView` (collapsed JSON dump). The most common subtype is `nested_memory` (13+ per conversation), representing CLAUDE.md files loaded as context. A dedicated renderer replaces the opaque JSON dump with a readable file-path header and scrollable content body.

Parent research: `research/2026-05-25-conversations-attachment-event-renderers.md`

---

## Payload Shape

After `parse-jsonl.ts`, the event seen by the renderer is:

```ts
{
  kind: "attachment",
  at: "2026-05-25T07:55:15.159Z",
  subtype: "nested_memory",
  attachment: {
    type: "nested_memory",
    path: "/abs/path/plugins/plugin-meta/CLAUDE.md",
    displayPath: "plugins/plugin-meta/CLAUDE.md",
    content: {
      path: "...",
      type: "Project",                     // always "Project" in observed data
      content: "# plugin-meta\n\n...",     // Claude's working copy
      rawContent: "# plugin-meta\n...",    // on-disk version
      contentDiffersFromDisk: boolean
    }
  }
}
```

---

## Files

All under `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/plugins/nested-memory/`.

### 1. `package.json`

```json
{
  "name": "@singularity/plugin-conversations-conversation-view-jsonl-viewer-attachment-nested-memory",
  "private": true,
  "version": "0.0.1"
}
```

### 2. `web/index.ts`

Barrel. Contributes to `JsonlViewerAttachment.Renderer` with `subtype: "nested_memory"`.

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerAttachment } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { NestedMemoryAttachmentView } from "./components/nested-memory-attachment-view";

export default {
  id: "conversation-jsonl-viewer-attachment-nested-memory",
  name: "JSONL Viewer: nested-memory attachment renderer",
  collapsed: true,
  description:
    "Renders nested-memory attachment events showing which CLAUDE.md files were loaded as context.",
  contributions: [
    JsonlViewerAttachment.Renderer({
      subtype: "nested_memory",
      component: NestedMemoryAttachmentView,
    }),
  ],
} satisfies PluginDefinition;
```

### 3. `web/components/nested-memory-attachment-view.tsx`

The renderer component. Follows the `GenericAttachmentView` pattern (collapsible row with chevron + timestamp).

**Imports:**
- `useCollapsible`, `CollapsibleChevron` from `@plugins/primitives/plugins/collapsible/web`
- `Timestamp` from `@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web`
- `AttachmentRendererProps` (type) from `@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core`

**Local type** (not exported — lives in the component file):

```ts
interface NestedMemoryPayload {
  type: "nested_memory";
  path: string;
  displayPath: string;
  content: {
    path: string;
    type: string;
    content: string;
    rawContent: string;
    contentDiffersFromDisk: boolean;
  };
}
```

**Collapsed header** (single line, default state):
- `CollapsibleChevron`
- `displayPath` in monospace (e.g. `plugins/primitives/CLAUDE.md`)
- If `contentDiffersFromDisk`: a small "(modified)" text indicator in muted orange/amber
- `Timestamp` right-aligned

**Expanded body**:
- `content.content` (Claude's working copy) in a scrollable `<pre>` block
- `max-h-64 overflow-auto` to cap height for long CLAUDE.md files

**Design rationale:**
- No markdown rendering — these are transcript context dumps, not documentation pages. Monospace `<pre>` matches the JSONL viewer aesthetic and avoids pulling in the markdown primitive's weight for 13+ instances per conversation.
- No `FileLinkText` or `ToolFilePath` — the `displayPath` is informational context (which files were loaded), not a navigation target. Adding file-peek pane integration would create unnecessary cross-plugin dependencies.
- Max height cap prevents long CLAUDE.md files from dominating the transcript scroll.

---

## Verification

1. `./equin build` — succeeds with no TypeScript errors
2. `./equin check --plugin-boundaries` — no violations
3. Open conversation `conv-1779695590-m6pd` at `http://att-1779706934-g3j1.localhost:9000`
4. Verify nested_memory events show as collapsed rows with `displayPath` (not raw JSON dumps)
5. Click to expand one — content should appear as scrollable monospace text
6. Verify other attachment subtypes (task_reminder, etc.) still render via the generic fallback
