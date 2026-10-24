# Cursor-anchored menu + measure-strip primitives

## Context

Right-clicking the floating desktop (or a window's titlebar) opens a context menu
that lands **shifted** from the cursor. Root cause: both menus pin a zero-size
`DropdownMenuTrigger` with `position: "fixed"; left/top = clientX/clientY`
(viewport coords), but the trigger renders inside the surface backdrop, which sets
`transform-gpu` (`plugins/apps/plugins/surface/web/components/surface-body.tsx:132`).
A `transform` makes that element the **containing block for `position: fixed`
descendants**, so the trigger resolves against the backdrop's top-left (below the
tab bar / right of the rail), not the viewport — the menu lands offset by exactly
that gap. The fix is to **portal the zero-size anchor to `document.body`** so
`fixed` resolves against the real viewport (the same escape the solo placement and
`ViewportOverlay` already use). `createPortal` moves only the DOM node — the React
tree position (and thus base-ui Menu context) is preserved, so the menu still wires
up correctly.

While here, a second, unrelated duplication surfaced during analysis: an
off-screen **measurement strip** idiom is copy-pasted across three files. Both are
small, sanctioned-home extractions.

This plan covers three changes:

1. **`MeasureStrip`** — collapse the 3 duplicated off-screen measure strips.
2. **`CursorAnchoredMenu`** — the body-portaled cursor-menu primitive; migrate both
   menus onto it (fixes the shift bug for both).
3. **Lint guardrail** — extend `no-adhoc-layout` to also flag inline-`style`
   `position` literals (the unguarded path this bug shipped on), with the two new
   primitives allowlisted. Lands after 1 & 2 so it carries 0 standing violations and
   becomes a pure forward guardrail against re-deriving the broken pattern.

## Part 1 — `MeasureStrip` primitive

A thin, body-portaled, off-screen hidden flex row used to measure children's
natural widths. All three current sites are byte-identical except `gap`; the only
thing that varies is the consumer-owned ref and the enable gate.

**New plugin:** `plugins/primitives/plugins/css/plugins/measure-strip/`
(sibling to `viewport-overlay` — both are portal-to-body `fixed` layout
primitives; lives under the `css` umbrella with the other layout primitives).

```
measure-strip/
  package.json        # {"name":"@singularity/plugin-primitives-css-measure-strip","private":true,"version":"0.0.1"}
  CLAUDE.md
  web/
    index.ts          # export { MeasureStrip, type MeasureStripProps }; default PluginDefinition {description, contributions:[]}
    internal/measure-strip.tsx
```

**Component** (`web/internal/measure-strip.tsx`) — ref-as-prop (React 19; mirrors
`Grid`/`Overlay`/`Stack` at `plugins/primitives/plugins/css/plugins/{grid,overlay,spacing}/web/internal/*.tsx`, which use `ref?: React.Ref<...>`, **not** `forwardRef`):

```tsx
export interface MeasureStripProps {
  ref?: React.Ref<HTMLDivElement>;   // consumer/hook OWNS the ref; strip never creates it
  gap: number;                       // px; all sites pass a number
  enabled?: boolean;                 // default true; gates the portal (consumer passes count > 0)
  children: ReactNode;               // rendered as-is — NO implicit wrapping
}

export function MeasureStrip({ ref, gap, enabled = true, children }: MeasureStripProps) {
  if (!enabled) return null;
  return createPortal(
    <div
      ref={ref}
      aria-hidden="true"
      style={{ position: "fixed", top: -9999, left: -9999, display: "flex", gap, opacity: 0, pointerEvents: "none" }}
    >
      {children}
    </div>,
    document.body,
  );
}
```

Notes:
- **Do not auto-wrap children.** `ResponsiveOverflow` wraps each child in `<div>`
  for one-DOM-node-per-item measurement; that wrapping stays in the consumer (the
  other two sites manage their own DOM granularity). Auto-wrapping would
  double-wrap and corrupt widths.
- Standardize `aria-hidden="true"` (string).
- The `position: "fixed"` here is correct/benign: it's an off-screen `-9999`
  body-portaled measurement node, immune to the transform trap by construction.

