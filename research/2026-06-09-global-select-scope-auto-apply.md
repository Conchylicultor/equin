# Auto-apply the Ctrl+A select-scope guard to all bounded content surfaces

## Context

`ContentScope` (`plugins/primitives/plugins/select-scope`) is a tiny keyboard guard: a
`tabIndex=-1` div whose `onKeyDown` intercepts Ctrl/Cmd+A and selects only *its* DOM
subtree instead of the whole page. Today it must be wrapped **manually** by each consumer
(~10 call sites), and the only broad coverage is `PaneChrome` wrapping each pane's content
once (`plugins/primitives/plugins/pane/web/components/pane-chrome.tsx:107`).

The consequence: any **bounded sub-surface** the user wants to "select all" inside —
a popover/dialog/sheet body, a toast message, or a card — falls under the *pane's* scope,
so Ctrl+A grabs the entire pane instead of the surface. The two structural gaps:

1. **Portalled overlays** (Popover/Dialog/Sheet) render through `*Primitive.Portal` and
   thus escape the pane's DOM subtree entirely — they have no scope at all unless each
   wraps its own.
2. **Cards** render in-flow *inside* the pane, so they're swallowed by the pane's single
   scope; a card needs its *own* nested scope to make Ctrl+A select just the card. There
   is **no shared Card component** today — ~9 bespoke `*-card.tsx` shells each hand-roll
   `rounded + border + bg + padding`, so there's nowhere central to inject the scope.

Nesting `ContentScope` is safe: the innermost handler calls `preventDefault()`, and every
outer handler bails on `!e.defaultPrevented`, so the most-specific surface always wins.

**Goal:** make select-scoping *structurally automatic* for every present and future
bounded surface, with zero per-consumer discipline — by baking it into each surface's
single render funnel, and creating that funnel (a `Card` primitive) where one is missing.

**Decisions (confirmed with user):**
- Overlays: **content overlays only** — Popover, Dialog, Sheet. Leave DropdownMenu /
  Select untouched (menus; Ctrl+A select-all is meaningless there).
- Card migration: **migrate all**, `eslint-disable` the 2 cards that resist clean
  absorption (`task-draft-card` DnD, `community-theme-card` button-root + inline bg).

## Approach

### Step 0 — Extend the `select-scope` primitive with a composable hook

So a card root can *be* the scope without nesting an extra div, expose the keydown wiring
as spreadable props alongside the existing component.

File: `plugins/primitives/plugins/select-scope/web/internal/select-scope.tsx`
- Keep `handleSelectAllScope` (unchanged).
- Export a constant `selectScopeProps = { tabIndex: -1 as const, onKeyDown: handleSelectAllScope }`.
- Reimplement `ContentScope` on top of it, and add an optional `fill?: boolean` (default
  `true`) so non-pane callers can drop `h-full`:
  ```tsx
  export function ContentScope({ children, fill = true }: { children: ReactNode; fill?: boolean }) {
    return (
      <div {...selectScopeProps} className={cn("outline-none", fill && "h-full")}>
        {children}
      </div>
    );
  }
  ```
  (`fill={true}` preserves current behavior for the ~10 existing callers — verify none
  break, esp. `pane-chrome.tsx` which relies on `h-full`.)

File: `plugins/primitives/plugins/select-scope/web/index.ts`
- Add `export { selectScopeProps } from "./internal/select-scope";` and update the
  `description`.

### Step 1 — Auto-wrap content overlays (web-core/ui)

Wrap the children render of each content-overlay funnel in `<ContentScope fill={false}>`.
Import: `import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";`
(Boundary-checked OK: `plugin.** -> plugin.**` allows it; **no cycle** — `web-core`
already imports `web-sdk/core`, and `select-scope` only imports `web-sdk/core`, which does
not import `web-core`.)

- `plugins/framework/plugins/web-core/web/components/ui/popover.tsx` — `PopoverContent`
  spreads `{...props}` into `<PopoverPrimitive.Popup>`; destructure `children` out and
  render `<PopoverPrimitive.Popup ...><ContentScope fill={false}>{children}</ContentScope></PopoverPrimitive.Popup>`.
