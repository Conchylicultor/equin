# Deferred Tools Delta Attachment Renderer Sub-Plugin

## Context

The JSONL viewer's `attachment` umbrella plugin dispatches attachment events to sub-plugin renderers via the `JsonlViewerAttachment.Renderer` slot. Two sub-plugins exist (`nested-memory`, `task-reminder`); `deferred_tools_delta` events currently fall through to `GenericAttachmentView` (collapsed JSON dump). This plan adds a dedicated renderer.

The `deferred_tools_delta` event fires when tools become available (or are removed) mid-session — typically when MCP servers finish connecting or deferred tools are loaded. The payload:

```json
{
  "type": "deferred_tools_delta",
  "addedNames": ["Bash", "Read", "Edit", "Write"],
  "addedLines": ["Bash", "Read", "Edit", "Write"],
  "removedNames": []
}
```

## Files to Create

All under `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/plugins/deferred-tools-delta/`:

### 1. `package.json`

```json
{
  "name": "@singularity/plugin-conversations-conversation-view-jsonl-viewer-attachment-deferred-tools-delta",
  "private": true,
  "version": "0.0.1"
}
```

### 2. `web/index.ts`

Plugin definition contributing to `JsonlViewerAttachment.Renderer` with `subtype: "deferred_tools_delta"`. Follows the exact pattern of `task-reminder/web/index.ts`.

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerAttachment } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { DeferredToolsDeltaView } from "./components/deferred-tools-delta-view";

export default {
  id: "conversation-jsonl-viewer-attachment-deferred-tools-delta",
  name: "JSONL Viewer: deferred-tools-delta attachment renderer",
  collapsed: true,
  description:
    "Renders deferred-tools-delta attachment events showing tools becoming available or removed mid-session.",
  contributions: [
    JsonlViewerAttachment.Renderer({
      subtype: "deferred_tools_delta",
      component: DeferredToolsDeltaView,
    }),
  ],
} satisfies PluginDefinition;
```

### 3. `web/components/deferred-tools-delta-view.tsx`

Collapsible section mirroring the task-reminder pattern:

- **Payload interface**: `DeferredToolsDeltaPayload` with `addedNames: string[]`, `addedLines: string[]`, `removedNames: string[]`
- **Header**: Collapsible trigger with chevron + summary label. Format: `"Tools Delta"` + counts like `"+4"` or `"+3 −1"`. Uses muted styling consistent with other attachment renderers.
- **Body** (when expanded):
  - If `addedNames` non-empty: comma-separated tool names in `font-mono text-xs`
  - If `removedNames` non-empty: comma-separated names with `line-through` styling
  - If both empty: muted italic "No changes"

Imports:
- `useCollapsible`, `CollapsibleChevron` from `@plugins/primitives/plugins/collapsible/web`
- `AttachmentRendererProps` from `@plugins/.../attachment/core`

## Verification

1. `./equin build` — succeeds, no TS errors, no boundary violations
2. Open conversation `conv-1779695590-m6pd` at `http://att-1779719034-q24a.localhost:9000`
3. Scroll to the `deferred_tools_delta` attachment events — should show the new collapsible renderer with tool counts, not the generic JSON fallback
4. Expand to verify added/removed tool names render correctly