**Migrate 3 consumers** (replace the inline `createPortal(<div style={…}>…</div>, document.body)` with `<MeasureStrip ref={measureRef} gap={…} enabled={…}>…children…</MeasureStrip>`; keep each site's existing measurement hook/logic untouched):

| File | gap | enable gate | children (unchanged) |
|---|---|---|---|
| `plugins/primitives/plugins/responsive-overflow/web/internal/responsive-overflow.tsx` (~218–240) | `gap` prop | `children.length > 0` | `children.map((c,i) => <div key={i}>{c}</div>)` — keep the wrapper |
| `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx` (~291–314) | `GAP` | `totalCount > 0` | `slotActions.map(...renderIsolated...)` + `{hasExtra && <div>{extraActions}</div>}` |
| `plugins/apps/web/components/app-tab-bar.tsx` (~177–205) | `CHIP_GAP_PX` | `resolved.length > 0` | `resolved.map(... <Tab .../>)` |

The `measureRef` in each site is already created by its owner (`useResponsiveOverflow`
hook for sites 1+3; a local `useRef` in pane-chrome) and stays exactly as-is —
only the JSX node it attaches to changes. No measurement logic moves.

## Part 2 — `CursorAnchoredMenu` primitive

A single-import wrapper for the **DropdownMenu + body-portaled zero-size anchor +
Content** skeleton — the cursor-menu analogue of the existing `popover` primitive
(`plugins/primitives/plugins/popover/`, "single-import wrapper for Popover+Trigger+Content").
It absorbs the duplicated `<DropdownMenu open onOpenChange>` + buggy fixed trigger
that both menus hand-roll today, and makes the portal fix impossible to get wrong.

**New plugin:** `plugins/primitives/plugins/cursor-menu/` (top-level primitive,
sibling to `popover`; menus are not layout primitives, so not under `css`).

```
cursor-menu/
  package.json        # {"name":"@singularity/plugin-primitives-cursor-menu","private":true,"version":"0.0.1"}
  CLAUDE.md
  web/
    index.ts          # export { CursorAnchoredMenu, type CursorAnchor, type CursorAnchoredMenuProps }; default PluginDefinition
    internal/cursor-anchored-menu.tsx
```

**Component:**

```tsx
import { createPortal } from "react-dom";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

export interface CursorAnchor { x: number; y: number; }

export interface CursorAnchoredMenuProps {
  anchor: CursorAnchor | null;       // open point (viewport coords); null = closed
  onClose: () => void;
  children: ReactNode;               // DropdownMenuItem / Sub / Separator / CheckboxItem …
  align?: React.ComponentProps<typeof DropdownMenuContent>["align"]; // default "start"
  side?: React.ComponentProps<typeof DropdownMenuContent>["side"];   // default "bottom"
}

export function CursorAnchoredMenu({ anchor, onClose, children, align = "start", side = "bottom" }: CursorAnchoredMenuProps) {
  return (
    <DropdownMenu open={anchor !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {createPortal(
        <DropdownMenuTrigger
          aria-hidden
          tabIndex={-1}
          style={{ position: "fixed", left: anchor?.x ?? 0, top: anchor?.y ?? 0, width: 0, height: 0 }}
        />,
        document.body,
      )}
      <DropdownMenuContent align={align} side={side}>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
```

Why this works: `createPortal` relocates only the trigger's **DOM node** to
`document.body` (outside the `transform-gpu` backdrop), so its `position: fixed`
resolves against the viewport and `getBoundingClientRect()` reports the true cursor
point that base-ui's positioner reads. The trigger stays in the React tree under
`<DropdownMenu>`, so Menu context is intact. `DropdownMenuContent` already
self-portals + theme-forwards (`usePortalForwardedAttrs`), so no extra theming
needed. Both current menus already pass `align="start" side="bottom"` — baked as
defaults.

**Migrate the two menus** (drop their local `interface MenuAnchor`, the
`<DropdownMenu>` skeleton, and the buggy `<DropdownMenuTrigger>`; keep all
`DropdownMenuItem`/`Sub`/etc. as children — those still import from ui-kit):

1. `plugins/apps/plugins/surface/plugins/floating/plugins/wallpaper/web/components/desktop-context-menu.tsx`
   — `DesktopContextMenuContent` body becomes
   `<CursorAnchoredMenu anchor={anchor} onClose={onClose}>{…2 items…}</CursorAnchoredMenu>`.
   Host (`DesktopContextMenu`) is unchanged except using `CursorAnchor` for its
   `anchor` state type.

2. `plugins/apps/plugins/surface/plugins/floating/web/components/window-system-menu.tsx`
   — replace the `<DropdownMenu>…<DropdownMenuTrigger/>…<DropdownMenuContent align side>`
   wrapper with `<CursorAnchoredMenu anchor={anchor} onClose={onClose}>{…all items…}</CursorAnchoredMenu>`.
   This file currently `export`s `interface MenuAnchor`; keep the name as a
   re-export/alias of `CursorAnchor` (`export type MenuAnchor = CursorAnchor`) so
   its caller `window-chrome.tsx` (`openMenuAt(e.clientX, e.clientY)`) and the
   `MenuAnchor` import keep compiling unchanged.

## Part 3 — Lint: close the inline-`style` `position` hole

`no-adhoc-layout` already bans `fixed`/`absolute`/`sticky` as **class tokens**, but
only reads `className`/`cn()` strings — so the inline-`style` form
(`style={{ position: "fixed" }}`) sails through. That's the exact path this bug
shipped on. Extend the rule to also flag string-literal `position` values in inline
`style` objects, redirecting future hand-rolled positioning to the two primitives.

**Sequencing (important):** land this **after** Parts 1 & 2. The rule fires repo-wide
at `error`, and `./equin check` (and `build`) would fail on the 5 existing
sites until they're migrated. Once Parts 1 & 2 + the allowlist below are in, the
standing violation count is **0** — the rule becomes a pure forward guardrail. A
genuine one-off still escapes per-site via
`// eslint-disable-next-line layout/no-adhoc-layout -- <reason>`.

**Rule change** — `plugins/primitives/plugins/css/lint/no-adhoc-layout.ts`:
- Extend the existing `JSXAttribute(node)` visitor: when `node.name.name === "style"`
  and the value is a `JSXExpressionContainer` wrapping an `ObjectExpression`, find a
  `Property` whose key is `position` (Identifier or string `Literal`) and whose value
  is a string `Literal` matching the existing `POSITION` regex
  (`/^(?:absolute|fixed|sticky)$/`). Report it. Reuse `POSITION` so `relative`/`static`
  stay benign, identical to the className path.
- Add a dedicated message id (e.g. `adhocStylePosition`) whose text names the two
  homes: "inline `position: \"{{value}}\"` is banned — anchor a menu at a cursor via
  `CursorAnchoredMenu` (@plugins/primitives/plugins/cursor-menu/web), measure off-screen
  via `MeasureStrip` (@plugins/primitives/plugins/css/plugins/measure-strip/web), or
  compose `fixed`/`absolute` through `<Overlay>`/`<Pin>`/`ViewportOverlay`. Genuine
  one-off: eslint-disable with a reason."
- Scope is `position` only (per design). Do **not** also grab inline `top`/`left`/`inset`
  — that widens false positives (legit fixed/absolute children set offsets) without
  adding signal; the `position` keyword is the discriminating token.
- Does NOT catch: dynamic values (`position: posVar` — non-literal), imperative
  `el.style.position = …`, or `style={{ ...spread }}`. Same literal-only limit as the
  class path; acceptable.

**Allowlist** — `plugins/primitives/plugins/css/lint/index.ts` `ignores`: add the two
new primitives so the sanctioned homes keep their raw mechanics (mirrors how the
layout primitives — `<Grid>`/`<Overlay>`/… — are already exempted):
```
plugins/primitives/plugins/css/plugins/measure-strip/**
plugins/primitives/plugins/cursor-menu/**
```

**Tests** — `plugins/primitives/plugins/css/lint/no-adhoc-layout.test.ts` (bun:test,
`RuleTester`): add invalid cases (`style={{ position: "fixed" }}`,
`"absolute"`, `"sticky"`) and valid cases (`position: "relative"`,
`position: "static"`, a dynamic `position: pos`, and a plain `className` with no
position). The allowlist is path-based (config-level `ignores`), so it's verified by
the `eslint` check at build, not by `RuleTester`.

**Re-scan before enabling:** `rg -n 'position:\s*["'\''`](fixed|absolute|sticky)' -g '*.tsx' -g '*.ts'`
must return only the migrated sites (all inside the two allowlisted primitives). Today
that grep returns exactly the 5 sites and zero `absolute`/`sticky`, so post-migration
it must be empty outside the allowlist.

