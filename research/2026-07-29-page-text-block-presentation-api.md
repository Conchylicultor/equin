# Page editor — a text block's presentation is styling plus sibling regions

Supersedes **Stage 3** of
[`2026-07-28-page-block-write-ownership.md`](./2026-07-28-page-block-write-ownership.md).
Stages 1 and 2 of that plan are unchanged and re-land with this one.

## Context

Stage 3 gave a text-bearing block type a declarative `chrome` facet
(`{padding, containerClassName, inset, marker, contentClassName}`) applied by one
shared renderer onto a fixed element tree, plus a type-level union making it a
compile error for such a type to register its own `component`. The union is the
load-bearing half and it stays. The facet does not survive contact with `main`.

Two things moved after the branch point:

- **`callout` left the text-bearing set.** It is now a void container ANCHOR
  ([`2026-07-29-page-callout-void-container.md`](./2026-07-29-page-callout-void-container.md)):
  `Editor.BlockFrame` + `BlockHandle.anchor` + `wrapOnConvert`, no `text` in its
  schema. One of the exactly two examples `chrome` was generalized from is gone.
- **`/prompt` arrived** (`plugins/page/plugins/prompt/plugins/block`) and IS
  text-bearing. `PromptBlock` renders a raised box containing the text editor
  **plus a footer** — a launch control and the conversations it started. `chrome`
  is a bag of style strings and one marker node; it has no position for content
  that is not the line.

Rebasing surfaced this as a compile error: the union rejected prompt's
`component`. The guard fired correctly on a legitimate case. Two samples were not
enough to derive the abstraction, and the fix is not a sixth knob — it is to stop
deriving the shape from the examples and derive it from the constraint.

On `main`, `quote` and `prompt` are the only text-bearing types still owning a
dispatch component. Both remount the `LexicalComposer` on conversion; the
`/prompt` case is a live, unreported instance of the reported `/quote` bug.

**Outcome intended:** one renderer for every text-bearing type, a type change that
is a re-style rather than a remount, and a presentation vocabulary whose limits
are a property of the geometry instead of a property of who asked last.

## The constraint, stated once

React unmounts when the **element TYPE at a position** changes. So:

> The chain of element types from the shared renderer's root down to
> `<LexicalComposer>` must be constant — independent of `block.type`. Props,
> classNames and styles may vary freely. Anything that is not an ancestor of the
> composer may vary freely.

From which the whole API follows. A block type may **style** elements that always
exist, and may contribute **siblings** of the editable line. It may never wrap it
— and it cannot, because a region receives no `children`.

`main` reached the same principle independently on the container axis:
`BlockFrameProps` is documented as "a BACKDROP, not a wrapper … which is what lets
a block be indented into or out of a callout without its editor remounting."

**The set of sibling positions is closed by geometry:** a leaf inside a box has
exactly four — two on the block axis, two on the inline axis. All four ship, all
four always render (as `null` when undeclared), so a new block type needs no API
change. `header` and `end` have no consumer today; that is the price of closing
the set rather than claiming it is closed.

## The API

`plugins/page/plugins/editor/web/types.ts` — replaces `BlockChrome` /
`BlockChromeFn`:

```ts
/**
 * Props every region receives. Shaped after `BlockAnchorProps` (NOT
 * `BlockRendererProps`): the read-only surface renders `ReadOnlyNode`s, which are
 * not `Block`s — a snapshot may carry no id and never carries a `pageId`. Flat
 * fields let ONE contribution render on both surfaces.
 *
 * There is deliberately no `children`: a region is a SIBLING of the editable
 * line and structurally cannot wrap it. That is the invariant, expressed as a
 * type.
 *
 * `editor` is absent on read-only surfaces (version-history preview, the public
 * site) — degrade to a static rendering, never a control whose click no-ops.
 */
export interface BlockRegionProps {
  id: string;
  type: string;
  /** Owning page; `null` on a read-only surface rendering a detached snapshot. */
  pageId: string | null;
  /** RAW row blob, possibly partial/historical — read it via your own handle's `safeParse`. */
  data: unknown;
  isFocused: boolean;
  /** 1-based position among the consecutive run of same-type siblings. */
  ordinal: number;
  editor?: BlockEditorAPI;
}

export type BlockRegion = ComponentType<BlockRegionProps>;

/** The four sibling positions around the editable line. Closed by geometry. */
export interface BlockRegions {
  /** Block-before: a full-box-width row above the line. */
  header?: BlockRegion;
  /** Inline-before: the leading `MARKER_GUTTER` column. Overrides the handle's marker ladder. */
  start?: BlockRegion;
  /** Inline-after: a rigid cell trailing the text column. */
  end?: BlockRegion;
  /** Block-after: a full-box-width row below the line. */
  footer?: BlockRegion;
}

export interface BlockChrome {
  /** Padding OUTSIDE the box — decoration edge `C` → box. Static: see the geometry note. */
  padding?: InsetSides;
  /** Semantic elevation, composed as `SURFACE_LEVELS[level]` — see below. */
  surface?: SurfaceLevel;
  /** Everything else painted on the box. PAINT ONLY — no padding, no overflow. */
  boxClassName?: string | ((data: unknown) => string);
  /** Whether the LINE supplies the page column's left inset (default true). */
  inset?: boolean;
  regions?: BlockRegions;
}
```

