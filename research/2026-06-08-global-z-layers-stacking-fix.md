# Structural fix for z-axis / stacking bugs

**Date:** 2026-06-08
**Category:** global (web-core theme + new primitive + lint rule + one primitive refactor)

## Context

Floating UI keeps painting *under* sibling content — most recently the prompt-editor
template/preprompt panel rendered below the user message (screenshot that prompted this).
The root cause is **stacking contexts**, not the z-index numbers: `z-index` only orders
siblings *within one stacking context*, so raw `z-10`/`z-50` values scattered across 66
call sites are fighting battles they can't win, and hand-rolled floating panels that stay
in the document subtree get trapped behind `overflow`/`transform`/sticky ancestors.

How standard apps avoid this, and what we adopt:

1. **Portal everything that floats** so it escapes ancestor stacking contexts; DOM order in
   the portal root becomes the (correct) tiebreaker. Our base-ui `popover`/`dialog`/`dropdown`/
   `tooltip` already do this and never conflict. The `floating-action` primitive does **not**
   — it positions with bare `absolute` inside the trigger's subtree. **That is the bug.**
2. **A small, ordered, named z-scale** (design tokens) instead of raw numbers, for the handful
   of elements that legitimately stay in-flow (sticky headers, sidebar, the floating bar).
3. **Lint enforcement** so raw `z-<n>` / `z-[…]` can't be merged again — mirroring the existing
   `control-size` / `no-adhoc-control` precedent.

Decisions taken (from clarifying Q&A):
- **floating-action: portal the panel but keep the morph** animation and identical UX.
- **Scope now:** fix the bug + introduce tokens + lint, migrating only the hand-rolled *fixed*
  overlays; the ~25 in-flow `z-10/20/30` sticky sites are temporarily **exempted** via the lint
  allowlist. A **follow-up task** completes the migration and removes the exempt list.

---

## Part 1 — Portal `floating-action`, keep the morph (fixes the bug)

**File:** `plugins/primitives/plugins/floating-action/web/internal/floating-action.tsx`

### Why it breaks today
The panel is `<div absolute w-max {anchor}>` nested inside the in-flow `group/fa` wrapper
(lines 80–112). It never leaves the prompt-editor subtree, so it is clipped by
`overflow-hidden` and painted under the `z-20` sticky user-message headers. No z-index on the
wrapper can lift it out of that stacking context.

### The morph constraint
The "morph" is: a `sizer` div reserves the collapsed footprint in-flow (measured in
`useLayoutEffect`, lines 71–78), and the panel grows in place via
`transition-[width,max-width,max-height,…]`. The visuals are driven by `group-data-hovered/fa:*`
selectors on the panel and on `FloatingActionFadeIn` children — these **require a `group/fa`
ancestor in the DOM**, which a naïve portal would sever.

### Design (preserves morph + all consumer classes)
Split the current single tree into an **in-flow anchor stub** and a **portaled panel subtree**
that re-hosts `group/fa`, so the ancestor relationship inside the portal is intact:

```
<div ref={sizerRef} className={cn("relative", className)}   // IN-FLOW: reserves collapsed size, IS the anchor
     data-hovered={hovered} onMouseEnter onMouseLeave>
  <Portal>                                                   // -> document.body, escapes all stacking ctx
    <Positioner anchor={sizerRef} ...>                       // base-ui anchored positioning (scroll/resize-tracked)
      <div className="group/fa" data-hovered={hovered}       // group re-hosted INSIDE the portal
           onMouseEnter onMouseLeave>
        <div className={cn("absolute w-max", anchorClasses[anchor])}>
          <div ref={panelRef} className={cn(panelBase, "z-popover", panelClassName)}>
            {children}                                        // FloatingActionFadeIn + consumer content unchanged
          </div>
        </div>
      </div>
    </Positioner>
  </Portal>
</div>
```

Key points:
- **`group-data-hovered/fa:*` and `FloatingActionFadeIn` work unchanged** — the `group/fa` wrapper
  is still an ancestor of the panel, just relocated into the portal. **Zero changes to consumer
  `panelClassName` strings.**
- **Hover-intent spans both trees.** The existing `useHoverIntent` (close-delay already 150 ms)
  is wired to *both* the in-flow sizer and the portaled `group/fa` wrapper, sharing one `hovered`
  state. Because the panel is anchored flush over the sizer, the pointer never crosses a gap.
