# Attachment Event Renderers for the JSONL Viewer

## Context

Claude Code JSONL transcripts emit `type: "attachment"` lines for several system-injected metadata events. These events carry an `attachment` object whose `type` field specifies the subtype. Currently none are recognised by `parse-jsonl.ts` — they all fall through to the `kind: "unknown"` path and are rendered by the generic `UnknownRow` collapsible.

### Observed subtypes and their payload shapes (from real transcripts)

**`nested_memory`** (13 occurrences) — a CLAUDE.md file loaded as context at conversation start.
```jsonl
{ "type": "attachment", "attachment": {
    "type": "nested_memory",
    "path": "/abs/path/CLAUDE.md",
    "displayPath": "plugins/primitives/CLAUDE.md",
    "content": {
      "path": "...", "type": "Project",
      "content": "<rendered text>",
      "rawContent": "<raw file text>",
      "contentDiffersFromDisk": true | false
    }
  }, "timestamp": "...", ... }
```

**`task_reminder`** (5 occurrences) — periodic injection of active task list.
```jsonl
{ "type": "attachment", "attachment": {
    "type": "task_reminder",
    "itemCount": 8,
    "content": [
      { "id": "1", "subject": "...", "description": "...",
        "activeForm": "...", "status": "in_progress | pending | ...",
        "blocks": [], "blockedBy": [] },
      ...
    ]
  }, "timestamp": "...", ... }
```
(itemCount 0 is also observed — empty reminder when no active tasks.)

**`deferred_tools_delta`** (2 occurrences) — tools becoming available mid-session.
```jsonl
{ "type": "attachment", "attachment": {
    "type": "deferred_tools_delta",
    "addedNames": ["Bash", "Read", ...],
    "addedLines": ["Bash", "Read", ...],
    "removedNames": []
  }, "timestamp": "...", ... }
```

**`skill_listing`** (1 occurrence) — available slash-command skills injected at session start.
```jsonl
{ "type": "attachment", "attachment": {
    "type": "skill_listing",
    "content": "- skill-name: description\n...",
    "skillCount": 13,
    "isInitial": true
  }, "timestamp": "...", ... }
```

**`command_permissions`** (1 occurrence) — permission grants for the session.
```jsonl
{ "type": "attachment", "attachment": {
    "type": "command_permissions",
    "allowedTools": []
  }, "timestamp": "...", ... }
```

All five are top-level JSONL objects with `type: "attachment"`, a `timestamp` field, and an `attachment` sub-object carrying the subtype-specific payload.

---

## Architecture Diagram

```
JSONL line: { type: "attachment", attachment: { type: "nested_memory", ... }, timestamp }
                      |
                      v
  parse-jsonl.ts  [new branch: type === "attachment"]
    → emit kind: "attachment", subtype: att.type, attachment: att, at: ts
                      |
                      v
  protocol.ts  [new discriminant in JsonlEventSchema]
    AttachmentEvent = { kind: "attachment", at, subtype, attachment: unknown }
                      |
                      v
  event-row.tsx  [dispatch by kind]
    → finds EventRendererContribution { kind: "attachment" }
    → renders <AttachmentRow event={e} />
                      |
                      v
  attachment/web/components/attachment-row.tsx
    [reads JsonlViewerAttachment.Renderer contributions]
    resolveRenderer(subtype, contributions)
      1. exact: contributions.find(c => c.subtype === subtype)
      2. fallback: GenericAttachmentView
                      |
          ┌───────────┼───────────┬───────────┬───────────┐
          v           v           v           v           v
    NestedMemory  TaskReminder  DeferredTools  SkillListing  CommandPermissions
    Row           Row           DeltaRow       Row           Row
    (collapsed    (collapsed    (collapsed     (collapsed    (collapsed
     by default)   by default)   by default)    by default)   by default)
```

### Plugin dependency graph (new nodes in bold)

```
transcript-watcher/core/protocol.ts          ← modified (AttachmentEvent added)
transcript-watcher/server/parse-jsonl.ts     ← modified (attachment branch added)

jsonl-viewer/web/                            ← unchanged
  slots.ts  event-row.tsx

jsonl-viewer/plugins/attachment/             ← NEW plugin
  package.json
  CLAUDE.md
  core/index.ts                              ← AttachmentEvent, AttachmentRendererProps
  web/
    slots.ts                                 ← JsonlViewerAttachment.Renderer slot
    index.ts                                 ← registers EventRenderer for "attachment"
    components/
      attachment-row.tsx                     ← resolveRenderer + dispatch
      generic-attachment-view.tsx            ← fallback
  plugins/                                   ← sub-plugins added separately

framework/plugins/web-sdk/core/web.generated.ts  ← updated by ./equin build
```

---

## Changes Per File

### 1. `plugins/conversations/plugins/transcript-watcher/core/protocol.ts`

Add a new variant to the `JsonlEventSchema` discriminated union immediately before the `unknown` member:

```ts
z.object({
  kind: z.literal("attachment"),
  at: z.string(),
  subtype: z.string(),
  attachment: z.unknown(),
}),
```

