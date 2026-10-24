# Collapsible blocks + toggle (`>`) block type

## Context

The page editor (`plugins/page/`) renders a flat-but-indented block tree. The
`page_blocks` table already has an `expanded boolean not null default true`
column, and the server already writes it (forced `true` on every structural
mutation) and already accepts it via `PATCH /api/blocks/:id`
(`UpdateBlockBodySchema.expanded`). **But the web UI never reads it** —
`flattenTree` recurses into every child unconditionally, so nothing is ever
collapsed and there is no chevron.

This change does two things:

1. **Generic collapsibility** — any block that has children can be
   collapsed/expanded with a chevron. The chevron is a hover gutter affordance
   (joins the existing `+`/drag cluster), pinned visible while a block is
   collapsed so hidden content is discoverable. Driven entirely by the existing
   `expanded` column.
2. **A dedicated toggle block** (`type: "toggle"`), reached by typing `> ` at
   line start (markdown shortcut). A toggle always shows the chevron (even with
   no children yet). Enter behavior is state-dependent:
   - **Collapsed** → splits into a sibling (like a bullet/to-do).
   - **Expanded** → the split-off content becomes the toggle's **first child**.

Design intent (per project rules): collapsibility is a *generic* block
capability, expressed via the existing `expanded` column and one chevron control
in the generic `BlockRow`. The toggle block is just a normal text block type
that opts into two generic handle flags — the editor core never names "toggle".

## Decisions (confirmed with user)

- **Chevron UI:** hover gutter affordance (not an inline twist), pinned when collapsed.
- **Toggle nesting:** collapsed → sibling (bullet-like); expanded → Enter creates a child.

## No DB / endpoint scaffolding needed

- `page_blocks.expanded` exists → **no migration**.
- `PATCH /api/blocks/:id` already accepts `expanded` (`handle-update-block.ts:14`) → **no new endpoint** for collapse.
- Only the **split** endpoint gains two optional generic fields (`asChild`, `childType`).

---

## Part A — Generic collapse (read `expanded`, render a chevron)

### A1. `editor/web/components/block-editor.tsx` — stop recursing into collapsed blocks

`flattenTree` (lines 34-39) must skip a node's children when it is collapsed,
and carry a `hasChildren` flag so `BlockRow` knows whether to show a chevron:

```ts
type FlatBlock = { block: Block; depth: number; hasChildren: boolean };

function flattenTree(nodes: TreeNode<Block>[], depth: number, out: FlatBlock[]): void {
  for (const node of nodes) {
    out.push({ block: node, depth, hasChildren: node.children.length > 0 });
    if (node.expanded) flattenTree(node.children, depth + 1, out);
  }
}
```

Because `expanded` defaults `true` for every existing row, behavior is
unchanged for current documents. Pass `hasChildren={f.hasChildren}` to
`<BlockRow>` (line 183-191). Bump the container padding from `pl-12` to `pl-16`
(line 182) to make room for a third gutter control.

### A2. `editor/web/types.ts` — new API method + split-options

```ts
export interface BlockEditorAPI {
  // …existing…
  /** Toggle this block's expanded/collapsed state (children show/hide). */
  setExpanded(expanded: boolean): void;
  /** Convert; opts.expanded also resets the open/collapsed state in the same PATCH. */
  convertTo(type: string, data: unknown, opts?: { expanded?: boolean }): void;
  split(position: number, opts?: { asChild?: boolean; childType?: string }): void;
}
```

### A3. `editor/web/block-editor-context.tsx` — implement `setExpanded`, thread split opts

```ts
setExpanded(expanded: boolean) {
  void fetchEndpoint(updateBlock, { id: blockId }, { body: { expanded } });
},
convertTo(type: string, data: unknown, opts?: { expanded?: boolean }) {
  void fetchEndpoint(updateBlock, { id: blockId }, { body: { type, data, ...(opts ?? {}) } });
},
split(position: number, opts?: { asChild?: boolean; childType?: string }) {
  void (async () => {
    const result = await fetchEndpoint(
      splitBlock, { id: blockId },
      { body: { position, ...(opts ?? {}) } },
    );
    /* …existing focus-the-created-block logic… */
  })();
},
```

Server-authoritative via live-state (consistent with every other editor
mutation — `update`, `convertTo`, etc.). The local Postgres `NOTIFY` → WS round
trip is fast; **caveat:** collapse isn't optimistic, so there's a tiny delay
before children hide. Acceptable for v1; can be made optimistic later if it
feels laggy.

### A4. `editor/web/components/block-row.tsx` — the chevron gutter control

`BlockRow` gains a `hasChildren: boolean` prop. Look up the block's handle to
detect a toggle (`collapsible === "always"`):

```tsx
const contributions = Editor.Block.useContributions();
const handle = contributions.find((c) => c.block.type === block.type)?.block;
const showChevron = hasChildren || handle?.collapsible === "always";
const collapsed = !block.expanded;
```

