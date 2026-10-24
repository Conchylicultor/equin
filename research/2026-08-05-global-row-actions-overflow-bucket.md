# Row-action overflow: an authored `overflow` bucket in the reorder tree

## Context

A row's action cluster is an **open set** — any plugin can contribute into a
`defineItemActions` slot, and nothing bounds how many land on one row. There is
currently no way to say *which* actions stay inline and which collapse behind a
`⋯`: a surface's only two options are "all inline" or "don't contribute".

The Pages sidebar is the worst case, and worse than it first looks. Its tree row
today paints **five** trailing affordances in the narrowest column in the app:

```
[★ star] [🗑 delete] [📖 story]   [⋯ "Add page below"]   [+ add child]
└──────── 3 item actions ───────┘  └─ tree rowMenu ──┘   └─ tree +  ─┘
```

Three come from `pages.tree.row-actions` (two of them from plugins other than
the tree's own); the `⋯` and `+` are the tree primitive's own row chrome. Every
icon takes width from the page title it covers on hover.

The split must be **explicit and authored per surface**, not a magic count
threshold: which surface can afford how many inline icons is a judgement about
that surface's width and about which actions are reached often enough to deserve
one click.

**Decision already taken:** express the overflow bucket as a **group in the
reorder tree** — a node type in the `reorder.node-type` registry, sibling to
`header`/`spacer` — so the split is authored in the slot's existing config file,
git-committable, and visible in pen-edit mode. Pages (`pages.tree.row-actions`)
is the first consumer.

**Outcome.** One `⋯` per row, holding the authored overflow set:

```
[★ star] [⋯] [+]        ⋯ ▸ Delete page
                          ▸ Upgrade to story
                          ▸ Add page below
```

Reaching that means the tree's own `rowMenu` ⋯ is retired for this surface —
"Add page below" becomes an ordinary item action, so the row's action set is
**one open registry with one authored overflow bucket** rather than two parallel
mechanisms that each grow their own `⋯`.

## Design

### 1. Presentation is a region property, and `IconButton` already is the triple

An item action is an opaque `ComponentType<ItemActionProps<TRow>>`. Rendering one
inside a dropdown must yield a labelled menu row, not a ghost icon button — but
the host cannot introspect an opaque component.

It does not need to. `IconButton` **is** the generic `{ icon, label, onClick }`
action component (`plugins/primitives/plugins/icon-button/web/components/icon-button.tsx`),
and 2 of the 3 Pages contributors already render exactly it; `RowActionButton`
(`primitives/row-actions`) composes it too. So the presentation switch belongs
*there*, driven by an ambient context — the same shape as the `ControlSizeProvider`
that already decides `IconButton`'s size from its containing region.

New leaf plugin **`plugins/primitives/plugins/action-presentation/`** (web only):

```tsx
// <ActionPresentation mode="menu"> — declares what surface the region is
export function ActionPresentation({ mode, children }): ReactNode
export function useActionPresentation(): "inline" | "menu"   // default "inline"
// The menu form of an {icon,label,onClick} action.
export function MenuActionItem({ icon, label, onClick, disabled, shortcut }): ReactNode
```

`MenuActionItem` renders a `DropdownMenuItem` (icon + label text, optional
`DropdownMenuShortcut`); it imports only `css/ui-kit`. `IconButton` gains a
single branch at the top:

```tsx
if (useActionPresentation() === "menu")
  return <MenuActionItem icon={Icon} label={label} onClick={onClick}
                         disabled={disabled} shortcut={shortcut} />;
// …existing WithTooltip + Button aspect="icon" path, byte-identical
```

Nothing at any of `IconButton`'s ~85 call sites changes; the branch only fires
under a provider, which only the overflow node mounts. `variant`/`className`/
`tooltip` are inert in menu form (the label is visible; there is no ghost box to
style) — document that on the props.

**Cycle check.** `action-presentation → css/ui-kit`; `icon-button →
action-presentation, css/ui-kit, tooltip, shortcuts`. `ui-kit` imports neither.
DAG holds.

### 2. The `overflow` reorder node type

New sub-plugin **`plugins/reorder/plugins/node-types/plugins/overflow/`**,
modelled byte-for-byte on the existing `header` container
(`node-types/plugins/header/web/internal/node-type.tsx` + `components/header-box.tsx`):

```ts
const overflowSchema = z.object({ label: z.string().optional() });

export const overflowNodeType: ReorderNodeType<z.infer<typeof overflowSchema>> = {
  type: "overflow",
  container: true,
  schema: overflowSchema,
  render: (p) => <OverflowBox payload={p.payload} editMode={p.editMode}>{p.children}</OverflowBox>,
  // No `insert` — container creation is config-only, exactly like `header`.
};
```

`OverflowBox` has two forms, keyed on the `editMode` prop the registry already
hands every node type:

- **`editMode: false`** — a `DropdownMenu` whose trigger is the `⋯`
  (`DropdownMenuTrigger render={<Button variant="ghost" aspect="icon" …/>}` +
  `MdMoreHoriz`, the exact idiom `primitives/overflow-menu` already uses), and
  whose `DropdownMenuContent align="end"` wraps `children` in
  `<ActionPresentation mode="menu">`. Renders **nothing** when the container has
  no members, so an emptied bucket leaves no dangling trigger.
- **`editMode: true`** — a labelled bordered box (`"⋯ More"`) rendering `children`
  inline, mirroring `HeaderBox`, so an author can see and drag the bucket's
  members in pen-edit mode instead of having to open a menu that suppresses drag.

Payload `label` (default `"More"`) is the trigger's aria-label/tooltip.

**One-line middleware change.** `renderNode` wraps each pre-rendered container
member in `<span key={…}>` (`plugins/reorder/web/internal/dnd-list-middleware.tsx`,
~line 470). Add `className="contents"`. Every other wrapper on that path is
already `display:contents` in non-edit mode (`SortableReorderItem`'s `itemClassName`
and content div both resolve to `"contents"`), so this makes each
`DropdownMenuItem` a real layout child of `DropdownMenuContent`. Verify the
`header` container still paints identically.

### 3. Retire the Pages tree's `rowMenu` — one `⋯` per row

The tree primitive's `RowChrome` mounts its own `⋯` from `TreeViewOptions.rowMenu`,
alongside (not inside) the item-actions cluster. For Pages that menu holds exactly
one entry, "Add page below", whose `addBelow` comes from `useTreeRow(node)` —
which needs the node, so an item action cannot reach it today.

- **`primitives/tree`** — `RowChrome` already computes `RowControls` via
  `useTreeRow(node)`. Publish it: a `RowControlsContext` provider around the row's
  rendered subtree, plus an exported `useOptionalRowControls(): RowControls | null`.
  Optional-returning by construction, matching the plugin's existing
  `useOptionalTreeListContext()` rule — an item action renders in *every* view
  (list/table/gallery/tree), not just the tree.
  Files: `plugins/primitives/plugins/tree/web/internal/row-chrome.tsx`,
  `.../internal/use-tree-row.ts`, `web/index.ts`.
- **`apps/pages/page-tree`** — new `AddPageBelowAction`
  (`web/components/add-page-below-action.tsx`), contributed as
  `PageTree.RowActions({ id: "add-below", component: AddPageBelowAction })`. It
  reads `useOptionalRowControls()` and **returns `null` when absent** — so it is
  correctly invisible in the Favorites `list` view, which has no tree rows.
  Renders an `IconButton icon={MdAdd} label="Add page below"`.
- **`pages-sidebar.tsx`** — drop `viewOptions.tree.rowMenu` (and the now-unused
  `MdAdd` / `RowChromeMenuHelpers` / `RowMenuItem` imports). `rowMenu` stays a
  supported `TreeViewOptions` key for other surfaces; only Pages stops using it.

### 4. Convert the one hand-rolled contributor

`apps/story/pages-integration`'s `UpgradeAction`
(`web/components/upgrade-action.tsx`) hand-rolls a raw `<button>` with a
`layout/no-adhoc-layout` disable — the shape `icon-button/prefer-icon-button`
exists to steer away from. Replace with `IconButton icon={MdAutoStories}
label={isStory ? "Remove story" : "Upgrade to story"}`. This drops the lint
disable **and** makes it participate in menu presentation like its two siblings.

### 5. Author the split

`config/apps/pages/page-tree/pages.tree.row-actions.jsonc`:

```jsonc
{
  "items": [
    "apps.pages.starred:star",
    { "type": "overflow", "id": "row-overflow", "items": [
      "apps.pages.page-tree:delete",
      "apps.story.pages-integration:story",
      "apps.pages.page-tree:add-below"
    ]}
  ]
}
```

Star stays inline (one-click, high frequency); the rest collapse.

> Adding the `add-below` contribution **shifts the slot's origin `@hash`** (the
> origin default is the materialized catalog). `./equin build` regenerates
> `pages.tree.row-actions.origin.jsonc`; copy its new `@hash` into the override
> above, or `config-origins-in-sync` blocks `push`.

