# Outline rail — a unified "where am I" minimap primitive

Date: 2026-08-16 · Category: global (primitives + conversations + pages)

## Context

Notion pins a small stack of dashes to the right edge of a document. Each dash is
one heading; the dash for the section you are currently reading is highlighted;
dash width encodes heading depth. Hovering the stack expands it into a floating
panel listing the heading titles, indented, with the current one in the accent
color. It answers "where am I in this document?" continuously, and "take me
there" on click — while costing almost no screen space at rest.

equin has one thing in this shape today and it is weaker on both counts:
`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/message-toc/`
— a top-right pill reading "☰ 12 messages" that expands into a flat list of user
turns. It has **no current-position indicator at all** (no IntersectionObserver,
no scroll listener, no active row), so it is a jump-list, not a place-in-document
indicator. The Pages app has nothing: a long page offers no outline and no way to
jump between headings.

Both surfaces want the same widget, so it should be built once as a primitive and
consumed twice. This plan builds that primitive, rewrites the conversation TOC on
top of it, and mounts it in the Pages app over the page's headings.

### Assumptions (say the word and I'll change any of them)

An `AskUserQuestion` on these was declined, so I am stating them and proceeding:

1. **Conversation entries stay user turns, flat** (depth 0) — the same content the
   current TOC lists, in the new chrome. The primitive supports depth from day
   one, so nesting markdown headings under each turn later is additive.
2. **The "12 messages" pill goes away**, replaced by the bare dash rail, matching
   the screenshots. Keeping a labelled trigger instead is a one-line change
   (`trigger` prop).
3. **Pages entries are the page's heading blocks only** — not its child pages.

## The end-user experience

Right edge of a conversation or a page, at rest — one dash per section, the
current one bright and wide:

```
                                          ▬
                                          ▬
                                          ━━   ← you are here
                                            ▪
                                            ▪
                                          ▬
```

Hover (or Tab to it, or tap on touch) and it becomes an outline, current section
in the accent color, click to jump:

```
   ┌──────────────────────────┐
   │  Mon histoire            │
   │  Enfance                 │   ← pointer
   │  Kathryn                 │
   │  Égarement               │   ← current (accent)
   │      MDMA                │
   │      Méditation          │
   └──────────────────────────┘
```

And the call site a plugin writes:

```tsx
<OutlineRail
  entries={entries}                                  // {id, label, depth}[]
  resolve={(id) => root.querySelector(`[data-block-id="${CSS.escape(id)}"]`)}
/>
```

That is the whole contract. The primitive owns the dashes, the hover disclosure,
which entry is current, and the scroll-to on click. The host owns only *what the
entries are* and *how an entry id maps to a DOM node* — which is exactly the part
that legitimately differs between a transcript and a page.

## Design

### New primitive: `plugins/primitives/plugins/outline/`

An umbrella with two sub-plugins, because the "which section am I in" half is
independently useful (see *Third hand-rolled site*, below) and the rail should not
own it privately.

#### `outline/plugins/scroll-spy/` — the position half

```ts
// web/index.ts
export function useActiveInView(
  ids: string[],
  resolve: (id: string) => Element | null,
): string | null;
```

One `IntersectionObserver` built once and re-enrolled incrementally as elements
appear (transcript rows mount/unmount as you scroll), maintaining a set of
on-screen ids; the active id is the **first in `ids` order** that is on screen.
Two rules copied deliberately from the closest existing prior art,
`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web/use-reading-anchor.ts`:

- **hold last value when nothing is on screen** — never snap to `null` on a
  transient empty state (mid-fling, or a tall section taller than the viewport);
- **enroll via a `WeakSet`**, so re-renders don't re-observe the same node.

The observer `root` is derived, not passed: `findScrollParent()`
(`@plugins/primitives/plugins/auto-scroll/web`) of the first element `resolve`
returns. The entries live inside the scroller by construction, so this is always
right and the host has one less prop to get wrong. `rootMargin` biases the
"current" line to roughly the top third of the viewport, which is where a reader's
eye is — without it, the highlight lags a section behind.

Returns `null` only before the first resolution, i.e. genuinely "not known yet",
never as a stand-in for "nothing visible".

#### `outline/plugins/rail/` — the chrome half