The `subtype` field is a plain `string` (not a `z.union` of literals) so that future subtypes added by Claude Code are handled gracefully without schema changes. The full raw `attachment` object is preserved as `z.unknown()` so subtype renderers can cast it to their own typed interface without any central schema coupling.

No other fields are extracted at parse time — the attachment payload is deliberately opaque at this layer.

### 2. `plugins/conversations/plugins/transcript-watcher/server/internal/parse-jsonl.ts`

Add a new branch in the `for...of raw.split("\n")` loop, **before** the final `events.push({ kind: "unknown", ... })` fallback:

```ts
if (type === "attachment") {
  const att = obj.attachment;
  if (att && typeof att === "object") {
    const subtype =
      typeof (att as Record<string, unknown>).type === "string"
        ? (att as Record<string, unknown>).type as string
        : "unknown";
    events.push({ kind: "attachment", at: ts, subtype, attachment: att });
  }
  continue;
}
```

Place this block after the `type === "summary"` block and before the final fallback. The `continue` ensures the fallback is not reached.

Note: `attachment` lines have no `message` wrapper — the entire payload is flat on the top-level object, with `attachment` being a nested object. The parser does not need to parse `msg.role` or `msg.content` for this type.

### 3. `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core/index.ts`

New file. Exports the typed `AttachmentEvent` and `AttachmentRendererProps` for use by sub-plugins without going through the web barrel (mirroring `tool-call/core/index.ts`):

```ts
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";

export type AttachmentEvent = Extract<JsonlEvent, { kind: "attachment" }>;

export interface AttachmentRendererProps {
  event: AttachmentEvent;
}
```

### 4. `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web/slots.ts`

New file. Defines the sub-dispatch slot, mirroring `tool-call/web/slots.ts`:

```ts
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { ComponentType } from "react";
import type { AttachmentRendererProps } from "../core";

export interface AttachmentRendererContribution {
  subtype: string;
  component: ComponentType<AttachmentRendererProps>;
}

export const JsonlViewerAttachment = {
  Renderer: defineSlot<AttachmentRendererContribution>(
    "conversation.jsonl-viewer.attachment-renderer",
    { docLabel: (p) => p.subtype },
  ),
};
```

Only exact `subtype` matching is needed (no pattern/regex), so the contribution shape has just `subtype` and `component`. If a regex-based extension is needed in the future, the field can be added without breaking existing contributions.

### 5. `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web/components/attachment-row.tsx`

New file. The top-level row component that owns sub-dispatch:

```ts
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { JsonlViewerAttachment } from "../slots";
import type { AttachmentEvent } from "../../core";
import { GenericAttachmentView } from "./generic-attachment-view";

function resolveRenderer(
  event: AttachmentEvent,
  contributions: ReturnType<typeof JsonlViewerAttachment.Renderer.useContributions>,
) {
  const exact = contributions.find((c) => c.subtype === event.subtype);
  if (exact) return exact.component;
  return GenericAttachmentView;
}

export function AttachmentRow({ event }: { event: JsonlEvent }) {
  const e = event as AttachmentEvent;
  const contributions = JsonlViewerAttachment.Renderer.useContributions();
  const Renderer = resolveRenderer(e, contributions);
  return <Renderer event={e} />;
}
```

### 6. `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web/components/generic-attachment-view.tsx`

New file. Fallback renderer for unknown or unregistered subtypes. Uses the same collapsible pattern as `UnknownRow`:

```tsx
// Imports: useCollapsible, CollapsibleChevron from collapsible/web
// Imports: Timestamp from jsonl-viewer/web
// Shows: "attachment:<subtype>" label, chevron, timestamp in header
// Body: JSON.stringify(event.attachment, null, 2) in a <pre>
// defaultOpen: false (collapsed)
```

### 7. `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web/index.ts`

New file. The plugin definition:

```ts
export { JsonlViewerAttachment } from "./slots";
export type { AttachmentRendererContribution } from "./slots";

export default {
  id: "conversation-jsonl-viewer-attachment",
  name: "JSONL Viewer: Attachment event renderer",
  description:
    "Renders attachment JSONL events with subtype dispatch to per-attachment renderer plugins.",
  contributions: [
    JsonlViewer.EventRenderer({ kind: "attachment", component: AttachmentRow }),
  ],
} satisfies PluginDefinition;
```

The `JsonlViewerAttachment` slot and `AttachmentRendererContribution` type are re-exported from the web barrel so sub-plugins can import them as `@plugins/.../attachment/web`.

### 8. `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/package.json`

```json
{
  "name": "@singularity/plugin-conversations-conversation-view-jsonl-viewer-attachment",
  "private": true,
  "version": "0.0.1"
}
```

---

## Sub-Plugins (out of scope)

Individual sub-plugins for each attachment subtype (`nested-memory`, `task-reminder`, `deferred-tools-delta`, `skill-listing`, `command-permissions`) will be designed and implemented separately. Each will live at `attachment/plugins/<subtype>/` and contribute to the `JsonlViewerAttachment.Renderer` slot.