- `plugins/framework/plugins/web-core/web/components/ui/dialog.tsx` — `DialogContent`
  already destructures `children` (line ~36); wrap `{children}` inside `<DialogPrimitive.Popup>`.
- `plugins/framework/plugins/web-core/web/components/ui/sheet.tsx` — `SheetContent`; wrap
  **only** `{children}` (line ~59), leaving the sibling `SheetPrimitive.Close` button outside.
- **Do NOT touch** `dropdown-menu.tsx` / `select.tsx`.

> These are shadcn "generated" files but already heavily customized (z-tokens, ring
> styles); this is a deliberate, documented customization. Accept the small risk that a
> future `shadcn add` regen could clobber it.

Cleanup of now-redundant manual wrap (double-wrap is harmless but should go):
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/raw-json-button.tsx`
  (lines 3, 23–27) — remove the explicit `<ContentScope>` around the `InlinePopover` body
  and drop the import.

### Step 2 — Auto-wrap toasts (toaster-root)

File: `plugins/shell/plugins/toaster/web/components/toaster-root.tsx`. The handler builds
the toast from `{ title, description }` strings and calls `sonnerToast(message, opts)`.
Pass the message as a `ContentScope`-wrapped node so a click into the toast (focuses the
`tabIndex=-1` div) + Ctrl+A selects only the toast:
```tsx
fn(<ContentScope fill={false}>{message}</ContentScope>, {
  description: opts.description ? <ContentScope fill={false}>{opts.description}</ContentScope> : undefined,
});
```
> Caveat to note in the PR: toasts aren't keyboard-focusable by default; the scope only
> takes effect once the user clicks into the toast (same mechanism as panes). This is the
> best achievable without a custom sonner renderer.

### Step 3 — Create the `Card` primitive

New plugin `plugins/primitives/plugins/card/`, mirroring the `row` primitive's shape
(`plugins/primitives/plugins/row/`). Files:
```
plugins/primitives/plugins/card/
  package.json        # @singularity/plugin-primitives-card (name/description/private/version only)
  web/index.ts        # export { Card, type CardProps }; default PluginDefinition (contributions: [])
  web/internal/card.tsx
  lint/index.ts       # { name: "card", rules: { "no-adhoc-card": ... }, ignores: { "no-adhoc-card": [] } }
  lint/no-adhoc-card.ts
  CLAUDE.md
```

`card.tsx` — polymorphic, scope baked into the root (no extra wrapper div):
```tsx
export interface CardProps extends ComponentPropsWithoutRef<"div"> {
  as?: "div" | "button" | "a" | "li";
  interactive?: boolean;   // adds cursor + hover:border-primary/60 hover:bg-muted/40
  selected?: boolean;      // border-primary ring
}
// root: <Comp {...selectScopeProps} className={cn(BASE, interactive && HOVER, selected && SEL, className)} {...rest}>
```
- `BASE`: the common shell — `rounded-md border border-border bg-card p-3` (the dominant
  cluster). Variants that need `rounded-lg` / `bg-background` / `bg-muted/30` / different
  padding pass `className` (cn merge wins).
- Spread `selectScopeProps` on the root so the **card itself is the select-scope**.
- Forward `ref` (needed for DnD migration; use `forwardRef`).

> Static padding `p-3` (not a density token). Adding a runtime-themeable `p-card` utility
> (parallel to `p-row` in `web-core/web/theme/app.css:300-305`, backed by new `--pad-card-*`
> density vars) is **optional follow-up**, not required for this change.

`lint/no-adhoc-card.ts` — copy the `JSXAttribute` + `collectTokens` structure from
`plugins/primitives/plugins/row/lint/no-adhoc-row.ts`. Fingerprint fires only when a
`className` on an intrinsic host tag (`div`/`button`/`a`/`span`) contains **all** of:
`rounded(-sm|-md|-lg)?` **and** `border` **and** one of `bg-card | bg-muted* | bg-background`
**and** a padding token (`p-*` / `px-*`+`py-*`). Capitalized component tags auto-skip (so
`<Card>` is the sanctioned escape). Escape hatches: route through `<Card>`, or
`// eslint-disable-next-line card/no-adhoc-card -- <reason>`. No autofix. The root
`eslint.config.ts` auto-discovers `lint/index.ts` and enforces `card/no-adhoc-card`
repo-wide at `error`.