Render a third gutter button (chevron) **closest to the content**, with the
existing `+`/drag cluster shifted left so the three don't overlap. Suggested
absolute lefts (relative to `depth * INDENT`): chevron `-20`, drag `-40`, `+`
`-60` (was `-20`/`-40`). Visibility:

- shown only when `showChevron`;
- **pinned** (full opacity) when `collapsed` — so hidden content is discoverable;
- otherwise hover-only (`opacity-0 group-hover/row:opacity-60`), matching `+`/drag.

```tsx
{showChevron && (
  <button
    type="button"
    aria-label={collapsed ? "Expand" : "Collapse"}
    aria-expanded={!collapsed}
    onClick={() => api.setExpanded(collapsed)}
    className={cn(
      "absolute top-1 z-10 flex size-5 items-center justify-center rounded",
      "text-muted-foreground hover:bg-accent cursor-pointer",
      collapsed ? "opacity-60" : "opacity-0 group-hover/row:opacity-60",
    )}
    style={{ left: depth * INDENT - 20 }}
  >
    <MdChevronRight className={cn("size-4 transition-transform", !collapsed && "rotate-90")} />
  </button>
)}
```

(`MdChevronRight` rotated 90° = down-chevron when expanded; uses the same
`react-icons/md` set already imported here.)

### A5. `editor/core/define-block.ts` — `collapsible` flag

Add to `BlockHandle` and `defineBlock`:

```ts
/**
 * When "always", the editor shows the collapse chevron for this block type even
 * when it has no children yet (used by the toggle block). Omitted = the chevron
 * appears only when the block actually has children.
 */
collapsible?: "always";
```

---

## Part B — Toggle block type (`> `) with state-dependent Enter

### B1. `editor/core/define-block.ts` — generic split-into-child flag

```ts
/**
 * Enter-split behavior. By default a block splits into a sibling of the same
 * type. A block with this set instead nests the split-off content as its FIRST
 * CHILD *when it is currently expanded* (a collapsed block still splits into a
 * sibling). `childType` is the type created for that child. Generic — used by
 * the toggle block; the editor core never names a block type.
 */
splitChildWhenExpanded?: { childType: string };
```

### B2. `editor/core/endpoints.ts` — extend `SplitBlockBodySchema`

```ts
export const SplitBlockBodySchema = z.object({
  position: z.number().int().nonnegative(),
  asChild: z.boolean().optional(),
  childType: z.string().optional(),
});
```

### B3. `editor/server/internal/handle-split-block.ts` — first-child branch

After computing `beforeText`/`afterText` and writing `beforeText` back to the
original, branch on `body.asChild`:

- **`asChild` true:** create the new block as the original's **first child**:
  `parentId = block.id`, `type = body.childType ?? block.type`,
  `data = { text: afterText }`, and a rank *before* the current first child
  (`Rank.between(null, firstChildRank ?? null)` — query the min-rank child of
  `block.id`; if none, `Rank.between(null, null)`). Also set the original's
  `expanded: true` so the new child is visible.
- **else:** existing sibling logic (unchanged).

Keep using `Rank` from `@plugins/primitives/plugins/rank/core` (already
imported). The endpoint return shape (`{ original, created }`) is unchanged, so
the client's focus-the-created-block logic still works.

### B4. Thread the split decision from the renderer to the keyboard handler

The renderer knows the block's `expanded` state and its handle; the keyboard
plugin issues the split. Compute the options once and pass them down:

- **`editor/web/components/block-text-renderer.tsx`** — it already resolves
  `handle`. Add:
  ```ts
  const splitOptions =
    handle?.splitChildWhenExpanded && block.expanded
      ? { asChild: true as const, childType: handle.splitChildWhenExpanded.childType }
      : undefined;
  ```
  Pass `splitOptions={splitOptions}` into `<BlockTextEditor>`.
- **`editor/web/components/block-text-editor.tsx`** — accept the new
  `splitOptions` prop and forward it to `<KeyboardPlugin splitOptions={…} />`.
- **`editor/web/components/keyboard-plugin.tsx`** — accept `splitOptions`, keep
  it in a ref (mirroring `editorRef`), and call
  `editorRef.current.split(offset, splitOptionsRef.current)` in the Enter
  handler (line 89).

Net effect: an **expanded** toggle → Enter makes the split-off text its first
child (`text` block); a **collapsed** toggle → `splitOptions` is `undefined` →
normal sibling toggle (bullet-like). Children nest with Tab/indent as usual too.

### B4b. `editor/web/components/markdown-shortcut-plugin.tsx` — open toggles by default

When `> ` converts a line into a toggle, the toggle must start **expanded**
(open chevron), even if the source line happened to be collapsed. The plugin
already iterates `contributions` (each carries `c.block`); include the target
handle's `collapsible` flag in the rules table and pass `expanded: true` on the
convert for `collapsible === "always"` types:

```ts
// rules table (lines 37-44): also capture `collapsible: c.block.collapsible`
…
editorRef.current.convertTo(
  type,
  { ...(empty?.() ?? {}), text: remaining },
  collapsible === "always" ? { expanded: true } : undefined,
);
```

Fresh lines already default to `expanded = true`, so this only matters when
re-typing `> ` on a previously-collapsed block — but it makes "open by default"
guaranteed rather than incidental.

### B5. New sub-plugin `plugins/page/plugins/toggle/` (mirror `to-do/`)

- **`core/toggle-block.ts`**
  ```ts
  import { z } from "zod";
  import { MdChevronRight } from "react-icons/md";
  import { defineBlock } from "@plugins/page/plugins/editor/core";

  export const toggleDataSchema = z.object({ text: z.string() });

  export const toggleBlock = defineBlock({
    type: "toggle",
    schema: toggleDataSchema,
    label: "Toggle",
    icon: MdChevronRight,
    empty: () => ({ text: "" }),
    placeholder: "Toggle",
    markdownPrefixes: ["> "],
    collapsible: "always",
    splitChildWhenExpanded: { childType: "text" },
  });
  ```
- **`core/index.ts`** — `export * from "./toggle-block";`
- **`web/index.ts`** — register the shared text renderer (in-place reconcile, like to-do/bullet):
  ```ts
  import { Editor, BlockTextRenderer } from "@plugins/page/plugins/editor/web";
  import { toggleBlock } from "../core";
  export default {
    name: "Toggle Block",
    contributions: [
      Editor.Block({ match: toggleBlock.type, block: toggleBlock, component: BlockTextRenderer }),
    ],
  } satisfies PluginDefinition;
  ```
- **`package.json`** — copy `to-do/package.json`, rename to `@singularity/plugin-page-toggle`.
- **`CLAUDE.md`** — short prose + autogen block (build fills it).

`./equin build` auto-discovers the new web entry and regenerates
`web-sdk/core/web.generated.ts` and the plugin docs.

---

## Files touched

**Edit (editor plugin):**
- `plugins/page/plugins/editor/core/define-block.ts` — `collapsible`, `splitChildWhenExpanded`
- `plugins/page/plugins/editor/core/endpoints.ts` — `SplitBlockBodySchema.{asChild,childType}`
- `plugins/page/plugins/editor/server/internal/handle-split-block.ts` — first-child branch
- `plugins/page/plugins/editor/web/types.ts` — `setExpanded`, `split` opts
- `plugins/page/plugins/editor/web/block-editor-context.tsx` — impl
- `plugins/page/plugins/editor/web/components/block-editor.tsx` — `flattenTree` + padding
- `plugins/page/plugins/editor/web/components/block-row.tsx` — chevron control
- `plugins/page/plugins/editor/web/components/block-text-renderer.tsx` — compute `splitOptions`
- `plugins/page/plugins/editor/web/components/block-text-editor.tsx` — forward prop
- `plugins/page/plugins/editor/web/components/keyboard-plugin.tsx` — pass opts to `split`
- `plugins/page/plugins/editor/web/components/markdown-shortcut-plugin.tsx` — `> ` converts with `expanded: true`

**Create (toggle plugin):**
- `plugins/page/plugins/toggle/{core/toggle-block.ts, core/index.ts, web/index.ts, package.json, CLAUDE.md}`

No migration, no new endpoint.

---

## Verification

1. `./equin build` from the worktree; confirm it deploys clean (checks +
   docs in sync). App at `http://att-1780582408-qcy9.localhost:9000`.
2. Open the Pages app, create/open a page.
3. **Generic collapse:** create a block, Tab a second block under it to nest.
   Hover the parent row → chevron appears in the gutter. Click it → child hides
   and the chevron stays pinned. Click again → child reappears. Verify with a
   scripted Playwright run (`e2e/screenshot.mjs --click` on the chevron,
   before/after) and/or `mcp__singularity__query_db` that
   `select expanded from page_blocks where id = …` flips.
4. **Toggle shortcut:** on an empty line type `> ` → block converts to a toggle,
   **open by default** (`query_db` shows `expanded = true`); chevron shows the
   open state, pinned when later collapsed.
5. **Toggle Enter (expanded):** with the toggle open, type text and press Enter
   → a new child `text` block appears indented under the toggle (focus lands in
   it). Confirm via `query_db` the new block's `parent_id` = the toggle id.
6. **Toggle Enter (collapsed):** collapse the toggle, focus its title, press
   Enter → a new **sibling** toggle is created (parent_id unchanged), hidden
   children stay with the original.
7. **Regression:** existing pages still render all blocks (every row has
   `expanded = true`); bullets/to-dos/indent/outdent/drag-drop unaffected.
8. `./equin check` passes (plugin boundaries, migrations-in-sync, docs).
