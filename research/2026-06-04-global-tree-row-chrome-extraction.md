# Extract a shared `TreeRowChrome` layer; migrate the config tree onto it

**Date:** 2026-06-04
**Category:** global (`plugins/primitives/plugins/tree` + `plugins/config_v2/plugins/settings`)

## Context

The config settings nav (`/config/...`) is the only tree in the app with **inconsistent
row heights**. Every other tree (tasks, pages, agents) renders rows through the shared
`RowChrome` primitive, which applies one uniform `py-1 text-sm`, so rows stay the same
height. The config nav does **not** use the tree primitive at all — it hand-rolls rows
with `Collapsible` + raw `<button>`/`<div>`, and across its row kinds it drifts:
`py-1` vs `py-1.5`, `text-xs` vs `text-sm`, plus a `size-5` badge that stretches some
rows (`config-tree-node.tsx:40,125,158`, `config-row-badge.tsx:19`).

It opted out for a *legitimate* reason: the tree primitive is an **editable-tree**
primitive — `RowChrome`/`TreeList`/`useTreeRow` bundle DnD reorder (dnd-kit, `rank`,
drop zones, drag handle), inline `RenameInput`, and add-child. The config nav is a
**read-only navigation tree** with externally-managed collapse state and four
heterogeneous row kinds; it wants none of that machinery. But opting out of *editing*
should not have meant opting out of *consistent row height*.

**Root structural issue:** the primitive conflates two separable concerns — (1) row
chrome/layout (indentation + fixed height + chevron alignment), which *every* tree
wants, and (2) tree editing (DnD/rename/add-child). Because (1) is welded inside (2),
a read-only consumer can't get height consistency without swallowing the editing
apparatus, so it reinvents rows and loses the invariant.

**Outcome:** factor out a context-free presentational `TreeRowChrome` that owns the
layout invariant (indentation, fixed height via `min-h-7`, chevron slot). `RowChrome`
composes editing on top of it; the config nav consumes it directly. This fixes the
config tree *and* retroactively locks a fixed height for every existing tree.

## Key findings from exploration

- The pure-layout part of `RowChrome` is just the inner row `<div>` (`row-chrome.tsx:104–130`):
  `paddingLeft: depth*16+4`, `py-1`, chevron `<button>` + `CollapsibleChevron`, the
  `{children}` slot, the `{actions}` slot. It has **zero** dnd-kit / rank / rename dependency.
- The DnD bits are all in the **wrapper**: the `group/row relative` div, the absolutely
  positioned drag handle (`row-chrome.tsx:44–90`), and the `beforeRef`/`afterRef` drop
  zones (`132–146`). Recursion + the add-child button (`148–168`) are wrapper concerns too.
- `useTreeRow` cleanly separates: layout/select members (`isSelected`, `isOpen`,
  `hasChildren`, `select`, `toggleExpanded`) vs DnD members (`dragHandleProps`, `childRef`,
  `beforeRef`, `afterRef`, `isOver*`, `isDragging`) vs editing (`addChild`, `addBelow`).
- `TreeList` owns the `DndContext`; there is no external DnD provider. A context-free
  chrome component therefore needs no provider at all.
- Config nav: read-only, collapse held as `collapsed: Set<string>` in `ConfigNav`
  (`config-nav.tsx:24`), keyed by `node.hierarchyId`. Four row kinds in
  `config-tree-node.tsx`: multi-config group (`118`), pure group (`151`), combined
  selectable+expandable (`170`), leaf (`198`); plus the flat search row `config-nav-row.tsx`.
- Consumers of the tree primitive that must keep working unchanged: `pages-sidebar.tsx`,
  `agents-list.tsx`, `tasks-list.tsx` (all via `RowChrome`), and the two
  `expand-collapse-all-action.tsx` (via `useSubtreeExpandAll`, untouched).

## Decisions (confirmed with user)