### Step 4 — Migrate cards onto `Card`

Migrate cleanly (replace bespoke shell `div`/`button` with `<Card>`, moving any non-default
chrome to `className`, and `as="button"`/`interactive`/`onClick` as needed):
- `collapsible-card.tsx` (tone-driven bg → `className`; static div root)
- `song-card.tsx` (`interactive`, `as="div"` role=button kept, `rounded-lg p-4`)
- `plugin-change-card.tsx` (`overflow-hidden`, no padding → `className`)
- `task-card.tsx` (`bg-background p-2 my-2` → `className`) + its inner attempts card
- `data-card.tsx` (`interactive`, `rounded-lg p-4`) — already the closest fit
- `turn-summary-card.tsx` (`bg-muted/30 px-3 py-2 text-xs` → `className`)
- `workflow-node-card.tsx` (`as="button"`, ring emphasis → `className`; remove its existing
  `row/no-adhoc-row` disable if no longer triggered)

Keep markup + add `// eslint-disable-next-line card/no-adhoc-card -- <reason>` for:
- `task-draft-card.tsx` — DnD `setNodeRef` + `cursor-grab` + drag shadow.
- `community-theme-card.tsx` — `<button>` root with inline-style bg + `hover:ring` affordance.

Non-targets (confirmed not cards): `tool-call-card.tsx` (thin `CollapsibleCard` wrapper —
gets scope transitively), `midi-card-meta.tsx` (a slot contribution, no chrome).

### Step 5 — Register the plugin & build

- Add `card` to the web plugin registry the same way `row`/`badge` are registered
  (`web/src/plugins.ts` per the registry-exclusivity rule — confirm exact file during impl).
- `bun install` (new workspace package), then `./equin build`.

## Critical files

- `plugins/primitives/plugins/select-scope/web/internal/select-scope.tsx` (+ `web/index.ts`) — hook + `fill`
- `plugins/framework/plugins/web-core/web/components/ui/{popover,dialog,sheet}.tsx` — overlay funnels
- `plugins/shell/plugins/toaster/web/components/toaster-root.tsx` — toast funnel
- `plugins/conversations/.../jsonl-viewer/web/components/raw-json-button.tsx` — remove redundant wrap
- `plugins/primitives/plugins/card/**` — NEW primitive + lint rule
- `plugins/primitives/plugins/row/{web/internal/row.tsx,lint/no-adhoc-row.ts}` — shape to mirror
- `web/src/plugins.ts` — register the new plugin
- the ~9 `*-card.tsx` migration targets listed in Step 4

## Verification

1. `./equin build` — must succeed (migrations/docgen no-op; this is web-only).
2. `./equin check` — `eslint` (new `card/no-adhoc-card` must pass: every flagged
   site is either migrated or has a justified disable) and `plugin-boundaries` (confirm the
   `web-core → select-scope` import is accepted; no new cycle).
3. Scripted Playwright at `http://att-1781017709-8iuw.localhost:9000`:
   - **Card**: open a view with cards (e.g. a conversation with tool-call cards, or the
     sonata library gallery). Click inside one card, press Ctrl+A → only that card's text
     highlights, not the whole pane. (Use `e2e/screenshot.mjs` with `--click` then a
     keyboard step, or a small custom script asserting `window.getSelection()` range is
     contained in the card.)
   - **Popover**: open `raw-json-button`'s popover, click in the JSON body, Ctrl+A → only
     the JSON selected.
   - **Toast**: trigger a toast, click its text, Ctrl+A → only the toast text selected.
4. Sanity: existing pane Ctrl+A still scopes to the pane (regression check on the `fill`
   default), and nested case (card inside pane) selects the card, not the pane.