Four decisions worth their rationale:

- **`chrome` is a STATIC object, not `chrome(data)`.** It is built once at module
  eval inside the contribution literal, so a region component's identity is a
  module constant *by construction*. A function invoked every render is a place
  where a fresh component can be minted (resetting that region on every keystroke)
  and a place where a hook can be called from inside a per-type conditional
  (crashing on conversion). Neither is representable. The one data-dependent knob,
  `boxClassName`, returns a **string** — it cannot mint a component, and
  `rules-of-hooks` rejects a hook inside a plain lowercase function.
- **Regions are `ComponentType`, not `ReactNode`.** A prebuilt node cannot degrade
  when `editor` is absent, and a region with hooks (`LaunchedConversations` uses
  `useResource`, `useOpenPane`, `useRouteEntries`) needs its own hook scope.
- **The box is a plain `<div>` with `cn(SURFACE_LEVELS[level], …)`**, not
  `<Surface>`. The box renders unconditionally and the closed level set has no
  neutral member, so `<Surface level>` cannot be rendered always. The
  member-access form is the escape valve `no-adhoc-surface` names explicitly.
  Cost: the box loses `<Surface>`'s baked-in Ctrl+A select-scope, which the page
  editor's own selection model is better off without.
- **`padding` is static and `boxClassName` is paint-only.**
  `BlockHandle.gutterFirstLineCenter` is a static per-type declaration, so
  vertical padding varying per row would seat the gutter rail on a phantom line.
  Verified for prompt: `SURFACE_LEVELS.raised` is
  `rounded-md border border-border bg-card shadow-sm` — no padding — so its
  declared `calc(var(--space-xs) * 2 + var(--doc-lh-body) / 2)` still lands on the
  first line. `overflow` stays out of the set for a second reason: Lexical's
  scroll-into-view and `internal/caret-geometry.ts` resolve against the nearest
  scrollable ancestor, so a class could silently change caret scroll semantics.

Dropped from the drafted facet: `marker` (subsumed by `regions.start`) and
`contentClassName` (unused — strike-through comes from `handle.toggle.doneClassName`
and belongs on the ContentEditable; italic goes on the box and inherits).

## The skeleton

New `plugins/page/plugins/editor/web/components/text-block-layout.tsx`, rendered by
**both** surfaces — only the leaf differs (`<BlockTextEditor>` vs `<RunsRenderer>`),
so it is `children`.

```tsx
export function TextBlockLayout({ chrome, data, region, fallbackMarker, children }) {
  const r = chrome?.regions;
  const box = typeof chrome?.boxClassName === "function"
    ? chrome.boxClassName(data) : chrome?.boxClassName;
  const marker = r?.start ? <Region of={r.start} {...region} /> : fallbackMarker;

  return (
    <Inset {...(chrome?.padding ?? {})}>          {/* A — padding box */}
      <div className={cn(chrome?.surface && SURFACE_LEVELS[chrome.surface], box)}>
        <Region of={r?.header} {...region} />
        <div className={cn("relative flex gap-xs",   {/* B — the line */}
              chrome?.inset !== false && insetClass({ l: BLOCK_INSET }))}>
          {marker != null ? (
            <div className="flex flex-none select-none justify-center"
                 style={{ minWidth: MARKER_GUTTER }}>{marker}</div>
          ) : null}
          <div className="relative min-w-0 flex-1">{children}</div>   {/* the LEAF */}
          <Region of={r?.end} {...region} />
        </div>
        <Region of={r?.footer} {...region} />
      </div>
    </Inset>
  );
}
```