```ts
// core/types.ts — importable from both runtimes
export interface OutlineEntry {
  id: string;      // opaque to the primitive; handed back to resolve()
  label: string;
  depth: number;   // 0 = top level
}

// web/index.ts
export interface OutlineRailProps {
  entries: OutlineEntry[];
  resolve: (id: string) => Element | null;  // null = not mounted (virtualized/filtered)
  footer?: ReactNode;                       // extra affordance in the expanded panel
  label?: string;                           // aria-label, default "Outline"
}
export function OutlineRail(props: OutlineRailProps): ReactElement | null;
```

Renders `null` for fewer than two entries — a one-section outline is noise.

- **Placement.** `<Pin to="right" offset="xs" layer="float">` inside the host's
  own positioning host. `z-float` is the semantically-earmarked layer for
  "in-pane floating widgets: selection bar, message TOC"
  (`primitives/css/z-layers`); today's `message-toc` uses `z-nav`, which is a
  small pre-existing drift this fixes.
- **Disclosure.** `FloatingAction`
  (`@plugins/primitives/plugins/floating-action/web`) with the dash stack as
  `trigger` and the outline list as children. Its `useDisclosureIntent` already
  gives hover with grace-delay close, focus (Tab-reachable), and a touch latch
  dismissed by Esc/outside-press, over a geometry-stable hitbox that cures
  open/close flicker. This is the same component today's TOC uses, so the
  disclosure behavior is unchanged and proven.
- **Dashes.** Width by depth (a closed 3-step ramp; depth ≥ 2 clamps to the
  narrowest), `bg-muted-foreground/40` at rest. The active dash is full-opacity
  `bg-foreground` and one step wider — brightness *and* length, so it reads
  without relying on color alone.