- **Positioning reuse:** use the same base-ui anchored-positioning machinery the popover primitive
  already uses (`@base-ui/react/popover` `Portal` + `Positioner`, see
  `plugins/framework/plugins/web-core/web/components/ui/popover.tsx`). The `Positioner` must
  *overlap* the anchor (not sit beside it) so the existing corner-pin (`anchorClasses`) + `w-max`
  growth reproduce the current geometry. **Primary implementation risk** — getting the
  side/align/offset mapping to overlap the anchor box. **Fallback** if base-ui's beside-anchor
  model proves awkward: a `position: fixed` portal positioned from `sizerRef.getBoundingClientRect()`,
  tracked via `ResizeObserver` + scroll/resize listeners (no polling).
- **z lives in the primitive, not the call sites.** The panel always renders at the new
  `z-popover` token (it is a portaled floating layer). Consumers therefore drop their own z-classes.

### Consumer updates (3 total — only the outer `className`, never `panelClassName`)
| File | Before | After |
|---|---|---|
| `plugins/floating-bar/web/components/floating-bar.tsx:40` | `className="fixed top-2 right-3 z-50"` | `className="fixed top-2 right-3"` |
| `…/message-toc/web/components/message-toc.tsx:58` | `className="absolute top-2 right-3 z-30"` | `className="absolute top-2 right-3"` |
| `…/prompt-templates/web/components/prompt-template-chips.tsx` | (no className) | unchanged — **the bug fix is free here** |

`floating-bar` keeps `fixed` (it pins to the viewport corner and now anchors the portal there);
`message-toc` keeps `absolute` (anchored to its scroll-pane container). Both previously relied on
their own z to escape — now handled by the portal + `z-popover`.

---

## Part 2 — Semantic z-layer token scale

Tailwind v4 CSS-first; tokens live in `plugins/framework/plugins/web-core/web/theme/app.css`
(`theme/CLAUDE.md`: "If a plugin needs a new token, add it here"). Mirror the existing
`@utility control-sm { height: var(--control-height-sm); }` precedent exactly (app.css:301–308):
define vars in `@theme`, expose `@utility z-<name>` classes referencing them.

```css
/* in @theme { } — static, structural (NOT runtime-themeable) */
--z-base:    0;
--z-raised:  10;   /* sticky headers, hover chrome, drag handles            */
--z-nav:     20;   /* persistent app chrome: sidebar, app-rail, pane header  */
--z-float:   30;   /* in-pane floating widgets: selection bar, message TOC   */
--z-overlay: 40;   /* full-pane bespoke overlays (pane-overlay-host)         */
--z-popover: 50;   /* portaled floating layers: floating-action, lightboxes  */
--z-draw:    60;   /* draw-on-app full-screen capture overlay                */
--z-max:     9999; /* critical banners / dev frame                           */

/* @utility block (next to control-*/p-* utilities) */
@utility z-base    { z-index: var(--z-base); }
@utility z-raised  { z-index: var(--z-raised); }
@utility z-nav     { z-index: var(--z-nav); }
@utility z-float   { z-index: var(--z-float); }
@utility z-overlay { z-index: var(--z-overlay); }
@utility z-popover { z-index: var(--z-popover); }
@utility z-draw    { z-index: var(--z-draw); }
@utility z-max     { z-index: var(--z-max); }
```

**Migrate now (hand-rolled *fixed* overlays only):**
| File:line | Before | After |
|---|---|---|
| `plugins/floating-bar/web/components/floating-bar.tsx` | `z-50` | (removed — Part 1) |
| `plugins/primitives/plugins/text-editor/plugins/paste-images/web/components/lightbox.tsx:26` | `z-50` | `z-popover` |
| `plugins/debug/plugins/queue/web/components/queue-view.tsx:200,324` | `z-50` | `z-popover` |
| `plugins/page/plugins/editor/web/components/slash-menu-plugin.tsx:164` | `z-50` | `z-popover` |
| `plugins/screenshot/plugins/draw-on-app/web/components/live-draw-overlay.tsx:51` | `z-[60]` | `z-draw` |
| `plugins/framework/plugins/web-core/web/components/plugin-load-errors.tsx:5` | `z-[9999]` | `z-max` |

`app.css:267` (`.experimental::after { z-index: 9999 }`) is raw CSS, not a class — change to
`var(--z-max)` for single-sourcing. The `reorder/web/internal/group-box.tsx:72`
`style={{ zIndex: 50 }}` is an inline DnD style, not a className — leave as-is (not lint-scoped).

**Exempt now, migrate in follow-up (~25 in-flow sites):** all `z-0/z-10/z-20/z-30/z-[1]/z-[2]`
sticky-header / hover-chrome / drag-handle sites, plus the base-ui `web-core/web/components/ui/*`
`z-50`/`z-10` (already portaled; numeric value is irrelevant inside their own portal context).
Full inventory captured below.

---

## Part 3 — `no-adhoc-zindex` lint rule (new `z-layers` primitive)

