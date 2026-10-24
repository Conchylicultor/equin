# Ordered dispatch slots + Notion-style grouped block menus

## Context

The page editor's `/` slash menu (and its siblings: gutter `+`, Add-block picker, turn-into) lists block types in raw contribution order — a flat, unorganized list. Notion groups its menu by theme ("Basic blocks", "Media", …) in a curated order.

The reorder primitive already has everything needed to express this: the config_v2 `items` tree supports `{ type: "header", label, items }` container nodes, the node-type registry is extensible, and the materialized-origin staleness check forces agents to place every new contribution explicitly. **Groups live only in the config file** — block plugins stay completely group-blind (a deliberate decision: adding/removing/renaming groups touches one JSONC file, zero plugins).

Two structural gaps keep the slash menu from using it:

1. `Editor.Block` is a **dispatch slot** — dispatch slots aren't in the reorderable-slots manifest, and their contributions carry no `id` (the reorder entryKey is `pluginId:id`).
2. The grouping machinery is fused to `<Slot.Render>` rendering middleware; menus are **data consumers** that render their own rows.

Decisions confirmed with the user:
- **New slot kind `defineOrderedDispatchSlot`** (not a config flag, not blanket dispatch inclusion): dispatch semantics + structurally required `id`, one new marker string for the codegen scanner. Extends the "reorderability is a property of the constructor" doctrine: render = yes, mount = no, dispatch = no, **ordered-dispatch = yes**.
- **Menu scope**: slash + gutter `+` + Add-block picker render section headers; turn-into stays flat (it has its own "Turn into" eyebrow) but inherits the flattened config order.

## Design summary

```
config/page/editor/page.editor.block.jsonc     ← single source of truth: groups, labels, membership, order
        │  (config_v2 effective tree)
        ▼
useReorderedEntries(slotId, contributions)     ← NEW public reorder/web hook: descriptor lookup
        │                                         + useConfig + applyTree → data, no rendering
        ▼
useGroupedInsertableBlocks() → BlockSection[]  ← page/editor: header nodes → labeled sections,
        │                                         loose items → label-less sections, allowlist+label filter
        ▼
BlockTypeList({ sections, activeIndex, … })    ← section headers non-selectable; single FLAT
                                                  activeIndex over selectable rows (command-palette pattern)
```

Verified facts the design rests on:
- `useContributions()` items carry `_pluginId` (stamped generically, `web-sdk/core/types.ts:16-25`) — with `id` added, `entryKey` resolves.
- The contributions facet is slot-kind-agnostic (captures `id`/`slotId`/`pluginId` for dispatch contributions too), so the origin catalog materializes with no facet change.
- A reorder descriptor with no `.Render` host is inert — config registrations map over the manifest on both runtimes; only the new hook reads it.
- `NotificationsProvider` mounts at the framework root (`web-core/App.tsx:218`), so `useConfig` inside the grouping hook is safe everywhere `BlockEditor` renders, including the in-memory editor-toy demo.
- No `page ↔ reorder` import edge exists in either direction — `page/editor → reorder/web` is cycle-free.
- `asPath("page.editor")` = `page/editor` → config files land at `config/page/editor/page.editor.block{,.origin}.jsonc` (matching the existing `page.editor.turn-into.jsonc` next to them).

## Step 1 — `defineOrderedDispatchSlot` (slot-render)

`plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` — thin wrapper reusing the dispatch runtime verbatim; only the contribution TYPE differs:

```ts
export interface OrderedDispatchContribution<Props, Key extends string>
  extends DispatchContribution<Props, Key> {
  id: string;
  excludeFromReorder?: boolean;
}

export function defineOrderedDispatchSlot<Props, Key extends string = string, Extra extends object = {}>(
  id: string,
  config: DispatchSlotConfig<Props, Key, Extra & { id: string }>,
): OrderedDispatchSlot<Props, Key, Extra> {
  return defineDispatchSlot(...) as unknown as OrderedDispatchSlot<Props, Key, Extra>;
}
```

