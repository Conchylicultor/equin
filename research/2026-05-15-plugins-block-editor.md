# Block Editor Plugin — Notion-like Extensible Block Editor

## Context

The project vision calls for "a Notion-like surface where agents compose user-tailored apps from plugin building blocks." This plugin delivers the foundational editing primitive: a block-based document editor where each block type is a plugin contributing to a slot. Starting minimal with plain text blocks that support arbitrary nesting (outliner-style), then extensible to headings, images, code, embeds, etc. via the slot system.

**Hybrid approach:** We own the block tree (data model, nesting, reordering, keyboard navigation) and delegate inline text editing to Lexical, which is already in the codebase via `prompt-editor`.

## Plugin Structure

```
plugins/
  block-editor/                            # feature plugin (NOT under primitives/)
    core/
      index.ts                             # re-exports types, schemas, resources
      internal/
        types.ts                           # Block, BlockDocument TS types
        schemas.ts                         # Zod schemas
        resources.ts                       # client-side resourceDescriptors
    web/
      index.ts                             # PluginDefinition
      slots.ts                             # BlockEditor.Block slot
      components/
        block-editor.tsx                   # <BlockEditor documentId={...}>
        block-editor-provider.tsx          # context: tree state, focus, operations
        block-tree.tsx                     # flattened visible nodes renderer
        block-row.tsx                      # single row: indentation + type dispatch
    server/
      index.ts                             # ServerPluginDefinition: routes + resources
      internal/
        tables.ts                          # block_documents, blocks tables
        queries.ts                         # listBlocks, getBlock, etc.
        mutations.ts                       # CRUD + split/merge/indent/outdent
        routes.ts                          # HTTP handlers
        resources.ts                       # server-side defineResource
    plugins/
      text/                                # first block type plugin
        web/
          index.ts                         # contributes BlockEditor.Block
          components/
            text-block.tsx                 # Lexical-based inline text editor
            keyboard-plugin.tsx            # Enter/Backspace/Tab/Arrow handlers
        package.json                       # lexical + @lexical/react deps

  apps/plugins/
    block-editor/                          # app shell umbrella
      plugins/
        shell/                             # registers /editor app entry
          web/
            index.ts
            slots.ts                       # BlockEditorApp.Sidebar, .Toolbar
            components/
              block-editor-layout.tsx       # AppShellLayout wrapper
              document-list.tsx            # sidebar: document list + create button
```

## Data Model

### `block_documents` table

Mirror: none (simple container).

| Column       | Type                  | Notes                    |
| ------------ | --------------------- | ------------------------ |
| `id`         | `TEXT PK`             | nanoid                   |
| `title`      | `TEXT NOT NULL`       | default `''`             |
| `created_at` | `TIMESTAMPTZ NOT NULL` | default `now()`         |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | default `now()`         |

### `blocks` table

Mirror: `tasks` table pattern from `plugins/tasks-core/server/internal/tables.ts`.

| Column        | Type                  | Notes                                      |
| ------------- | --------------------- | ------------------------------------------ |
| `id`          | `TEXT PK`             | nanoid                                     |
| `document_id` | `TEXT NOT NULL FK`    | → `block_documents.id ON DELETE CASCADE`   |
| `parent_id`   | `TEXT FK`             | → `blocks.id ON DELETE CASCADE` (nullable) |
| `type`        | `TEXT NOT NULL`       | default `'text'`                           |
| `content`     | `TEXT NOT NULL`       | default `''` (plain text for v1)           |
| `rank`        | `rank_text NOT NULL`  | fractional index, from `@plugins/rank`     |
| `expanded`    | `BOOLEAN NOT NULL`    | default `true`                             |
| `created_at`  | `TIMESTAMPTZ NOT NULL` | default `now()`                           |
| `updated_at`  | `TIMESTAMPTZ NOT NULL` | default `now()`                           |

**Index:** `(document_id, parent_id, rank)` — efficient sibling queries scoped to a document.

Content is stored as plain text (not Lexical JSON), matching the `prompt-editor` serialization pattern. Split/merge are simple string operations on the server.

## Extensibility: Block Type Slot

**`plugins/block-editor/web/slots.ts`**

```ts
export const BlockEditor = {
  Block: defineRenderSlot<{
    type: string;
    component: ComponentType<BlockRendererProps>;
  }>("block-editor.block"),
};
```

Each block type plugin contributes a renderer:

```ts
// plugins/block-editor/plugins/text/web/index.ts
contributions: [
  BlockEditor.Block({ id: "text", type: "text", component: TextBlock }),
]
```

`BlockRow` looks up `contributions.find(c => c.type === block.type)` and renders the matching component.