Mirror `control-size` exactly — a lint-only plugin (no runtime barrel). Discovery is automatic:
the codegen scans for `defineCollectedDir("lint")` and `eslint.config.ts` walks every
`lint/index.ts`, enabling each rule repo-wide as `error`. **No registry edits** — just run
`./equin build` to regenerate `lint.generated.ts`.

**New plugin:** `plugins/primitives/plugins/z-layers/`
```
z-layers/
  CLAUDE.md                 # documents the scale + rationale (points at app.css tokens)
  package.json              # { "name": "@singularity/plugin-primitives-z-layers", private, 0.0.1 }
  lint/
    index.ts                # default export { name: "z-layers", rules, ignores }
    no-adhoc-zindex.ts       # the rule
```

**Rule** (`no-adhoc-zindex.ts`) — copy the structure of
`plugins/primitives/plugins/control-size/lint/no-adhoc-control.ts`:
- `ESLintUtils.RuleCreator`, `meta.type: "problem"`, `schema: []`, **no autofix** (picking the
  right layer is a per-site judgement — same stance as `no-adhoc-control`).
- Visit `JSXAttribute` on `className`; reuse the verbatim `collectTokens` recursive walk
  (handles literals, template strings, `cn(...)`, ternaries) and `baseClass` variant-stripper
  shared by `no-adhoc-control` / `no-adhoc-chip` / `no-adhoc-row`.
- Flag any token matching **`/^z-(\d|\[)/`** (catches `z-0`…`z-50`, `z-[60]`, `z-[9999]`) while
  allowing the named `z-<letter>` utilities.
- Message: "Use a semantic z-layer (`z-raised`, `z-nav`, `z-float`, `z-overlay`, `z-popover`,
  `z-draw`, `z-max`) instead of a raw z-index; see `z-layers` / app.css."

**`ignores`** (the temporary allowlist, removed in the follow-up): the ~25 in-flow files +
the `plugins/framework/plugins/web-core/web/components/ui/**` base-ui files. Listed as globs in
`lint/index.ts`'s `ignores["no-adhoc-zindex"]`, mirroring how `eslint.config.ts` applies
per-rule `exemptConfigs`.

---

## Part 4 — Follow-up task (created during execution, via `add_task` MCP)

> **Complete z-layer migration & remove the exempt list.** Migrate the ~25 in-flow
> `z-0/10/20/30/[1]/[2]` sticky-header/hover-chrome/drag-handle sites and the base-ui
> `web-core/.../ui/*` `z-50/z-10` to the semantic `z-raised/z-nav/z-float/...` tokens, then empty
> `ignores["no-adhoc-zindex"]` in `plugins/primitives/plugins/z-layers/lint/index.ts` so the rule
> enforces with zero exemptions. Verify nothing visually regresses (sidebars, sticky headers,
> data-table headers, DnD handles).

---

## Critical files

- `plugins/primitives/plugins/floating-action/web/internal/floating-action.tsx` — portal refactor (Part 1)
- `plugins/floating-bar/web/components/floating-bar.tsx`,
  `…/message-toc/web/components/message-toc.tsx` — drop consumer z-classes (Part 1)
- `plugins/framework/plugins/web-core/web/theme/app.css` — z tokens + `@utility` (Part 2)
- `lightbox.tsx`, `debug/.../queue-view.tsx`, `slash-menu-plugin.tsx`, `live-draw-overlay.tsx`,
  `plugin-load-errors.tsx` — migrate fixed overlays (Part 2)
- `plugins/primitives/plugins/z-layers/{package.json,CLAUDE.md,lint/index.ts,lint/no-adhoc-zindex.ts}` — new (Part 3)
- Reference precedents: `plugins/primitives/plugins/control-size/` (whole), `eslint.config.ts`,
  `plugins/framework/plugins/web-core/web/components/ui/popover.tsx` (Portal+Positioner pattern)

## Verification

1. `./equin build` — regenerates `lint.generated.ts` (picks up `z-layers`), rebuilds CSS
   (new `z-*` utilities), regenerates plugin docs (new plugin).
2. `./equin check eslint` — passes (allowlist covers remaining raw z); confirm the rule
   *fires* by temporarily adding a `z-50` to a non-exempt file.
3. **The bug, end-to-end** — scripted Playwright on a conversation view:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/c/<id> \
     --click "Edit" --out /tmp/fa     # hover/open the prompt-template floating panel
   ```
   Confirm the expanded panel renders **above** the user-message rows and sticky headers, is not
   clipped, and the morph animation still plays. Repeat sanity-check for the floating-bar
   (top-right) and the message-TOC (in-pane), which also flow through `floating-action`.
4. Visual sanity: sidebar/app-rail, data-table sticky header, draw-on-app overlay, plugin-load
   error banner still stack correctly.