- Dispatch rendering (`.Dispatch`, single-match, item-middleware isolation at `render-slot.tsx:473-476`) is untouched. NO list-middleware plumbing for dispatch — menus consume data via the new hook.
- The wrapper's internal `defineDispatchSlot(...)` call is not a scanned marker (scanner keys on the literal call-site string with a leading string-literal id), so no phantom manifest entry.
- Barrel-export `defineOrderedDispatchSlot`, `OrderedDispatchContribution`, `OrderedDispatchSlot` from `slot-render/web/index.ts`.
- Update `slot-render/CLAUDE.md` doctrine table with the fourth kind.

## Step 2 — Codegen scanner: second marker

`plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-scan.ts`:

- `const ORDERED_DISPATCH_SLOT_MARKER = "defineOrderedDispatchSlot"` alongside `RENDER_SLOT_MARKER` (line 42).
- In `collectRenderSlotsStatic` (line 180), add a second literal scan mirroring the render-slot block (`findMarkerCalls` + `leadingStringLiteral`).
- **Skip the factory-producer pass** (`collectFactoryProducers`, line 94) for the new marker — no factory produces ordered-dispatch slots; keep minimal.
- Update the header comment in `reorderable-slots-gen.ts:32-42` ("every `defineRenderSlot` and `defineOrderedDispatchSlot`; mount slots excluded").

Everything downstream is already generic: manifest emission, catalog materialization (`collectReorderableSlots` skips id-less contributions at `reorderable-slots-gen.ts:122` — moot once ids exist), origin defaults preparer, web+server config registrations, `reorderDescriptors`.

## Step 3 — Convert `Editor.Block` + add `id` to all contributions

`plugins/page/plugins/editor/web/slots.ts:12-49`:

```ts
Block: defineOrderedDispatchSlot<BlockRendererProps, string, BlockMeta>(
  "page.editor.block",
  { key: (props) => props.block.type, fallback: UnknownBlock, docLabel: (c) => c.block?.type },
),
```

Update the exported `BlockContribution` alias to use `OrderedDispatchContribution`. Then add `id: <block>.type` to every `Editor.Block({...})` call site (~21 files, each `web/index.ts`): text, heading-1/2/3, bulleted-list, numbered-list, to-do, toggle, quote, divider, callout, code-block, image, video, audio, file, bookmark, embed, math/equation, page-link, sub-page. Example:

```ts
Editor.Block({ id: imageBlock.type, match: imageBlock.type, block: imageBlock, component: ImageBlock })
```

The required `id` makes any missed site a **compile error** (type-check gate). Note: `sub-page`'s type is `"page"` (`PAGE_BLOCK_TYPE`) → entryKey `page.sub-page:page`; it has no menu `label` so it never renders in menus regardless.

## Step 4 — Public read hook `useReorderedEntries` (reorder)

New file `plugins/reorder/web/internal/use-reordered-entries.ts`:

```ts
export function useReorderedEntries(
  slotId: string,
  contributions: Contribution[],
): ReorderState {
  const descriptor = reorderDescriptors.get(slotId);
  if (!descriptor) throw new Error(`useReorderedEntries: "${slotId}" is not a reorderable slot`); // before any hook — rules-of-hooks safe
  const cfg = useConfig(descriptor);
  const tree = (cfg.items ?? []) as ReorderTree;
  return useMemo(() => applyTree(contributions, tree), [contributions, tree]);
}
```

- Wraps the exact machinery the list middleware uses: `reorderDescriptors.get` (`web/internal/descriptors.ts:14-16`), `useConfig` (as `useReorderConfig` in `dnd-list-middleware.tsx:193-200`), `applyTree` (`web/internal/sorting.ts:84`).
- Hidden semantics respected: config-hidden contributions go to `state.hidden`, never appear in menus.
- No node-type registry involvement — hosts branch on `type === "header"` and read `payload.label`.
- Barrel exports from `reorder/web/index.ts`: `useReorderedEntries`, `isNodeData`, types `TopLevelEntry`, `ReorderNodeData`, `ReorderState` (all reorder-own symbols from `sorting.ts` — no cross-plugin re-export). Update `reorder/CLAUDE.md` Public API section.