- **Panel rows.** `Text variant="caption"`, muted, `Inset` left-padded by depth,
  active row `tone="primary"`. Single-line, ellipsized (`Line` + `Fill` + `Text`,
  per the css skill's shrink hierarchy). Panel is `max-h-80` and scrolls; the
  active row is kept in view with `useRevealOnActive`
  (`@plugins/primitives/plugins/scroll-reveal/web`).
- **Click** → `revealElement(resolve(id), { behavior: "smooth", block: "start" })`.
  `revealElement` finds its own scrollable ancestor, so neither host needs a
  scroll-container lookup — this deletes today's bespoke `paneScrollFrom()` DOM
  walk in `message-toc`.

**Overflow — the one genuinely new bit of design.** A 200-turn conversation
cannot show 200 dashes. The rail measures its own available height
(`useElementSize`, `@plugins/primitives/plugins/element-size/web`) and renders at
most `floor(height / step)` dashes, **windowed around the active index**, with the
first and last dash of the window rendered at half opacity to signal "more above /
below". The expanded panel always lists **every** entry (it scrolls) — the rail is
the indicator, the panel is the index. Without this rule the rail either overflows
its pane or silently truncates the tail, which would make the position indicator
lie precisely when the document is long enough to need it.

`.map()` → `Row` for the panel rows is transient navigation chrome, not a
DataView, so it carries the named
`// eslint-disable-next-line data-view/no-adhoc-row-list -- transient navigation chrome`.

### Consumer 1 — conversation view

Rename `…/jsonl-viewer/plugins/message-toc/` → `…/jsonl-viewer/plugins/outline/`
(one name per concept: it is no longer a "message TOC"). It stays a
`JsonlViewer.Overlay` contribution — that slot and its `relative isolate` host in
`jsonl-pane.tsx` already exist and need no change.

The component shrinks to an adapter:

- entries: `useVisibleEvents(events)` filtered to `kind === "user-text"` — keep
  reading the **filtered** set, not the raw resource, or the outline desyncs from
  the rendered rows (an `EventFilter` contributor can hide a `user-text` event;
  this was a real past bug and its comment should survive the rewrite);
- `id` = `eventKey(ev)` (content identity, not array index — also a past bug fix);
- `label` = first line, capped, as today; `depth` = 0;
- `resolve` = `document.querySelector('[data-event-key="…"]')`, scoped to the
  pane's `[data-pane-scroll]` subtree so a second open conversation pane on screen
  is never targeted — this scoping is load-bearing and must be preserved;
- `footer` = the existing "scroll to bottom" chevron (`scrollToBottom`).

Everything else — the pill, the count, the hand-rolled panel, `paneScrollFrom` —
is deleted.

### Consumer 2 — Pages app

`pageDetailPane` has no overlay mount point (its slots are `PageDetail.Section`,
an in-flow card, and `PageDetail.HeaderActions`, a header button — both the wrong
shape). So:

1. **`…/pages/plugins/page-tree/web/slots.ts`** — add
   `PageDetail.Overlay = defineRenderSlot<{component: ComponentType<{pageId: string}>}>("pages.detail.overlay")`,
   mirroring `JsonlViewer.Overlay`, and render it in `PageDetailBody`
   (`…/page-tree/web/panes.tsx`) inside a `relative` host wrapping the editor.
2. **New `plugins/apps/plugins/pages/plugins/page-outline/`** contributing to it:
   - blocks from `useResource(blocksResource, { pageId })`
     (`@plugins/page/plugins/editor/core`);
   - **headings identified generically**, via each block type's registered
     `handle.semantics` (`{ role: "heading", level }`) read from
     `Editor.Block.useContributions()` — never by naming `heading-1`/`heading-2`.
     A future `heading-4` block appears in the outline with zero edits here;
   - order: `inDocumentOrder(nodes, ids)` from `page/editor/core/block-ops.ts` —
     **not** `flattenVisible`, so headings inside a collapsed toggle still appear;
   - `label` = `plainOf(block)`, `depth` = `level - 1`;
   - `resolve` = `document.querySelector('[data-block-id="…"]')` — already stamped
     on every `BlockRow` and already relied on by the editor's own `rowAtPointer`.

One caveat to accept and document: `block.data.text` is a ~1s debounced
projection of the live Yjs doc, so a heading you are actively typing shows its
previous text in the outline for about a second. That is the editor's existing
contract, not something this plugin should work around.

### Third hand-rolled site

`IntersectionObserver` is hand-rolled in three places already
(`use-reading-anchor`, `use-infinite-scroll`, and now this) while `ResizeObserver`
has a lint-enforced primitive (`no-raw-resize-observer`). `scroll-spy` is
deliberately its own plugin so it can become that home. Migrating
`use-reading-anchor` onto it is **out of scope here** — I'll file it as a
follow-up task rather than widen this change.

## Files

**New**

- `plugins/primitives/plugins/outline/plugins/scroll-spy/{web/index.ts, web/internal/use-active-in-view.ts, CLAUDE.md}`
- `plugins/primitives/plugins/outline/plugins/rail/{core/types.ts, web/index.ts, web/components/outline-rail.tsx, web/components/dash-stack.tsx, CLAUDE.md}`
- `plugins/apps/plugins/pages/plugins/page-outline/{web/index.ts, web/components/page-outline.tsx, CLAUDE.md}`

**Modified**

- `…/jsonl-viewer/plugins/message-toc/` → `…/jsonl-viewer/plugins/outline/`
  (folder rename; `web/components/message-toc.tsx` → `outline.tsx`, rewritten as
  an adapter; `e2e/toc-lands-on-right-message.ts` moves with it)
- `plugins/apps/plugins/pages/plugins/page-tree/web/slots.ts` (+ `PageDetail.Overlay`)
- `plugins/apps/plugins/pages/plugins/page-tree/web/panes.tsx` (render the slot)

No server, DB, or config work — this is entirely client-side over data both
surfaces already load.

## Verification

1. `./equin build` (background; it deploys to
   `http://att-1786876499-h21a.localhost:9000`).
2. **Conversation** — open a long conversation and confirm: dashes on the right
   edge; the highlighted dash tracks scrolling both directions; hover expands to
   the outline with the current turn in accent; clicking a row lands on that turn.
   The existing e2e already asserts the click→correct-message contract:
   `bun plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/outline/e2e/toc-lands-on-right-message.ts`
   (extended with an assertion that the active dash matches the scrolled-to turn).
3. **Pages** — open a page with several `h1/h2/h3`, confirm depth-varying dash
   widths and indented panel rows, click-to-jump, and that a heading inside a
   collapsed toggle still appears.
4. **Overflow** — a conversation with 100+ turns: the rail must stay inside the
   pane, window around the active dash, and the panel must still list all turns.
5. **Second pane open** — two conversation panes side by side; clicking in one
   must not scroll the other (the `[data-pane-scroll]` scoping).
6. **Keyboard/touch** — Tab reaches the rail and expands it; Esc closes;
   `./equin check` clean (layout/spacing/typography/z-index/data-view lint).
