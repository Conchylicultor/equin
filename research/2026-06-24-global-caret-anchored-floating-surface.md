# Caret-anchored floating surface primitive

**Date:** 2026-06-24
**Category:** global (new `primitives/` primitive + 5 `page/` migrations + shared `ui-kit` role)

## Context

Five Lexical editor floating menus hand-roll their own positioning instead of going
through a shared primitive:

- `plugins/page/plugins/editor/web/components/slash-menu-plugin.tsx` (`/`)
- `plugins/page/plugins/math/plugins/inline/web/components/inline-math-plugin.tsx` (`$$`)
- `plugins/page/plugins/inline-date/web/components/inline-date-plugin.tsx` (`@`)
- `plugins/page/plugins/inline-page-link/web/components/inline-page-link-plugin.tsx` (`[[`)
- `plugins/page/plugins/url-paste/web/components/url-paste-plugin.tsx` (paste URL)

Each re-derives `createPortal` → `fixed` → inline `style={{ left, top }}` from
`window.getSelection().getRangeAt(0).getBoundingClientRect()`, and each carries its
own `// eslint-disable-next-line layout/no-adhoc-layout`. They get **none** of
portaling, z-layer, theme-scope, collision/flip, or scroll-tracking for free — and
they're stale on scroll (position is set once and never re-tracked). The
`InlinePopover` / base-ui Popover primitive can't help because base-ui anchors to a
DOM **trigger element**, while here the anchor is a transient **caret rect** with no
trigger node.

**Outcome:** one focus-less floating-surface primitive that anchors to a virtual
rect, owns the portal/z/theme-scope/collision/width machinery, and lets the 5 sites
drop their bespoke positioning + eslint-disables. Adds flip + scroll-follow (a
behavior improvement the hand-rolled versions lack).

## Approach: a focus-less sibling primitive (not an extension of base-ui Popover)

The visual surface (portal, `z-popover`, theme-scope, `Surface` chrome, width/padding
roles) is **already factored one layer below** base-ui's Popover — in
`ViewportOverlay`, `Surface`, and the `POPOVER_WIDTH`/`POPOVER_PADDING` maps that live
in `ui-kit`. What genuinely differs between a trigger popover and a caret menu is
**focus policy**: a trigger popover *should* move focus into the panel; a caret menu
must **never** take focus (the caret stays live in the contenteditable, nav is driven
by Lexical commands, rows `preventDefault` on mousedown to keep focus). base-ui
`Popover.Root` exists to manage focus, so bending it off for caret menus fights the
abstraction. The repo precedent agrees: `format-toolbar-plugin.tsx` is a
caret-anchored surface that deliberately avoids base-ui Popover and positions through
`ViewportOverlay`.

So: a new primitive that **composes the same visual primitives** but binds the anchor
through **Floating UI** (`@floating-ui/react-dom`, already a transitive dep at
`^2.1.8`) and never touches focus. Floating UI is the same engine base-ui's Positioner
uses internally — we use it directly, minus the focus/dismiss wrapper.

Two key cleanliness wins:
- **No eslint-disables anywhere.** Floating UI returns positioning as an **inline
  `style` object**, and `layout/no-adhoc-layout` only scans `className` strings — so
  neither the primitive nor any call site writes `fixed` in a className. All 5
  disables vanish.
- **Width roles stay byte-identical.** `POPOVER_WIDTH` relies on
  `max-w-(--available-width)` (base-ui sets that var). We reproduce the same var with
  Floating UI's `size()` middleware, so the existing role classes keep working
  unchanged.

## New primitive: `plugins/primitives/plugins/floating-surface/`

Web-only plugin, barrel `web/index.ts` → `export { FloatingSurface, type FloatingSurfaceProps }`.
`package.json` declares `"@floating-ui/react-dom": "^2.1.8"`.