### 6. The legend is a hardcoded list of node types — fix it while adding to it

`buildOriginAnnotationsProvider` in
`plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts:191-195`
hardcodes one legend line per node type, and `plugins/reorder/shared/directive.ts`
carries a **second, already-stale copy** (it never learned about `header`). Adding
a third node type to a hardcoded list is exactly the leak `CLAUDE.md` warns about.

Hoist the lines to a single exported constant — `REORDER_NODE_LEGEND` in
`plugins/fields/plugins/reorder-tree/core` (the plugin that owns the tree format)
— and have both consumers read it. Add the `overflow` line there:

```
Overflow (⋯ menu): { "type": "overflow", "id": "<unique-id>", "items": [ "<key>", … ] }
```

Verify `framework/tooling/codegen/core → fields/reorder-tree/core` passes
`./equin check plugin-boundaries`; if it does not, keep the constant inline
in the gen and still collapse the two copies to one.

Full derivation from the live registry (each node type owning its own legend
string) is deliberately **out of scope** — the registry is web-only and the
codegen would need a barrel import per node-type plugin.

## Files

**New**
- `plugins/primitives/plugins/action-presentation/` — `package.json`, `CLAUDE.md`,
  `web/index.ts`, `web/internal/context.tsx`, `web/components/menu-action-item.tsx`