Until sub-plugins are added, all attachment events render via the `GenericAttachmentView` fallback (collapsed JSON dump with subtype label).

---

## Implementation Sequencing

Steps should be executed in this order — each depends on the previous:

1. **`protocol.ts`** — Add the `attachment` variant to `JsonlEventSchema`. This is load-bearing for everything else; all TypeScript types flow from here.

2. **`parse-jsonl.ts`** — Add the `type === "attachment"` branch. After this step, real transcripts will emit `kind: "attachment"` events instead of `kind: "unknown"`.

3. **`attachment/core/index.ts`** — Create `AttachmentEvent` and `AttachmentRendererProps`. No dependencies on later steps.

4. **`attachment/web/slots.ts`** — Define `JsonlViewerAttachment.Renderer`. Depends on core types.

5. **`attachment/web/components/generic-attachment-view.tsx`** — The fallback. Depends on slots and collapsible primitive.

6. **`attachment/web/components/attachment-row.tsx`** — The dispatch row. Depends on slots and generic fallback.

7. **`attachment/web/index.ts`** + **`attachment/package.json`** — Wire the plugin. After this step, the attachment plugin is self-contained and can be built; all attachment events will render via the generic fallback.

8. **`./equin build`** — Auto-discovers the new plugin, regenerates `web.generated.ts`, and deploys.

---

## `web.generated.ts` Expected Entries

The build system will add an entry of this form (manually verifiable after `./equin build`):

```ts
{ pluginPath: "conversations/..../jsonl-viewer/plugins/attachment",
  hierarchyPath: "conversations/conversation-view/jsonl-viewer/attachment",
  loader: () => import("@plugins/.../attachment/web"),
  dependsOn: [
    "conversations/plugins/conversation-view/plugins/jsonl-viewer",
    "primitives/plugins/collapsible",
  ] },
```

The `dependsOn` array must list `collapsible` because `GenericAttachmentView` uses `useCollapsible`.

---

## Import Paths Reference

The cross-plugin import rules require using barrels exclusively. The correct import paths for implementors:

| Need | Import path |
|---|---|
| `JsonlViewer.EventRenderer` slot | `@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web` |
| `Timestamp` component | `@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web` |
| `useCollapsible`, `CollapsibleChevron` | `@plugins/primitives/plugins/collapsible/web` |
| `AttachmentEvent`, `AttachmentRendererProps` | `@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core` |
| `JsonlViewerAttachment`, `AttachmentRendererContribution` | `@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web` |
| `PluginDefinition` | `@plugins/framework/plugins/web-sdk/core` |

Note: sub-plugins must NOT import from `attachment/web/slots.ts` directly (deep path). They must use `attachment/web` (the barrel).

---

## Verification

1. `./equin build` — should succeed with no TypeScript errors and no plugin-boundary violations.

2. Open a conversation known to contain attachment events (e.g. `conv-1779695590-m6pd`). Verify:
   - No attachment events render as `"Unhandled attachment event."` (the inline fallback from `EventRow` when no renderer is registered). If this text appears, the `attachment` plugin failed to register.
   - No attachment events render as `"kind: unknown"` yellow text. If this appears, `parse-jsonl.ts` branch is not reached.
   - All attachment events render via the generic fallback: collapsed `"attachment:<subtype>"` label with JSON dump on expand.

3. Run `./equin check --plugin-boundaries` — should pass with no violations.

4. Confirm `./equin check --plugins-doc-in-sync` passes (or update CLAUDE.md files manually if the check is strict about them).

---

## Design Decisions and Trade-offs

**Why `subtype: z.string()` instead of `z.union([z.literal("nested_memory"), ...])`?**
Claude Code can add new attachment subtypes at any version without a schema migration. A strict union would cause parse failures (Zod throws on unknown discriminants in `z.discriminatedUnion`) for new subtypes, producing `kind: "unknown"` again and defeating the point. The `z.string()` approach routes all attachment events through the attachment plugin, where unknown subtypes fall through to the generic fallback.

**Why a `core/` barrel for `AttachmentEvent` types?**
Sub-plugins need to cast the `event` prop to a typed `AttachmentEvent` and access `event.subtype` and `event.attachment`. Putting these types in `core/` (not `web/`) lets them import type-only without triggering a circular dependency (sub-plugin → `attachment/web` for the slot, and `attachment/web` → sub-plugins for contributions would be a cycle if types lived in `web/`). This exactly mirrors the `tool-call/core/index.ts` pattern.

**Why all subtypes collapsed by default?**
All five subtypes are injected automatically by the harness (not by the user), and most conversations contain 13+ `nested_memory` events alone. Expanding by default would make long conversations unreadably noisy. The collapsed single-line row gives visibility that the events exist while keeping the transcript scannable. Only events the user explicitly opens will show their content.

**Why no `pattern` field in `AttachmentRendererContribution`?**
Attachment subtypes are known constants (snake_case strings like `"nested_memory"`). Unlike tool names (which include namespaced MCP tools like `mcp__server__tool`) there is no evidence of pattern-based dispatch being useful here. The `resolveRenderer` function can be extended later if needed.