```ts
type FloatingAnchor = DOMRect | { getBoundingClientRect: () => DOMRect };

interface FloatingSurfaceProps {
  open: boolean;
  anchor: FloatingAnchor | null;          // caret/selection rect or virtual element
  children: React.ReactNode;
  width?: PopoverWidth;                    // default "content"
  padding?: PopoverPadding;                // default "xs"
  maxHeight?: PopoverMaxHeight;            // NEW shared role — owns max-h + overflow-y-auto
  side?: "top" | "right" | "bottom" | "left";  // preferred side, default "bottom"
  align?: "start" | "center" | "end";      // default "start"
  sideOffset?: number;                     // default 4
  onDismiss?: () => void;                  // focus-safe outside-press close (opt-in)
  reposition?: unknown;                    // identity change re-runs Floating UI update() (e.g. the query)
  surfaceRef?: React.Ref<HTMLDivElement>;  // expose the surface node to the host
}
```

Implementation (`web/internal/floating-surface.tsx`):
- `useFloating({ open, strategy: "fixed", placement: toPlacement(side, align),
  whileElementsMounted: autoUpdate, middleware: [offset(sideOffset), flip(),
  shift({ padding: 8 }), size({ apply })] })`. `size`'s `apply` writes
  `--available-width` / `--available-height` onto the floating element so the
  `max-w-(--available-width)` width roles work exactly as under base-ui.
- `refs.setReference(toVirtualElement(anchor))`; re-run on `anchor`/`reposition`
  change via `useLayoutEffect` calling `update()` (keystroke caret-follow);
  `autoUpdate` covers scroll/resize.
- Renders through `<ViewportOverlay layer="popover" className="pointer-events-none">`
  (portal + z + theme-scope, click-through) wrapping a `<Surface level="overlay">`
  with `ref={useMergeRefs([refs.setFloating, surfaceRef])}`,
  `style={floatingStyles}` (inline — the only positioning, lint-invisible), and
  `className={cn("pointer-events-auto", POPOVER_WIDTH[width], POPOVER_PADDING[padding], POPOVER_MAX_HEIGHT[maxHeight])}`.
  Theme-scope is carried by `ViewportOverlay`'s root and inherited by the Surface via
  DOM ancestry inside the portal (no re-stamp needed). `pointer-events-*` is not a
  `no-adhoc-layout` token (precedent: `format-toolbar-plugin`).
- When `open && onDismiss`, a capture-phase `document` `pointerdown` listener closes
  on a press outside `refs.floating` — focus-safe (it never `preventDefault`s or
  focuses anything), generalizing slash-menu's hand-rolled listener and url-paste's
  backdrop.
- Returns `null` when `!open || !anchor`.

### Shared role addition (`ui-kit`)

In `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/popover-width.ts`, add a
third role map next to width/padding and re-export from the ui-kit barrel:

```ts
export type PopoverMaxHeight = "none" | "sm" | "md" | "lg" | "xl";
export const POPOVER_MAX_HEIGHT: Record<PopoverMaxHeight, string> = {
  none: "",
  sm: "max-h-48 overflow-y-auto",
  md: "max-h-64 overflow-y-auto",
  lg: "max-h-80 overflow-y-auto",
  xl: "max-h-96 overflow-y-auto",
};
```

`overflow-y-auto` is invisible to `no-adhoc-layout` here: the rule scans `className`
attrs and `cn()` args, and this value is only ever reached as a dynamic member
expression `POPOVER_MAX_HEIGHT[maxHeight]` inside `cn()`. (Co-located with width/padding
so `PopoverContent` can later adopt the same role; consumed now by `FloatingSurface`.)

### Selection helper (`page/editor`)

Add to the editor web barrel (`@plugins/page/plugins/editor/web`), reused by all 5
sites (4 import the barrel already; slash-menu is internal):