### BlockRendererProps

```ts
interface BlockRendererProps {
  block: Block;
  isFocused: boolean;
  onContentChange: (content: string) => void;
  onEnter: (cursorPosition: number) => void;
  onBackspace: () => boolean;         // true = handled (delete/merge), false = let browser handle
  onIndent: () => void;               // Tab
  onOutdent: () => void;              // Shift+Tab
  onFocusUp: () => void;              // Arrow up at start
  onFocusDown: () => void;            // Arrow down at end
  onFocus: () => void;                // block gained focus
  editorRef: MutableRefObject<LexicalEditor | null>;
}
```

## Component Architecture

```
<BlockEditorProvider documentId={...}>
  ↳ useResource(blocksResource, { documentId })  → flat Block[]
  ↳ buildTree(blocks)                            → TreeNode<Block>[]
  ↳ flattenVisible(tree)                         → { block, depth }[]
  ↳ manages focusedBlockId + editorRef map
  ↳ exposes BlockEditorOperations via context

  <BlockTree>
    {visibleNodes.map(({ block, depth }) =>
      <BlockRow key={block.id} block={block} depth={depth} />
    )}
  </BlockTree>
</BlockEditorProvider>
```

### Focus Management

Each block's Lexical editor registers its instance via `editorRef`. The provider holds a `Map<blockId, RefObject<LexicalEditor>>`. On `focusBlock(id, 'start'|'end')`, the provider reads the ref and calls `editor.focus()` then dispatches a cursor-positioning command.

### Block Operations (Provider Context)

```ts
interface BlockEditorOperations {
  createBlock(parentId: string | null, afterBlockId?: string | null, content?: string): Promise<string>;
  updateContent(blockId: string, content: string): void;
  deleteBlock(blockId: string): Promise<void>;
  splitBlock(blockId: string, position: number): Promise<string>;
  mergeWithPrevious(blockId: string): Promise<void>;
  indentBlock(blockId: string): Promise<void>;
  outdentBlock(blockId: string): Promise<void>;
  focusBlock(blockId: string, position?: 'start' | 'end'): void;
  toggleExpanded(blockId: string): Promise<void>;
}
```

All mutations go through REST → server notifies resource → `useResource` auto-refreshes.

## Text Block Plugin

Each text block = its own `LexicalComposer` instance. This avoids cross-block state coupling and matches Lexical's design.

```
<LexicalComposer initialConfig={{ namespace: `block-${block.id}`, nodes: [], ... }}>
  <PlainTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={...} />
  <HistoryPlugin />                    # per-block undo/redo
  <ValueSyncPlugin />                  # two-way plain text ↔ Lexical (copy from prompt-editor)
  <EditorRefPlugin editorRef={ref} />  # exposes editor to parent
  <KeyboardPlugin ... />               # intercepts block-level keys
  <FocusPlugin isFocused={...} />      # external focus trigger
</LexicalComposer>
```

### Keyboard Handling (KeyboardPlugin)

Registers Lexical commands at `COMMAND_PRIORITY_HIGH`:

| Key              | Condition                  | Action                                                        |
| ---------------- | -------------------------- | ------------------------------------------------------------- |
| **Enter**        | no shift                   | `onEnter(cursorOffset)` → split block at cursor               |
| **Backspace**    | cursor at position 0       | `onBackspace()` → merge with previous or delete empty block   |
| **Tab**          | any                        | `onIndent()` → reparent under previous sibling                |
| **Shift+Tab**    | any                        | `onOutdent()` → reparent to grandparent level                 |
| **Arrow Up**     | cursor at line 1, col 0    | `onFocusUp()` → focus previous visible block (end)            |
| **Arrow Down**   | cursor at last line, end   | `onFocusDown()` → focus next visible block (start)            |

### Content Persistence

`useEditableField` wraps `onContentChange` with 400ms debounce + flush-on-blur. The text block passes `field.value` and `field.onChange` to `ValueSyncPlugin`, which handles the Lexical ↔ string two-way sync.

Reference: `plugins/primitives/plugins/editable-field/web/use-editable-field.ts`

## Server

### Routes

| Method | Path                                      | Description                            |
| ------ | ----------------------------------------- | -------------------------------------- |
| GET    | `/api/block-documents`                    | List all documents                     |
| POST   | `/api/block-documents`                    | Create document                        |
| PATCH  | `/api/block-documents/:documentId`        | Update title                           |
| DELETE | `/api/block-documents/:documentId`        | Delete document (cascades blocks)      |
| GET    | `/api/block-documents/:documentId/blocks` | List blocks (flat, ordered by rank)    |
| POST   | `/api/block-documents/:documentId/blocks` | Create block                           |
| PATCH  | `/api/blocks/:id`                         | Update content/parentId/rank/expanded  |
| DELETE | `/api/blocks/:id`                         | Delete block (cascades children)       |
| POST   | `/api/blocks/:id/split`                   | Split at position → new sibling below  |
| POST   | `/api/blocks/:id/merge-with-previous`     | Merge into previous, delete self       |

