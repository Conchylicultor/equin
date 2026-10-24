# `active-data` meta plugin — agent-rendered XML tags in assistant text

## Context

Agents currently emit assistant text that is rendered as plain markdown. We want agents to emit *interactive* widgets inline — clickable references, action buttons, dashboard cards — by writing XML-like tags in their output. A sub-plugin claims a tag name and ships its rendered component.

The motivating use case: an agent reads several `/api/conversations/:id/turns` and writes a triage dashboard back into its own conversation, with each referenced conversation rendered as a `<conv>conv-xxx</conv>` chip the user can click to open the conversation in a side pane. The architecture should be open enough that future sub-plugins (`<prompt>`, `<card>`, `<list>`, …) drop in without changes to the core.

**v1 ships only `<conv>`** as the proof of concept; everything else is deferred until the dashboard need is concrete.

## Architecture

Two existing patterns get composed:

1. **The `file-links` primitive** at `plugins/primitives/plugins/file-links/` is the inline-tag template. It exposes `linkifyChildren(children, onFileOpen)` (`web/internal/linkify-children.tsx`) which walks a React tree, splits string children with a regex, and replaces matches with a button. `assistant-text-row.tsx` calls it inside react-markdown component overrides (`p`, `li`, headings, …).
2. **The `JsonlViewer.EventRenderer` slot** (`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/slots.ts`) is the slot template: `defineSlot<{ kind, component }>` + child plugins contribute `{ kind, component }`, resolver does `.find(c => c.kind === event.kind)`.

`active-data` becomes a new primitive that combines them: it defines a slot whose discriminator is the tag name, and exports a tree-walker that integrates exactly the way `linkifyChildren` does.

### Folder layout

```
plugins/active-data/
  CLAUDE.md
  package.json
  web/
    index.ts                          # barrel: exports slot + helpers, defines parent plugin
    slots.ts                          # ActiveData.Tag slot
    internal/
      parse.ts                        # tag tokenizer
      render-active-data.tsx          # tree-walker (mirrors linkify-children.tsx)
  plugins/
    conv/
      CLAUDE.md
      package.json
      web/
        index.ts                      # barrel: contributes ActiveData.Tag({ tag: "conv", ... })
        components/
          conv-chip.tsx               # the rendered chip
```

The parent `active-data` barrel ships zero contributions of its own — like `file-links` and other primitives, it's a slot host plus reusable helpers. Sub-plugins live under `active-data/plugins/<tag>/` per the umbrella convention in `CLAUDE.md`.

### Slot shape

`plugins/active-data/web/slots.ts`:

```ts
import type { ComponentType, ReactNode } from "react";
import { defineSlot } from "@core";

export interface ActiveDataTagContribution {
  /** The XML tag name. Match is case-sensitive. Must be lowercased a-z, 0-9, '-'. */
  tag: string;
  /** Renderer for the parsed tag. Receives parsed attributes and the inner text. */
  component: ComponentType<{
    attrs: Record<string, string>;
    children: string;
  }>;
}

export const ActiveData = {
  Tag: defineSlot<ActiveDataTagContribution>("active-data.tag"),
};
```

Notes:
- `children: string` — v1 supports only flat tag bodies (a single text payload). Nested tags are out of scope; if a sub-plugin later needs them, the contract can grow to `children: ReactNode` and the renderer can accept already-walked children.
- Attribute parsing is included from day 1 even though `<conv>` doesn't use it — it costs almost nothing and keeps the contract stable for future tags (`<prompt conv="...">`, `<card title="...">`).
- The conversation context is **not** in the slot signature. Renderers that need it call `conversationPane.useData()` directly, the way `assistant-text-row.tsx` already does. This avoids coupling the primitive to any particular host surface.

### Parser

`plugins/active-data/web/internal/parse.ts`:

A single regex tokenizes balanced `<tag>…</tag>` pairs in plain text and returns a segment list:

```ts
export type ActiveDataSegment =
  | { type: "text"; value: string }
  | { type: "tag"; tag: string; attrs: Record<string, string>; children: string };

export const ACTIVE_DATA_TAG_RE =
  /<([a-z][a-z0-9-]*)((?:\s+[a-z][a-z0-9-]*="[^"]*")*)\s*>([\s\S]*?)<\/\1>/g;

export function parseActiveData(text: string): ActiveDataSegment[];
```

Behaviour:
- Matches lowercase tag names only (avoids colliding with HTML in markdown like `<br>`, `<details>`).
- Non-greedy body; no nesting. The first `</tag>` ends the current tag.
- Unmatched / malformed tags pass through as `text` segments. No throw.
- Attribute parser: split the captured attrs string on `\s+([a-z][\w-]*)="([^"]*)"`.

This matches the file-links parse approach (regex tokenizer that returns `text | path` segments — `plugins/primitives/plugins/file-links/web/internal/parse.ts`).

### Tree walker

`plugins/active-data/web/internal/render-active-data.tsx`:

A direct port of `linkify-children.tsx` (the existing file at `plugins/primitives/plugins/file-links/web/internal/linkify-children.tsx`). It:

- Recursively walks `ReactNode`.
- On a `string` child, runs `parseActiveData`, then for each `tag` segment looks up the matching contribution from `ActiveData.Tag.useContributions()` and renders `<contribution.component attrs={...} children={...} />`. Text segments pass through.
- Skips `code`, `pre`, and `a` elements (same set file-links skips) so tags inside fenced code render literally.
- If a segment's tag has no contributor, the literal text passes through unchanged.

Public surface:

```ts
// active-data/web/index.ts
export { ActiveData } from "./slots";
export type { ActiveDataTagContribution } from "./slots";
export { renderActiveData } from "./internal/render-active-data";
export { parseActiveData, ACTIVE_DATA_TAG_RE } from "./internal/parse";
export type { ActiveDataSegment } from "./internal/parse";
```

Because `useContributions()` is a hook, `renderActiveData` is implemented as a hook wrapper:

```tsx
export function useActiveDataRenderer(): (children: ReactNode) => ReactNode {
  const contributions = ActiveData.Tag.useContributions();
  const byTag = useMemo(
    () => new Map(contributions.map((c) => [c.tag, c])),
    [contributions],
  );
  return useCallback((children) => walk(children, byTag), [byTag]);
}
```

Consumers call it once at the top of their component, then use the returned function inside markdown overrides. (`linkifyChildren` doesn't need this because it has no slot lookup; here we do.)

### Integration in `assistant-text-row.tsx`

One file changes: `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/web/components/assistant-text-row.tsx`.

In `buildMdComponents`, compose active-data on top of file-links:

```tsx
const link = (children: ReactNode) => linkifyChildren(children, onFileOpen);
const active = useActiveDataRenderer();      // new
const transform = (children: ReactNode) => active(link(children));  // new

// Replace every `link(children)` call site with `transform(children)`.
```

Order matters: file-links runs first (so paths inside `<conv>conv-id</conv>` text don't get mis-linkified — though conv ids don't match the file-path regex, this future-proofs us), then active-data walks the resulting tree. The walker skips `<a>` and `<code>` elements, so file-links' output is left alone.

In the non-markdown branch (`<FileLinkText text={e.text} />`), do nothing for v1 — markdown mode is the dashboard surface. If non-markdown support is needed later, expose a sibling `<ActiveDataText text>` component that runs both passes on raw text.

### `<conv>` sub-plugin

`plugins/active-data/plugins/conv/web/index.ts`:

```ts
import type { PluginDefinition } from "@core";
import { ActiveData } from "@plugins/active-data/web";
import { ConvChip } from "./components/conv-chip";

export default {
  id: "active-data-conv",
  name: "Active Data: <conv> chip",
  description:
    "Renders <conv>conv-xxx</conv> as a clickable chip that opens the conversation in a side pane.",
  contributions: [ActiveData.Tag({ tag: "conv", component: ConvChip })],
} satisfies PluginDefinition;
```

`plugins/active-data/plugins/conv/web/components/conv-chip.tsx`:

```tsx
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";

export function ConvChip({ children }: { children: string; attrs: Record<string, string> }) {
  const convId = children.trim();
  const conv = useConversationById(convId);             // optional: for label/status
  return (
    <button
      type="button"
      onClick={() => conversationPane.open({ convId })}
      className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-muted/80"
      title={conv?.title ?? convId}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${conv ? "bg-emerald-500" : "bg-muted-foreground"}`} />
      <span>{conv?.title ?? convId}</span>
    </button>
  );
}
```

`useConversationById` is already exported from `@plugins/conversations/web`. If the id doesn't resolve, fall back to rendering the raw id (the chip still opens the pane — the pane handles 404s).

### Plugin registration

Add both new plugins to `web/src/plugins.ts` (the only place default-import is allowed per CLAUDE.md). Order doesn't matter since they only contribute to slots.

## Critical files

**New:**
- `plugins/active-data/package.json`
- `plugins/active-data/CLAUDE.md`
- `plugins/active-data/web/index.ts`
- `plugins/active-data/web/slots.ts`
- `plugins/active-data/web/internal/parse.ts`
- `plugins/active-data/web/internal/render-active-data.tsx`
- `plugins/active-data/plugins/conv/package.json`
- `plugins/active-data/plugins/conv/CLAUDE.md`
- `plugins/active-data/plugins/conv/web/index.ts`
- `plugins/active-data/plugins/conv/web/components/conv-chip.tsx`

**Modified:**
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/web/components/assistant-text-row.tsx` — add `useActiveDataRenderer()` and apply it after `linkifyChildren` in the md component overrides.
- `web/src/plugins.ts` — register the two new plugins.