## Boundary / registry notes

- New cross-plugin imports are all legal runtime-barrel imports:
  consumers import `@plugins/primitives/plugins/css/plugins/measure-strip/web` and
  `@plugins/primitives/plugins/cursor-menu/web`; `cursor-menu` imports
  `@plugins/primitives/plugins/css/plugins/ui-kit/web`. No re-exports, no deep paths.
- Each new plugin needs `web/index.ts` with a single `export default {...} satisfies PluginDefinition`.
- **Do not hand-edit any registry.** Run `./equin build` — it regenerates
  `web.generated.ts` from the filesystem (the `plugins-registry-in-sync` check
  fails on drift). Add a one-line autogen-style `CLAUDE.md` per plugin (the
  `plugins-doc-in-sync` check expects it; build regenerates the reference block).

## Critical files

New:
- `plugins/primitives/plugins/css/plugins/measure-strip/web/{index.ts,internal/measure-strip.tsx}` (+ package.json, CLAUDE.md)
- `plugins/primitives/plugins/cursor-menu/web/{index.ts,internal/cursor-anchored-menu.tsx}` (+ package.json, CLAUDE.md)

Modified:
- `plugins/primitives/plugins/responsive-overflow/web/internal/responsive-overflow.tsx`
- `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx`
- `plugins/apps/web/components/app-tab-bar.tsx`
- `plugins/apps/plugins/surface/plugins/floating/plugins/wallpaper/web/components/desktop-context-menu.tsx`
- `plugins/apps/plugins/surface/plugins/floating/web/components/window-system-menu.tsx`
- `plugins/primitives/plugins/css/lint/no-adhoc-layout.ts` (Part 3 — inline-style `position` scan)
- `plugins/primitives/plugins/css/lint/no-adhoc-layout.test.ts` (Part 3 — new cases)
- `plugins/primitives/plugins/css/lint/index.ts` (Part 3 — `ignores` allowlist for the 2 new primitives)