## Step 5 — Grouped rendering in the page editor

### 5a. Grouping layer (`components/block-type-list.tsx`)

```ts
export interface BlockSection { label?: string; blocks: BlockHandle<unknown>[]; }

export function useGroupedInsertableBlocks(): BlockSection[]
// - Editor.Block.useContributions() + useEnabledBlockTypes() allowlist
// - useReorderedEntries("page.editor.block", contributions)
// - header nodes → { label: payload.label, blocks: members→.block, filtered }
// - runs of loose top-level items → label-less sections (flat default config ⇒
//   one leading label-less section == today's behavior)
// - spacer/unknown node types ignored; keep = label present && allowlisted;
//   empty sections dropped

export function flattenSections(sections: BlockSection[]): BlockHandle<unknown>[]
```

Extract the pure `entries → sections` transform into a plain function (unit-testable without config/provider stubs); the hook composes it. Redefine `useInsertableBlocks()` = `flattenSections(useGroupedInsertableBlocks())` — every flat consumer (turn-into, Add-block gate, `BlockTypeMenu`) inherits the config order for free. `filterBlockTypes` unchanged.

### 5b. `BlockTypeList` takes sections

Rework `BlockTypeList` props: `{ sections, activeIndex, onSelect, onHoverIndex }`. Copy the command-palette pattern (`primitives/command-palette/web/internal/command-palette-dialog.tsx:121,151,183-209`): running `flatIdx` counter over selectable rows only; section headers are non-interactive `<Text variant="caption">` eyebrows (never indexed); preserve `BlockTypeRow`'s per-row `scrollIntoView({ block: "nearest" })`; headers scroll with the list (not sticky); empty state when the flattened count is 0. Flat callers pass `[{ blocks }]` → renders exactly as today.

### 5c. Three callers

- **`block-menu-plugin.tsx`** (slash + gutter `+`): `sections = menu.query ? [{ blocks: filterBlockTypes(flattenSections(grouped), menu.query) }] : grouped`; `useCaretMenu({ itemCount: flat.length, onCommit: i => handleSelect(flat[i]!) })` — the caret-trigger's flat wrap-around index space is unchanged.
- **`block-type-picker.tsx`** (Add-block): same query-flattening; clamp nav over `flat.length`; `<Scroll className="max-h-72">` keeps the list as the sole scroll region.
- **`block-actions-menu.tsx`** (turn-into): stays flat — passes `[{ blocks: useInsertableBlocks() }]`, keeps its own "Turn into" eyebrow (lines 60-66).

Barrel: add `useGroupedInsertableBlocks`, `flattenSections`, `BlockSection` to `page/editor/web/index.ts`.

## Step 6 — Authored grouped config

New `config/page/editor/page.editor.block.jsonc` (hash stamped from the generated origin):

```jsonc
{
  "items": [
    { "type": "header", "label": "Basic blocks", "items": [
      "page.text:text", "page.heading.heading-1:heading-1", "page.heading.heading-2:heading-2",
      "page.heading.heading-3:heading-3", "page.bulleted-list:bulleted-list",
      "page.numbered-list:numbered-list", "page.to-do:to-do", "page.toggle:toggle",
      "page.quote:quote", "page.divider:divider", "page.callout:callout"
    ]},
    { "type": "header", "label": "Media", "items": [
      "page.image:image", "page.video:video", "page.audio:audio",
      "page.file:file", "page.bookmark:bookmark", "page.embed:embed"
    ]},
    { "type": "header", "label": "Advanced", "items": [
      "page.code-block:code-block", "page.math.equation:equation",
      "page.page-link:page-link", "page.sub-page:page"
    ]}
  ]
}
```