- **Indentation:** match the primitive's `depth*16+4` (true cross-app consistency).
- **Group headers:** unify to `text-sm` — all config rows look identical; folder-vs-item
  distinction comes only from the chevron + non-selectability. (Removes the `text-xs`
  eyebrow styling entirely.)

## Implementation

### 1. New primitive: `TreeRowChrome` (the extracted layout layer)

**New file:** `plugins/primitives/plugins/tree/web/internal/tree-row-chrome.tsx`

A pure presentational component — **no hooks, no context, no dnd-kit**. Props:

```ts
export type TreeRowChromeProps = {
  depth: number;
  hasChildren: boolean;
  isOpen: boolean;
  selected?: boolean;
  onToggle?: () => void;     // chevron click (stopPropagation internally)
  onSelect?: () => void;     // row click
  children: ReactNode;       // label / content
  actions?: ReactNode;
  className?: string;        // editable wrapper injects DnD state classes
  rowRef?: Ref<HTMLDivElement>; // editable wrapper attaches childRef (scroll + drop)
  indentStep?: number;       // default 16
};
```

Renders exactly today's inner row, with the **height invariant added**:

```tsx
<div
  ref={rowRef}
  onClick={onSelect}
  className={cn(
    "group flex min-h-7 items-center gap-1 rounded px-1 py-1 text-sm",
    "hover:bg-accent",
    selected && "bg-accent",
    className,
  )}
  style={{ paddingLeft: depth * (indentStep ?? 16) + 4 }}
>
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
    aria-label={isOpen ? "Collapse" : "Expand"}
    className={cn(
      "flex size-5 shrink-0 items-center justify-center rounded hover:bg-background/60",
      hasChildren ? "opacity-40 group-hover:opacity-100" : "opacity-0 group-hover:opacity-60",
    )}
  >
    <CollapsibleChevron open={isOpen} className="size-4" />
  </button>
  {children}
  {actions && (
    <div onClick={(e) => e.stopPropagation()}
         className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
      {actions}
    </div>
  )}
</div>
```

`min-h-7` (28px) is the fix: row height is now floor-locked and uniform regardless of
which leading/trailing content a consumer injects. The always-rendered `size-5` chevron
slot also provides the alignment that config currently fakes with a `size-3` spacer.

**Barrel** (`tree/web/index.ts`): add
`export { TreeRowChrome } from "./internal/tree-row-chrome";` and
`export type { TreeRowChromeProps } from "./internal/tree-row-chrome";`.

### 2. Refactor `RowChrome` to compose `TreeRowChrome`

**File:** `plugins/primitives/plugins/tree/web/internal/row-chrome.tsx`

Keep the wrapper, drag handle, drop zones, recursion, and add-child button exactly as
they are. Replace **only** the inner row `<div>` (lines 104–130) with:

```tsx
<TreeRowChrome
  depth={depth}
  hasChildren={r.hasChildren}
  isOpen={r.isOpen}
  selected={r.isSelected}
  onToggle={r.toggleExpanded}
  onSelect={r.select}
  rowRef={r.childRef}
  className={cn(
    r.isDragging && "opacity-40",
    r.isOverChild && "bg-accent ring-primary/40 ring-1",
    className,
  )}
  actions={actions}
>
  {children}
</TreeRowChrome>
```

Net effect for existing trees: identical look **plus** a fixed `min-h-7` (no regression —
current rows are already ~28px; this only locks the floor). This simultaneously resolves
the original "no height invariant in `RowChrome`" issue for tasks/pages/agents.

### 3. Migrate the config nav onto `TreeRowChrome`

Drop the `Collapsible` wrapper (config keeps its own `collapsed: Set` + conditional
recursion, matching how `RowChrome` itself renders children — note this removes the
expand/collapse *animation*, aligning config with every other tree, which also doesn't
animate).

**`config-tree-node.tsx`** — rewrite all four kinds + `ConfigLeafRow` /
`ConfigSelectableRow` to render `TreeRowChrome`. Content passed as `children` is
`<span className="flex-1 truncate">{label}</span>` followed by `<ConfigRowBadge .../>`
(badge moves into the row body; the badge already `shrink-0`s and now sits in a fixed
`min-h-7` row). Mapping:

| Kind | `hasChildren` | `isOpen` | `onToggle` | `onSelect` | label |
|---|---|---|---|---|---|
| Multi-config group (`reg.length>1`) | true | `!collapsed.has(id)` | toggle | toggle | `node.name` (now `text-sm`) |
| Pure group (`children && !reg`) | true | ″ | toggle | toggle | `node.name` |
| Combined (`children && reg`) | true | ″ | toggle | open config | `node.name` |
| Leaf (`reg`, no children) | false | — | — | open config | `node.name` |
| Per-reg row (inside multi-config) | false | — | — | open config | `reg.descriptor.name` |

After the row, render `{isOpen && (...children + per-reg rows...)}` recursively at
`depth+1`. Remove the `Collapsible*` imports and the `size-3` spacer (`ConfigLeafRow`
no longer needed — `TreeRowChrome`'s reserved chevron slot handles alignment).

**`config-nav-row.tsx`** (flat search/modified mode) — render `TreeRowChrome` with
`hasChildren={false}`, `depth={0}`, `selected`, `onSelect={onClick}`, the same
label+badge children. Keep the `hideIfUnmodified` early-return. This unifies flat-mode
row height with tree-mode.

**`config-row-badge.tsx`** — unchanged.

**`config-nav.tsx`** — unchanged logic; it already owns `collapsed`/`onToggle` and passes
them down. (The `text-xs` eyebrow styling disappears because it lived in the now-removed
`CollapsibleTrigger` classNames.)

### Critical files

- `plugins/primitives/plugins/tree/web/internal/tree-row-chrome.tsx` — **new**
- `plugins/primitives/plugins/tree/web/index.ts` — add exports
- `plugins/primitives/plugins/tree/web/internal/row-chrome.tsx` — compose `TreeRowChrome`
- `plugins/config_v2/plugins/settings/web/components/config-tree-node.tsx` — rewrite onto chrome
- `plugins/config_v2/plugins/settings/web/components/config-nav-row.tsx` — rewrite onto chrome
- `plugins/config_v2/plugins/settings/web/components/config-nav.tsx` — minor (unchanged logic)

## Notes / constraints

- New cross-plugin edge: `config_v2/settings/web → primitives/tree/web`. Legal (runtime
  barrel import), DAG-safe.
- `TreeRowChrome` deliberately takes **no** `TreeNode`/`TreeItem`/`rank` — config carries
  no `rank` and must not need one. Coupling stays at zero.
- Removing the `Collapsible` animation in config is intentional (consistency with all
  other trees). Flag if the animation is considered worth preserving — if so, the chrome
  can still be used as the trigger content, but that reintroduces the nested-button
  concern the current combined-row markup works around.

## Verification

1. `./equin build` from the worktree; confirm it deploys clean (build runs
   `./equin check` — eslint + boundaries must pass).
2. Open `http://att-1780527965-8fvu.localhost:9000/config` and visually confirm **every**
   config row is the same height (groups, leaves, combined, multi-config children, and
   flat search results). Scripted check with the e2e helper:
   ```bash
   bun e2e/screenshot.mjs --url http://att-1780527965-8fvu.localhost:9000/config --out /tmp/config-tree
   ```
   Inspect `/tmp/config-tree-before.png`; rows should have uniform 28px height.
3. Exercise behavior: click a folder chevron → expands/collapses (collapse `Set` still
   works); click a leaf/combined row → opens its config detail pane; type in the filter →
   flat rows render at the same height; toggle "Modified" → only modified rows, uniform.
4. Regression-check the editable trees are visually unchanged and still drag/rename:
   Tasks (`/`), Pages (`/pages`), Agents — confirm DnD reorder, inline rename, and
   add-child still work and rows look identical to before (now with a locked min-height).