- `plugins/reorder/plugins/node-types/plugins/overflow/` — `package.json`,
  `CLAUDE.md`, `web/index.ts`, `web/internal/node-type.tsx`,
  `web/components/overflow-box.tsx`
- `plugins/apps/plugins/pages/plugins/page-tree/web/components/add-page-below-action.tsx`

**Modified**
- `plugins/primitives/plugins/icon-button/web/components/icon-button.tsx` (+ `CLAUDE.md`)
- `plugins/reorder/web/internal/dnd-list-middleware.tsx` (member `<span className="contents">`)
- `plugins/primitives/plugins/tree/web/internal/{row-chrome.tsx,use-tree-row.ts}`, `web/index.ts` (+ `CLAUDE.md`)
- `plugins/apps/plugins/pages/plugins/page-tree/web/{index.ts,components/pages-sidebar.tsx}` (+ `CLAUDE.md`)
- `plugins/apps/plugins/story/plugins/pages-integration/web/components/upgrade-action.tsx`
- `plugins/fields/plugins/reorder-tree/core/` (new `REORDER_NODE_LEGEND`)
- `plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts`
- `plugins/reorder/shared/directive.ts` (read the shared legend)
- `plugins/reorder/plugins/node-types/CLAUDE.md` ("Adding a node type" gains the legend step)
- `config/apps/pages/page-tree/pages.tree.row-actions.jsonc` (+ regenerated `.origin.jsonc`)

Registration is filesystem-derived — **never** hand-edit `web.generated.ts`;
`./equin build` discovers both new plugins.

## Verification

1. `./equin build` — regenerates the plugin registry, the reorderable-slots
   manifest, and the slot origin; then re-stamp the override's `@hash` and rebuild.
2. `./equin check` — `plugin-boundaries`, `plugins-registry-in-sync`,
   `reorderable-slots-in-sync`, `config-origins-in-sync`, `config:overrides-authored`,
   `type-check`, `eslint`.
3. Drive the real app at `http://<worktree>.localhost:9000/pages`:
   ```bash
   bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --url http://<worktree>.localhost:9000/pages --click "More" --out /tmp/pages-overflow
   ```
   Assert on the `-before`/`-after` pair: hovering a page row shows exactly
   `[★][⋯][+]`; the `⋯` opens **Delete page / Upgrade to story / Add page below**
   as labelled rows; each fires (delete trashes, story toggles, add-below creates
   a sibling); no second `⋯`.
4. Favorites (`list` view) — the star and delete still paint; **Add page below is
   absent** (no row controls outside a tree), and nothing crashes.
5. Pen-edit mode (toolbar pen) on the Pages sidebar — the overflow bucket renders
   as a labelled inline box with its three members draggable, not as a closed menu.
6. Regression: the `header` container still paints correctly after the
   `display:contents` member change — e.g. the page editor's block menu, whose
   config `config/page/editor/page.editor.block.jsonc` is four `header` groups.

## Follow-ups (not in scope)

- Derive the origin legend from the live node-type registry instead of a constant.
- The tree row's action cluster is `w-0 opacity-0` off-hover, so an open `⋯`'s
  trigger vanishes when the pointer leaves the row (pre-existing, shared with
  today's `rowMenu`). A `group-has-[[data-state=open]]/tree-row:` reveal in
  `tree-row-chrome.tsx` would fix the whole class.
- In-app creation/membership editing of containers is still config-only, per the
  reorder plugin's documented "containers are config-only this pass".