### Live State

```ts
// server-side
export const serverBlocksResource = defineResource({
  key: "block-editor.blocks",
  mode: "push",
  loader: async ({ documentId }) => db.select().from(_blocks).where(eq(...)).orderBy(asc(_blocks.rank)),
});

// client-side
export const blocksResource = resourceDescriptor("block-editor.blocks", z.array(BlockSchema), []);
```

Every mutation calls `serverBlocksResource.notify({ documentId })`.

### Key Mutations

- **`splitBlock(id, position)`**: Read block content, slice at `position`. Update current block with head content. Insert new sibling immediately after with tail content using `Rank.between(current, nextSibling)`. Focus new block at start.
- **`mergeWithPrevious(id)`**: Find previous visible block (previous sibling, or last descendant of previous sibling, or parent). Append current content to it. Delete current block. Focus merged block at the join point.
- **`indentBlock(id)`**: Find previous sibling. Reparent block as last child of that sibling via `nextRankUnder`. If no previous sibling, no-op.
- **`outdentBlock(id)`**: If block has a parent, reparent to grandparent level with rank after parent. If already root-level, no-op.

## App Shell

Follows the Forge pattern exactly.

**`plugins/apps/plugins/block-editor/plugins/shell/web/index.ts`**:
- Contributes `Apps.App({ id: "block-editor", icon: MdEditNote, tooltip: "Editor", component: BlockEditorLayout, path: "/editor" })`

**Layout**: `<AppShellLayout sidebarSlot={BlockEditorApp.Sidebar} toolbarSlot={BlockEditorApp.Toolbar} />`

**Sidebar**: Document list using `useResource(documentsResource)`. Each item opens `blockEditorPane`. "+" button creates a new document.

**Main area**: `<BlockEditor documentId={...} />` rendered inside the pane.

## Key Reuse

| Concern          | Reuse from                                                              |
| ---------------- | ----------------------------------------------------------------------- |
| Tree algorithms  | `buildTree`, `computeDrop` from `@plugins/tree/core`                    |
| Rank ordering    | `rankText`, `nextRankUnder`, `Rank.between` from `@plugins/rank`        |
| Live state       | `resourceDescriptor` + `useResource` from `@plugins/live-state`         |
| Inline editing   | Lexical (`LexicalComposer`, `PlainTextPlugin`) from `prompt-editor` dep |
| Autosave         | `useEditableField` from `@plugins/editable-field/web`                   |
| App shell        | `AppShellLayout` from `@plugins/app-shell/web`                          |
| Slots            | `defineRenderSlot` from `@plugins/slot-render/web`                      |
| ValueSync        | Pattern copied from `prompt-editor/web/components/prompt-editor.tsx:215` |

**NOT reused:** `TreeList` component — it's designed for sidebar-style navigation, not inline editing. We reuse the core algorithms but build our own block renderer.

## Implementation Order

1. **Tables + migration** — Create `tables.ts`, run `./equin build --migration-name add-block-editor`
2. **Core types** — `types.ts`, `schemas.ts`, `resources.ts`, barrel `index.ts`
3. **Server mutations + queries** — CRUD, split, merge, indent, outdent
4. **Server routes + resources** — REST handlers, `defineResource`, wire `ServerPluginDefinition`
5. **BlockEditor.Block slot** — `slots.ts`
6. **Provider + tree + row** — `BlockEditorProvider`, `BlockTree`, `BlockRow` components
7. **Text block** — Lexical setup, `ValueSyncPlugin`, `KeyboardPlugin`, `FocusPlugin`
8. **App shell** — Forge-pattern app entry, sidebar document list
9. **DnD** (stretch) — Block drag-and-drop using `computeDrop`

## Verification

1. `./equin build` compiles and deploys
2. Navigate to `/editor` app in the app switcher
3. Create a document → appears in sidebar
4. Click document → empty editor with one placeholder block
5. Type text → content persists (verify via `query_db`)
6. **Enter** → new block below, cursor moves to it
7. **Tab** → block indents (becomes child of previous sibling)
8. **Shift+Tab** → block outdents
9. **Backspace** on empty block → deleted, focus moves to previous
10. **Arrow up/down** at boundaries → focus navigates between blocks
11. Reload → all content and nesting preserved