```ts
// Live virtual element: re-reads the selection on every getBoundingClientRect call,
// so scroll-follow is exact. Falls back when the live rect is absent or all-zero
// (the empty-block paste case for url-paste).
export function caretAnchor(
  fallback?: () => DOMRect | null,
): { getBoundingClientRect: () => DOMRect } | null;
```

## Per-site migration

Each site drops `createPortal` / `ViewportOverlay` / `Surface` / `fixed` / inline
`style` / the eslint-disable, and renders `<FloatingSurface …>`. Keyboard nav, Escape
latch, and open-state derivation stay as-is. The stored `caret`/`left,top` state is
removed (anchor is live).

| Site | width | padding | maxHeight | notes |
|---|---|---|---|---|
| slash-menu | `sm` (w-56) | `xs` | `lg` (max-h-80) | `onDismiss` sets `dismissedRef`+close, replaces the document-pointerdown effect; `surfaceRef`→`menuRef`; drop `caret` state, gate `visible` on `open && filtered.length>0` |
| inline-math | `lg` (w-72) | `sm` | — | preview-only; drop `caret` state |
| inline-date | `lg` (w-72) | `xs` | — | drop `caret` state |
| inline-page-link | `lg` (w-72) | `xs` | `md` (max-h-64) | drop the inner `<Scroll max-h-64>` — surface scrolls via the role; drop `caret` state |
| url-paste | `sm` (w-56) | `xs` | — | `anchor={caretAnchor(() => lexical.getRootElement()?.getBoundingClientRect() ?? null)}`; `onDismiss={() => setMenu(null)}` replaces the backdrop; keep the Lexical Escape command; `menu` state drops `left/top`, keeps `url` |

## Critical files

- **New:** `plugins/primitives/plugins/floating-surface/{web/index.ts,web/internal/floating-surface.tsx,package.json,CLAUDE.md}`
- **Edit:** `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/popover-width.ts` (+ barrel re-export of `PopoverMaxHeight`/`POPOVER_MAX_HEIGHT`)
- **Edit:** `plugins/page/plugins/editor/web/index.ts` + a small `caret-anchor.ts` internal (export `caretAnchor`)
- **Edit:** the 5 plugin files listed above
- **Reuse:** `ViewportOverlay` (`primitives/css/viewport-overlay/web`), `Surface` (`primitives/css/surface/web`), `cn` + `POPOVER_*` roles (`primitives/css/ui-kit/web`), `useFloating/offset/flip/shift/size/autoUpdate/useMergeRefs` (`@floating-ui/react-dom`). Mirror `format-toolbar-plugin.tsx`'s `ViewportOverlay layer="popover" className="pointer-events-none"` pattern.

## Verification

1. `./equin build`, then drive the editor with `bun e2e/screenshot.mjs` (type into a block):
   - `/` → slash menu at caret; **keep typing** to confirm focus stayed in the editor and the list filters; ArrowDown/Enter inserts; Esc + outside-click close.
   - `$$` → live KaTeX preview; `@` → date menu; `[[` → page-link menu (scrolls past ~max-h-64); paste a bare URL into an **empty** block → 3-item menu (fallback anchor).
   - Scroll the page with a menu open → it **follows** the caret (new). Open a menu near the viewport bottom → it **flips** above the caret (new).
2. `./equin check` — `type-check`, `eslint` (zero `layout/no-adhoc-layout` disables remain in the 5 files), `plugin-boundaries`, `plugins-registry-in-sync`, `plugins-doc-in-sync`.

## Risks / notes

- **Focus must never move.** The primitive renders no focusable wrapper and runs no
  focus calls; rows keep their `onMouseDown`+`preventDefault`. Verify the caret keeps
  blinking and typing still filters after a menu opens.
- **`reposition` cadence.** If keystroke caret-follow ever lags, pass the host's query
  string as `reposition`; `autoUpdate` already handles scroll/resize.
- Registry/barrel files are regenerated by `./equin build` — never hand-edit
  `*.generated.ts`.