## Reused existing pieces

- `linkifyChildren` / `FileLinkText` parse approach — `plugins/primitives/plugins/file-links/web/internal/linkify-children.tsx` (template, not imported)
- `defineSlot` + `useContributions` — `@core` (`plugin-core/slots.ts`)
- `conversationPane.open({ convId })` — `@plugins/conversations/plugins/conversation-view/web` (already exported)
- `useConversationById` — `@plugins/conversations/web` (already exported)
- `conversationPane.useData()` — for any future tag renderer that needs the host conversation

## Verification

1. **Build & boundaries**

   ```bash
   ./equin build
   ./equin check --plugin-boundaries
   ```

   Expect: clean build, no boundary violations. The `conv` sub-plugin imports only `@plugins/active-data/web` (the umbrella barrel) and `@plugins/conversations/...` (legal cross-plugin path).

2. **Doc sync**

   The `plugins-doc-in-sync` check should regenerate `docs/plugins-details.md` and `docs/plugins-compact.md` to include the new umbrella + child entries. `./equin build` runs the regen.

3. **End-to-end smoke**

   Open a conversation in the deployed worktree (`http://<worktree>.localhost:9000`). In a fresh conversation, prompt the agent:

   > Render `<conv>conv-abc-123</conv>` and `<conv>{actual-existing-id}</conv>` in your reply.

   Expect:
   - The placeholder `conv-abc-123` renders as a chip showing the raw id (no resolved title) and opens an empty conv pane on click.
   - The real id renders with the conversation's title and opens its pane on click.
   - Both work inside markdown (paragraphs, lists, table cells — every override that calls `transform`).
   - Tags inside fenced code blocks (` ```<conv>x</conv>``` `) render literally.

4. **Scripted check** (optional)

   Use `e2e/screenshot.mjs` to load a conversation that contains a known `<conv>` chip in its assistant text, click it, and assert the new pane URL contains `/c/<id>`.

## Out of scope / explicitly deferred

- `<prompt>`, `<card>`, `<list>`, attribute-driven variants — add as new sub-plugins when the dashboard need is concrete.
- Nested tags — bump the slot contract from `children: string` to `children: ReactNode` if/when a sub-plugin needs structured children.
- Non-markdown rendering of tags — current motivating UI is markdown mode only.
- Streaming-aware partial-tag rendering — assistant text comes pre-coalesced from `parse-jsonl.ts`, so the renderer always sees complete events; no partial-tag handling needed.