(`page.sub-page:page` is named to keep the tree exhaustive; its missing `label` keeps it out of menus.)

**Build sequence (chicken-and-egg on the `@hash`):**
1. Land Steps 1–5, run `./equin build --skip-checks` → regenerates the manifest (adds `page.editor.block`) and `config/page/editor/page.editor.block.origin.jsonc` (materialized catalog + `@hash`).
2. Author the override above, stamping the origin's `@hash`.
3. `./equin build` (full) → `reorder:configs-authored` (override exists — grandfathered list is empty, so this is mandatory), `config-origins-in-sync`, `reorderable-slots-in-sync` all green.

## Sequencing

1. **slot-render**: new kind + barrel + CLAUDE.md (self-contained).
2. **codegen**: second marker (no behavior change until a slot uses it).
3. **reorder**: `useReorderedEntries` + barrel exports (additive).
4. **page — atomic activation**: `Editor.Block` conversion + 21 ids + grouping layer + `BlockTypeList` rework + 3 callers + authored config + regenerated manifest/origin. Mutually dependent (type change forces ids; manifest entry forces authored override) — one commit, with the Step-6 build sequence inside it.

## Critical files

- `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` (+ `web/index.ts`, `CLAUDE.md`)
- `plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-scan.ts` (+ header comment in `reorderable-slots-gen.ts`)
- `plugins/reorder/web/internal/use-reordered-entries.ts` (new), `plugins/reorder/web/index.ts`, `plugins/reorder/CLAUDE.md`
- `plugins/page/plugins/editor/web/slots.ts`, `components/block-type-list.tsx`, `components/block-menu-plugin.tsx`, `components/block-type-picker.tsx`, `components/block-actions-menu.tsx`, `web/index.ts`
- ~21 block plugins' `web/index.ts` (mechanical `id:` addition)
- `config/page/editor/page.editor.block.jsonc` (new, authored) + generated origin + manifest

## Risks

- **Drift window behavior**: a new block plugin added before its config placement tail-appends into a trailing label-less section (fail-loud, visible) — self-correcting via `config-origins-in-sync` blocking push. Acceptable.
- **`BlockTypeList` signature change** is a breaking barrel export — verified only 3 in-plugin callers; type-check catches strays.
- **In-memory demo (editor-toy)**: shares the same slot layout (subId-less config is per-slot, intended); the allowlist filter inside sections keeps the curated palette correct and drops emptied sections. Provider risk resolved: `NotificationsProvider` is at the web-core root.
- **`useConfig` on a `.Render`-less slot**: descriptor registered from the manifest on both runtimes; subscription shared/kept-alive at the live-state layer. Inert until the hook reads it.

## Verification

1. `./equin check` — `type-check`, `reorderable-slots-in-sync`, `config-origins-in-sync`, `reorder:configs-authored` all pass.
2. **bun:test**: add a scanner case (ordered-dispatch call site scanned; the wrapper's own declaration not): `bun test plugins/framework/plugins/tooling/plugins/codegen`.
3. **vitest**: unit-test the pure `entries → sections` transform (header/loose/allowlist/empty-section cases) + `BlockTypeList` flat-index math with headers interleaved: `bun run test:dom plugins/page/plugins/editor`.
4. **e2e (scripted Playwright, `e2e/screenshot.mjs` pattern)** against `http://<worktree>.localhost:9000`:
   - Open a page, type `/` → menu shows "Basic blocks" / "Media" / "Advanced" captions; ArrowDown/Enter selects rows, skipping headers.
   - Type `/img` → headers vanish, filtered flat list, Enter converts to image block.
   - Gutter `+` opens the same grouped menu; Add-block button picker shows sections; turn-into stays flat.
   - Editor-toy demo (`/website/apps`) still renders its curated flat palette without crash.