`Region` is a one-line helper (`of ? <of {...props}/> : null`) so the
`react-hooks/static-components` exemption — the component comes from a registry
lookup into a module-eval'd object, exactly like `Anchor` in `block-row.tsx` — is
stated once instead of four times.

**Three totality rules, or the bug comes back:**

1. Every skeleton element renders unconditionally. `Inset` always renders its
   element and never collapses to a Fragment on empty props — that is *luck, not
   design*, so no skeleton element may be a primitive that can vanish.
2. Each region occupies exactly **one** children-array slot (ternary-to-`null`),
   never something that changes the array's length. React pairs unkeyed siblings
   by `fiber.index`; a length change mis-pairs the leaf cell against a region div
   and remounts Lexical.
3. Nothing in the chain may key or branch on `block.type`.

**Prerequisite — `BlockTextEditor` gives up the line.** It currently owns the line
wrapper, the marker gutter and the leaf cell. All three move into
`TextBlockLayout`, and it loses its `marker` and `inset` props: it returns
`<LexicalComposer>` wrapping `RichTextPlugin` + the per-block plugins directly.
`LexicalComposer` emits no DOM, so the leaf cell stays the same flex child and the
placeholder's `absolute left-0 top-0` still resolves against it. Consequence: the
marker gutter now sits *outside* the composer. Nothing reads Lexical context from a
marker today, and arguably a region should not be able to.

`BlockTextRenderer` reduces to: resolve the contribution → build `region` →
resolve `fallbackMarker` from the handle ladder (toggle checkbox → `ordinalMarker`
→ static `marker`) → render `<TextBlockLayout>` around `<BlockTextEditor>`.

## Closing the reorder hole

`BlockRegistrationBase` exposes `excludeFromReorder?: boolean` on **both** arms of
the union. `ReorderItemMiddleware` (`plugins/reorder/web/internal/dnd-item-middleware.tsx`)
early-returns `<>{children}</>` where it otherwise renders `<SortableReorderItem>`,
discriminating on exactly that field — an element-type flip on an *ancestor of the
composer*, keyed per contribution. A text-bearing type setting it would remount
Lexical on every conversion: the reported bug, reached through a field the union
permits. No block sets it today, so the shared-renderer fix is complete **in fact,
not by construction**.

Fix: move `excludeFromReorder` to the text-less arm of `BlockRegistration`.

## Migration

**`plugins/page/plugins/quote/web/`** — delete `components/quote-block.tsx`; the
registration carries `chrome: { boxClassName: "border-l-2 border-muted-foreground/30 italic" }`.
No `padding`, no `inset`: the line supplies the page rail inset as today.

**`plugins/page/plugins/prompt/plugins/block/web/`** — delete
`components/prompt-block.tsx`; add `components/prompt-marker.tsx` (the `MdAutoAwesome`
glyph) and `components/prompt-footer.tsx` (today's action row verbatim, opening
`if (!editor) return null`, reading `plainOf(promptBlock.parse(data).text).trim()`
and keeping its `if (!pageId) throw` provenance guard). Registration:

```ts
chrome: {
  padding: { x: BLOCK_INSET, y: "xs" },
  surface: "raised",
  inset: false,
  regions: { start: PromptMarker, footer: PromptFooter },
}
```

The footer renders **nothing** read-only, for two independent reasons worth
stating in the file: its content is live agent state rather than document content
(a version-history preview of last Tuesday showing today's conversation chips is a
lie about the snapshot), and `LaunchedConversations` calls `useOpenPane` /
`conversationPane.useRouteEntries()`, which do not exist on the public-site
surface — it would crash, not degrade.

**`plugins/page/plugins/read-only-view/web/components/read-only-blocks.tsx`** —
`ReadOnlyBlocks` keeps the contributions instead of mapping them to handles;
`TextLikeBlock` keeps only its static marker ladder and done class, then renders
`<TextBlockLayout>` (with `pageId: null`, `isFocused: false`, **no `editor`**)
around its `<RunsRenderer>` leaf. **Delete the `handle.type === "quote"` branch**
and its duplicated border classes. The file then names zero block types in its text
arm — the same win the callout rewrite already banked for containers, and the
removal of a shim `read-only-view/CLAUDE.md` currently documents as surviving.

