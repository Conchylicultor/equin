# Page Editor Core — Task 2 Implementation Plan

## Context

Step 2 of the page plugin rollout. Task 1 (DB schema, server routes, Zod types, resource descriptors, live resources) is complete. The entire `web/` layer for `plugins/page/plugins/editor/` is absent — this task creates it.

**Goal:** Deliver `<BlockEditor documentId={...}>` that fetches blocks via live state, builds a tree, renders block types dispatched through an `Editor.Block` slot, manages focus state, and exposes a `BlockEditorAPI` to block-type plugins. Stub "unknown block" fallback for unregistered types.

## File Plan

```
plugins/page/plugins/editor/
  core/
    define-block.ts        ← NEW  Editor.defineBlock factory + BlockHandle type
    index.ts               ← EDIT  add Editor namespace + new exports
  web/                     ← NEW directory
    index.ts               # barrel + PluginDefinition
    slots.ts               # Editor.Block slot
    types.ts               # BlockEditorAPI, BlockRendererProps
    block-editor-context.tsx  # provider + useBlockEditor hook
    components/
      block-editor.tsx     # <BlockEditor> public component
      block-row.tsx        # recursive block renderer
```

No manual edit to `web.generated.ts` — `./equin build` regenerates it.

## 1. `core/define-block.ts` — Block type handle factory

```ts
import type { ZodTypeAny, z } from "zod";

export interface BlockHandle<T> {
  type: string;
  schema: ZodTypeAny;
  parse(data: unknown): T;
}

export function defineBlock<S extends ZodTypeAny>(opts: {
  type: string;
  schema: S;
}): BlockHandle<z.infer<S>> {
  return {
    type: opts.type,
    schema: opts.schema,
    parse: (data) => opts.schema.parse(data),
  };
}
```

Consumer API: `const textBlock = Editor.defineBlock({ type: "text", schema })`. Then `textBlock.parse(block.data)` returns typed data.

## 2. `core/index.ts` — extend barrel

Add to existing exports:

```ts
export { defineBlock } from "./define-block";
export type { BlockHandle } from "./define-block";
import { defineBlock } from "./define-block";
export const Editor = { defineBlock };
```

The `Editor` namespace in core holds only `defineBlock`. The web barrel exports a separate `Editor` with the `Block` slot. Consumers import from the runtime they need.

## 3. `web/types.ts` — API contracts

```ts
import type { ReactNode } from "react";
import type { Block } from "../core";

export interface BlockEditorAPI {
  update(data: unknown): void;
  split(position: number): void;
  remove(): void;
  indent(): void;
  outdent(): void;
  focusUp(): void;
  focusDown(): void;
  onFocus(): void;
}

export interface BlockRendererProps<T = unknown> {
  block: Block;
  isFocused: boolean;
  children: ReactNode;
  editor: BlockEditorAPI;
}
```

Matches the design doc exactly.

## 4. `web/slots.ts` — Editor.Block slot

```ts
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { ComponentType } from "react";
import type { BlockHandle } from "../core/define-block";
import type { BlockRendererProps } from "./types";

export interface BlockContribution {
  block: BlockHandle<unknown>;
  component: ComponentType<BlockRendererProps<unknown>>;
}

export const Editor = {
  Block: defineSlot<BlockContribution>(
    "page.editor.block",
    { docLabel: (p) => p.block.type },
  ),
};
```

Pattern: identical to `JsonlViewer.EventRenderer` — exact `type` string dispatch.

## 5. `web/block-editor-context.tsx` — Provider

Key design:

- **`focusedBlockId`** — `useState<string | null>` for reactive `isFocused` prop diffing.
- **`focusHandlesRef`** — `useRef(new Map<string, { focus: () => void }>())`. Block components register on mount, unregister on unmount.
- **`flatOrderRef`** — `useRef<Block[]>([])`. Written by `BlockEditorInner` after tree-flatten. Used by `focusUp`/`focusDown` to find adjacent blocks in visual order.
- **`makeBlockAPI(blockId)`** — stable factory (all deps via refs). Returns a `BlockEditorAPI` bound to one block.

Mutation strategy:
- `update()` → `void fetchEndpoint(updateBlock, ...)` — fire-and-forget, live-state push corrects the view. Per the endpoints CLAUDE.md this is the correct pattern: silent failure is self-correcting, state refreshes via WS.
- `split()`, `remove()`, `indent()`, `outdent()` → `fetchEndpoint` calls wrapped in a helper that calls the endpoint then sets focus to the appropriate block. These are also fire-and-forget since the live-state push will update the tree. Focus is set optimistically.

Focus registration: expose `registerFocusHandle(id, { focus }) → cleanup` on context. Block type components call this in a `useEffect`. The editor's `focusUp`/`focusDown` use `flatOrderRef` to find the target and call `focusHandlesRef.get(targetId)?.focus()`.

