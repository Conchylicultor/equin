# JsonlViewer: Event Renderer Sub-Plugins

## Context

The `jsonl-viewer` plugin renders six event kinds (user-text, assistant-text, assistant-tool-use, user-tool-result, system, summary) in a single monolithic `EventRow` switch. This makes each renderer tightly coupled — impossible to disable, replace, or extend individually. Decomposing into a slot-based sub-plugin pattern (the same as `FilePane.Renderer`) gives each event type its own isolated plugin that can be independently configured, swapped, or disabled.

## Design

### Slot definition

A new `JsonlViewer.EventRenderer` slot is defined in `jsonl-viewer/web/slots.ts`:

```typescript
export interface EventRendererContribution {
  kind: JsonlEvent["kind"];          // which event kind this handles
  component: ComponentType<{ event: JsonlEvent; markdownMode?: boolean }>;
}

export const JsonlViewer = {
  EventRenderer: defineSlot<EventRendererContribution>(
    "conversation.jsonl-viewer.event-renderer",
  ),
};
```

The `component` receives the full `JsonlEvent` union; each sub-plugin narrows it via a type assertion (`as Extract<JsonlEvent, { kind: "..." }>`). `markdownMode` is passed through from the pane-level toggle (only `assistant-text` uses it; others ignore it).

### Dispatcher

`event-row.tsx` becomes a thin slot dispatcher — contributions are read once from the slot, the matching renderer is found by `kind`, and rendered:

```tsx
export function EventRow({ event, markdownMode }) {
  const contributions = JsonlViewer.EventRenderer.useContributions();
  const match = contributions.find((c) => c.kind === event.kind);
  if (!match) return null;
  return <match.component event={event} markdownMode={markdownMode} />;
}
```

`jsonl-pane.tsx` is unchanged — it still renders `<EventRow>`.

### Shared utility

`jsonl-viewer/web/utils.ts` — exports `formatTime(iso: string): string` (the only utility needed across multiple sub-plugins). Each sub-plugin imports it via `../../../web/utils`.

`formatInput()`, `MD_COMPONENTS`, and `REMARK_PLUGINS` stay in their respective sub-plugin component files (they're not shared).

### Sub-plugins

Six sub-plugins under `jsonl-viewer/plugins/`:

| Sub-plugin dir    | `kind` handled       | Notes |
|-------------------|----------------------|-------|
| `user-text`       | `user-text`          | Plain text in muted box |
| `assistant-text`  | `assistant-text`     | Markdown toggle via `markdownMode` prop |
| `assistant-tool-use` | `assistant-tool-use` | Collapsible details with JSON input |
| `user-tool-result`   | `user-tool-result`   | Collapsible, error styling when `isError` |
| `system`          | `system`             | Italic line with subtype label |
| `summary`         | `summary`            | Centered separator |

Each sub-plugin has the same minimal structure (no `package.json` workspaces registration needed — nested packages use TypeScript path aliases, matching the `file-pane` sub-plugins pattern):

```
plugins/<kind>/
├── package.json          { name: "@singularity/plugin-jsonl-<kind>", private: true, version: "0.0.1" }
└── web/
    ├── index.ts          export default { id, name, contributions: [JsonlViewer.EventRenderer({ kind, component })] }
    └── components/
        └── <kind>-row.tsx
```

Imports from the parent plugin use relative paths (same pattern as `file-pane/plugins/diff`):
```typescript
import { JsonlViewer } from "../../../web/slots";
import { formatTime } from "../../../web/utils";
```

## Implementation Steps

### Step 1 — Slot

Create `jsonl-viewer/web/slots.ts` with `JsonlViewer.EventRenderer` slot definition (see above).

### Step 2 — Export slot from barrel

In `jsonl-viewer/web/index.ts`, add:
```typescript
export { JsonlViewer } from "./slots";
export type { EventRendererContribution } from "./slots";
```

### Step 3 — Shared utility

Create `jsonl-viewer/web/utils.ts` with just `formatTime()` (extracted from current `event-row.tsx`).

### Step 4 — Rewrite `event-row.tsx`

Replace the monolithic switch with the slot dispatcher (shown above). Keep the file at the same path so `jsonl-pane.tsx` import is untouched.

### Step 5 — Six sub-plugins

For each event kind, create `plugins/<kind>/package.json`, `plugins/<kind>/web/index.ts`, and `plugins/<kind>/web/components/<kind>-row.tsx`. Move the rendering code from the old `event-row.tsx` into the respective component file. `assistant-text` retains `MD_COMPONENTS` and `REMARK_PLUGINS` locally; `assistant-tool-use` retains `formatInput()` locally.

### Step 6 — Register in `web/src/plugins.ts`

Add six new import + registration entries following the existing pattern:

```typescript
import userTextPlugin from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/user-text/web";
import assistantTextPlugin from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/web";
// … (4 more)

export const plugins = [
  // existing…
  userTextPlugin,
  assistantTextPlugin,
  assistantToolUsePlugin,
  userToolResultPlugin,
  systemPlugin,
  summaryPlugin,
];
```

### Step 7 — Deploy and verify

```bash
./equin build
```

## Critical Files

| File | Action |
|------|--------|
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/slots.ts` | **Create** — slot definition |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/utils.ts` | **Create** — `formatTime` |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/index.ts` | **Modify** — export slot |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/event-row.tsx` | **Modify** — slot dispatcher |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/*/web/index.ts` (×6) | **Create** |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/*/web/components/*-row.tsx` (×6) | **Create** |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/*/package.json` (×6) | **Create** |
| `web/src/plugins.ts` | **Modify** — register 6 new sub-plugins |

`jsonl-pane.tsx`, `panes.tsx`, `jsonl-button.tsx`, and all server files are **unchanged**.

## Verification

1. `./equin build` succeeds (no TS errors, no plugin boundary violations)
2. Open any conversation → JSONL pane auto-opens
3. All six event types render identically to before
4. Markdown toggle still works for assistant-text events
5. `./equin check --plugin-boundaries` passes