Reuse / mirror (don't reinvent):
- `ViewportOverlay` (`plugins/primitives/plugins/css/plugins/viewport-overlay/`) — precedent for body-portal + the barrel shape; **not** wrapped (it's `fixed inset-0`, wrong for a point anchor — use raw `createPortal`).
- `popover` / `icon-button` barrels — structural template for the two new plugins.
- ui-kit `DropdownMenu*` exports (`plugins/primitives/plugins/css/plugins/ui-kit/web`).

## Verification

1. `./equin build` (regenerates registry + docs; runs checks). Must pass
   `type-check`, `plugins-registry-in-sync`, `plugins-doc-in-sync`,
   `plugin-boundaries`, and `eslint` (Part 3 — the extended rule must report
   **0** standing violations once all 5 sites are migrated + allowlisted).
   Sanity grep: `rg -n 'position:\s*["'\''`](fixed|absolute|sticky)' -g '*.tsx' -g '*.ts'`
   returns only paths under the two allowlisted primitives.
1b. Part 3 unit check: `bun test plugins/primitives/plugins/css/lint/no-adhoc-layout.test.ts`
   (new invalid inline-`style` `position` cases + valid `relative`/`static`/dynamic cases).
2. App at `http://att-1782371775-pwcb.localhost:9000`. Switch a tab to the
   **floating** placement.
3. **Bug fix — desktop menu:** right-click empty desktop → menu's top-left appears
   **at the cursor** (no downward/rightward shift). Verify scripted:
   ```bash
   bun e2e/screenshot.mjs --url 'http://att-1782371775-pwcb.localhost:9000' --out /tmp/desktop-menu
   ```
   (extend the helper to right-click at a known point and assert the menu rect's
   top-left ≈ the click point).
4. **Bug fix — window menu:** right-click a floating window's titlebar → menu opens
   at the cursor; submenus ("Merge into ▸", "Move to desktop ▸") still open and
   items fire.
5. **MeasureStrip regressions (no visual change expected):**
   - App tab bar still collapses/overflows tabs correctly as the window narrows.
   - A pane toolbar with many actions still moves overflow into the "⋯" menu.
   - Any `ResponsiveOverflow` consumer still hides children that don't fit.
6. Optional unit coverage: `MeasureStrip` renders nothing when `enabled={false}`
   and portals an off-screen `aria-hidden` node when enabled — co-located
   `web/__tests__/*.test.tsx` (jsdom), run via `bun run test:dom`.