Context shape:

```ts
interface BlockEditorContextValue {
  documentId: string;
  focusedBlockId: string | null;
  setFocusedBlockId: (id: string | null) => void;
  registerFocusHandle: (id: string, handle: { focus: () => void }) => () => void;
  makeBlockAPI: (blockId: string) => BlockEditorAPI;
  setFlatOrder: (blocks: Block[]) => void;
}
```

## 6. `web/components/block-row.tsx` — Recursive block renderer

```tsx
function BlockRow({ node, depth }: { node: TreeNode<Block>; depth: number }) {
  const { focusedBlockId, makeBlockAPI } = useBlockEditor();
  const renderers = Editor.Block.useContributions();

  const api = useMemo(() => makeBlockAPI(node.id), [makeBlockAPI, node.id]);
  const isFocused = focusedBlockId === node.id;

  const match = renderers.find(c => c.block.type === node.type);

  const childElements = node.children.length > 0 ? (
    <div className="pl-6">
      {node.children.map(child => (
        <BlockRow key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  ) : null;

  if (!match) {
    return (
      <>
        <div className="px-3 py-1 text-xs text-muted-foreground font-mono">
          Unknown block: {node.type}
        </div>
        {childElements}
      </>
    );
  }

  const Comp = match.component;
  return <Comp block={node} isFocused={isFocused} editor={api} children={childElements} />;
}
```

- `pl-6` (24px) indentation per nesting level applied to the children wrapper
- Unknown fallback renders type name + any children below
- `BlockRendererProps.children` receives the pre-rendered child elements — by default the block ignores them and they render after; a block that renders `{children}` itself takes ownership

## 7. `web/components/block-editor.tsx` — Public component

```tsx
export function BlockEditor({ documentId }: { documentId: string }) {
  return (
    <BlockEditorProvider documentId={documentId}>
      <BlockEditorInner documentId={documentId} />
    </BlockEditorProvider>
  );
}
```

`BlockEditorInner`:
1. `useResource(blocksResource)` → all blocks
2. Filter by `documentId`, sort by `Rank.compare`
3. `buildTree(sorted)` → `TreeNode<Block>[]`
4. `flattenTree(roots)` → depth-first pre-order `Block[]` for focus nav
5. `useEffect` → `setFlatOrder(flat)` to keep context in sync
6. Render `roots.map(node => <BlockRow key={node.id} node={node} depth={0} />)`

`flattenTree` is a local helper (not exported):
```ts
function flattenTree<T extends { children: TreeNode<T>[] }>(nodes: TreeNode<T>[]): T[] {
  const result: T[] = [];
  for (const node of nodes) {
    result.push(node);
    result.push(...flattenTree(node.children));
  }
  return result;
}
```

## 8. `web/index.ts` — Barrel

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Editor } from "./slots";
export type { BlockContribution } from "./slots";
export type { BlockEditorAPI, BlockRendererProps } from "./types";
export { BlockEditor } from "./components/block-editor";
export { useBlockEditor } from "./block-editor-context";

export default {
  id: "page-editor",
  name: "Page Editor",
  description: "Block-based document editor component and slot system.",
  contributions: [],
} satisfies PluginDefinition;
```

No contributions from the editor itself — it defines slots that others contribute to.

## Implementation Order

1. `core/define-block.ts` — pure TS, zero deps
2. `core/index.ts` — extend barrel with new exports
3. `web/types.ts` — pure interfaces
4. `web/slots.ts` — slot definition
5. `web/block-editor-context.tsx` — provider + hook
6. `web/components/block-row.tsx` — recursive renderer
7. `web/components/block-editor.tsx` — public component
8. `web/index.ts` — barrel + plugin def

## Reused Primitives

| Need | Import from |
|------|-------------|
| `buildTree`, `TreeNode` | `@plugins/primitives/plugins/tree/core` |
| `Rank.compare` | `@plugins/primitives/plugins/rank/core` |
| `useResource` | `@plugins/primitives/plugins/live-state/web` |
| `fetchEndpoint` | `@plugins/infra/plugins/endpoints/web` |
| `defineSlot` | `@plugins/framework/plugins/web-sdk/core` |
| `blocksResource`, `Block` | `../core` (same plugin) |
| `updateBlock`, `splitBlock`, etc. | `../core` (same plugin) |

## Verification

1. `./equin build` — must succeed (regenerates `web.generated.ts`, compiles)
2. `./equin check` — plugin boundaries, barrel purity, no cycles
3. Navigate to the app — no runtime errors from the new plugin loading
4. Without any block type plugins, `<BlockEditor>` renders an empty container (no blocks in DB yet) or "Unknown block" rows if blocks exist