**`plugins/page/plugins/editor/web/index.ts`** — export `TextBlockLayout`,
`BlockChrome`, `BlockRegion`, `BlockRegionProps`; **stop exporting
`BlockTextEditor`** (prompt was its only external consumer, so removing the export
deletes the roll-your-own-text-component affordance outright).

## Landing

One commit, as today: the branch's single commit re-lands with Stages 1 and 2
carried across mechanically and Stage 3 rewritten. Rebase onto `origin/main`
conflicts in eight files, all in this plan's blast radius:

```
callout/web/index.ts                    editor/web/slots.ts
editor/web/block-editor-context.tsx     editor/web/types.ts
editor/web/components/markdown-shortcut-plugin.tsx
editor/web/index.ts                     editor/web/internal/optimistic-block-ops.ts
read-only-view/web/components/read-only-blocks.tsx
```

Plus: delete the branch's `callout/web/chrome.tsx` (callout is void on `main`, so
it has no chrome) and fold `quote/web/chrome.ts` into the registration. Take
`main`'s side wholesale for the callout container work. One interaction to get
right: Stage 1 narrows `convertTo(type, data: RowData)`, and `main` added
`wrapOnConvert` inside `convertTo` — `preserveText` applies only to the non-wrap
path, since a wrap keeps the origin row's data entirely and mints the anchor from
`empty()`.

## Out of scope, and one residual gap

- **Line-box interleaving** — line numbers, per-line comment anchors, a diff rail:
  anything aligning to the editable's *wrapped line boxes* rather than to the
  block. A sibling column cannot know line boxes without measuring and syncing
  rects. No candidate design solves this (not regions, not a portal, not
  restore-after-remount) because it is CSS, not React. Semi-imminent: `/code`
  already destroys the caret today, and "turn into code keeping the text" is the
  obvious next ask.
- **A per-type wrapper of any kind** — a Provider, a `<form>`, a scroll box. By
  construction. A skeleton-level Provider taking a per-type *value* is the
  available shape if one is ever needed.
- **Content aligned to the block's SUBTREE** (attribution below a quote *and* its
  children, a bracket spanning a container) — `Editor.BlockFrame` territory, and
  that seam already exists.
- **Cross-cutting affordances** (comments, presence, per-block AI suggestions).
  `chrome.regions` is single-owner by design. The answer when it is asked for is
  `Editor.BlockRegion` render slots at the same four positions, mounted by the same
  layout beside the per-type region — not a fifth knob.
- **Residual gap, knowingly left open.** The union discriminates on the
  compile-time `TextBearingSchema` brand while `handle.acceptsText` is derived at
  runtime from `"text" in schema.shape`. `core/text-data.ts`'s own comment admits
  it: a bare `z.object({ text })` is text-bearing at runtime but unbranded, so it
  lands on the text-less arm, may own a `component`, and silently reinstates this
  bug. A `page.editor:text-blocks-share-renderer` check (`acceptsText && !anchor ⇒
  component === BlockTextRenderer`, modelled on `anchor-has-decoration`) closes it.
  Deferred, not solved.

Also to file (`add_task`, unrelated to this design): on the public site,
`editor-toy` mounts `<BlockEditor>` as a `WebsiteApps.Section` render-slot
contribution, so `ReorderAreaContext` is non-null and every block is wrapped in
`SortableReorderItem` with a dnd-kit id of `pluginId:contributionId` — identical
for every block of the same type.

## Verification

```bash
./equin build
bun test plugins/page/plugins/editor/core
bun run test:dom plugins/page/plugins/editor
./equin check
```

The Stage-3 spec is `e2e/convert-in-place-verify.ts` (already written on the
branch), extended with the two cases this redesign creates:

- **`/prompt`** — convert a text block into a prompt and back: the block id is
  unchanged, the caret stays collapsed in it, typing immediately after lands in the
  same block, and the launch control and chips appear/disappear with the type.
- **DOM-node identity** — across `/quote` and `/prompt` conversions, assert the
  *same* `[contenteditable]` element (not merely an equal one) survives. This is
  the direct test for the totality rules; a skeleton element that collapses to a
  Fragment fails here and nowhere else.

Regression: `crdt-*-verify.ts`, `enter-at-start-verify.ts`, `indent-caret-verify.ts`,
`callout-container-verify.ts`, `callout-wrap-verify.ts`, `prompt-launch.ts`, and
the read-only path via `history/e2e/crdt-restore-verify.ts`.
