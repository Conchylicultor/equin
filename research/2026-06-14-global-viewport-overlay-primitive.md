# Viewport-overlay primitive + lint guard for `fixed inset-0` under transformed ancestors

## Context

Several surfaces deliberately put `transform-gpu` on a container to make it the
**containing block** for `position: fixed` app chrome (so a shadcn sidebar's
`fixed inset-y-0` clips to the content area below the tab bar, by design). The
relevant sources today:

- `plugins/apps/plugins/surface/web/components/surface-body.tsx:55` — the shared
  surface backdrop (`transform-gpu`).
- `plugins/apps/plugins/surface/web/components/surface-body.tsx:133` — the per-tab
  content inset (`transform-gpu`).
- `plugins/apps/web/components/apps-layout.tsx:59` — the fallback docked tab body.

Side effect: **any** descendant using `position: fixed` to mean "fill the
viewport" (a fullscreen/solo overlay) is instead bounded by that transformed
ancestor and silently clipped to the content area — below the tab bar, right of
the rail — with no error or warning. It only surfaces as a wrong-looking
screenshot.

This already bit the per-tab **solo** fullscreen mode, worked around ad-hoc by
portaling its container to `document.body`
(`surface-body.tsx:170-176`). The same trap is latent for every future
fullscreen overlay, and is repeated by hand in `lightbox`, `element-picker`, and
`draw-on-app` (each manually `createPortal`s to body). The intended outcome: a
**sanctioned primitive** that bakes in the correct behavior, plus a **lint rule**
that forces ad-hoc viewport overlays through it — exactly the
`<Surface>` + `no-adhoc-surface` model.

Decisions taken with the user:
- **Guard = primitive + lint rule** (not one or the other).
- **Migration = the three already-portaled sites only** (dogfood the primitive);
  leave the delicate solo keep-alive toggle as-is; surface the un-portaled queue
  drawers as lint findings to resolve per-site.

## Why not "flag `fixed inset-0` under a transform-gpu subtree" directly

That ancestor relationship is a **runtime DOM fact** that crosses component
boundaries (the overlay and the `transform-gpu` container live in different
plugins). It is not statically analyzable. The realistic, false-positive-bounded
static guard is the same one `no-adhoc-surface` uses: provide a primitive that is
correct by construction, then lint-ban the ad-hoc recipe (`fixed inset-0` on an
intrinsic host tag) with a per-site escape hatch.

## Part 1 — the `viewport-overlay` primitive

New leaf primitive at `plugins/primitives/plugins/viewport-overlay/`, structured
exactly like `card` / `surface`:

```
plugins/primitives/plugins/viewport-overlay/
  package.json                       # @singularity/plugin-primitives-viewport-overlay
  CLAUDE.md                          # prose + autogen reference block
  web/
    index.ts                         # barrel
    internal/viewport-overlay.tsx    # the component
  lint/
    index.ts                         # default { name, rules, ignores }
    no-adhoc-viewport-overlay.ts     # the rule
```

### Component (`web/internal/viewport-overlay.tsx`)

```tsx
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn, usePortalThemeScope } from "@plugins/primitives/plugins/ui-kit/web";

// Recipe lives in module consts (not inline className literals) so the
// no-adhoc-viewport-overlay rule — which only harvests literals reached from a
// className attribute subtree — never flags the primitive that owns it. Same
// trick `<Card>`/`<Surface>` use to dodge their own lint.
const OVERLAY_ROOT = "fixed inset-0";
const LAYER_CLASS = { popover: "z-popover", draw: "z-draw", max: "z-max" } as const;

export interface ViewportOverlayProps {
  /** Stacking layer. Defaults to "popover" (the documented portaled-layer). */
  layer?: keyof typeof LAYER_CLASS;
  /**
   * When false, render children inline (no portal, no fixed wrapper). The
   * extension point for keep-alive toggles like the solo tab, where the same
   * React element must move in/out of the portal without remounting.
   */
  active?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The sanctioned home for a viewport-filling overlay. Self-portals to
 * document.body so its `fixed inset-0` box is relative to the real VIEWPORT —
 * never to a `transform-gpu` (or other transform/filter) ancestor that would
 * otherwise contain and silently clip it. Stamps `data-theme-scope` from
 * usePortalThemeScope() so themed content survives the portal out of an app
 * surface.
 */
export function ViewportOverlay({
  layer = "popover",
  active = true,
  className,
  children,
}: ViewportOverlayProps) {
  const scope = usePortalThemeScope();
  if (!active) return <>{children}</>;
  return createPortal(
    <div data-theme-scope={scope} className={cn(OVERLAY_ROOT, LAYER_CLASS[layer], className)}>
      {children}
    </div>,
    document.body,
  );
}
```

### Barrel (`web/index.ts`)

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { ViewportOverlay, type ViewportOverlayProps } from "./internal/viewport-overlay";

export default {
  description:
    "Viewport-filling overlay primitive: self-portals to document.body + z-layer + theme-scope so fixed inset-0 fills the real viewport, never a transformed ancestor.",
  contributions: [],
} satisfies PluginDefinition;
```

Reuses, no new infra:
- `usePortalThemeScope`, `cn` from `@plugins/primitives/plugins/ui-kit/web`
  (`portal-theme-scope.tsx`).
- The `z-popover | z-draw | z-max` utilities from `z-layers` / `app.css` (no raw
  z-index — `no-adhoc-zindex` stays satisfied).

## Part 2 — the lint rule

`plugins/primitives/plugins/viewport-overlay/lint/no-adhoc-viewport-overlay.ts`,
copied structurally from `plugins/primitives/plugins/surface/lint/no-adhoc-surface.ts`:

- Reuse its **simple** `collectTokens` (harvests only `Literal` / `TemplateElement`
  strings reached structurally from the `className` value; identifiers and
  call-expression bodies are opaque) and `baseClass` (strips variant prefixes).
  This is the non-sentinel variant, so **no** entry in `class-token-walk-in-sync`
  is needed.
- **Host-tag gate**: only intrinsic `span` / `div` / `button` / `a`. Capitalized
  component tags (e.g. base-ui `DialogPrimitive.Backdrop` in the shadcn
  `dialog.tsx`/`sheet.tsx`) are skipped for free.
- **Fingerprint** (the unambiguous viewport-fill recipe): `tokens.has("fixed") &&
  tokens.has("inset-0")`. Report once on the node.
- **Message**: route through `<ViewportOverlay>` from
  `@plugins/primitives/plugins/viewport-overlay/web`, which self-portals to
  `document.body` so it fills the real viewport regardless of any transformed
  ancestor; escape a genuinely-contained case via
  `// eslint-disable-next-line viewport-overlay/no-adhoc-viewport-overlay -- <reason>`.

`lint/index.ts`:

```ts
import noAdhocViewportOverlay from "./no-adhoc-viewport-overlay";

export default {
  name: "viewport-overlay",
  rules: { "no-adhoc-viewport-overlay": noAdhocViewportOverlay },
  ignores: { "no-adhoc-viewport-overlay": [] }, // start empty; mirror surface
};
```

**No self-flag**: the primitive keeps its `fixed inset-0` in the `OVERLAY_ROOT`
module const, invisible to the rule. **No solo-flag**: `surface-body.tsx`'s
`containerClass()` returns the string from a helper function body, not from a
className subtree, so the rule never reaches it (verify during impl).

### Expected lint findings on first run

- `plugins/debug/plugins/queue/web/components/queue-view.tsx:201` (`JobDrawer`)
  and `:328` (`EmissionDrawer`) — `fixed inset-0 z-popover`, **not** portaled, so
  currently clipped to the pane. Per-site decision during impl: if the drawer is
  meant to cover only its pane (most likely for a debug drawer), change `fixed` →
  `absolute inset-0` (pane-relative, correct); if it is meant to be a true
  viewport overlay, route through `<ViewportOverlay>`. Confirm the literal form
  before deciding.
- The three migration targets below — resolved by the migration, not disables.

## Part 3 — migrate the three already-portaled sites (dogfood)

Each currently hand-rolls `createPortal(<div className="fixed inset-0 z-… …">, document.body)`.
Replace with `<ViewportOverlay layer="…" className="<non-positioning classes>">`
and drop the local `createPortal` import + the `fixed inset-0 z-…` literal.

1. **Lightbox** — `plugins/primitives/plugins/text-editor/plugins/paste-images/web/components/lightbox.tsx`
   (`fixed inset-0 z-popover`) → `<ViewportOverlay layer="popover" …>`.
2. **Element picker** — `plugins/improve/plugins/element-picker/web/components/picker-button.tsx`
   (the `createPortal`) + `picker-overlay.tsx` (`fixed inset-0 z-max`) →
   `picker-button` renders `<ViewportOverlay layer="max" className="<pointer-events etc.>">…</ViewportOverlay>`;
   `PickerOverlay`'s outer div drops `fixed inset-0 z-max` (the primitive now owns
   positioning), keeping its other classes.
3. **Draw-on-app** — `plugins/screenshot/plugins/draw-on-app/web/components/draw-on-app-button.tsx`
   (the `createPortal`) + `live-draw-overlay.tsx` (`fixed inset-0 z-draw`) →
   `<ViewportOverlay layer="draw" …>`.

Bonus: these gain `data-theme-scope` inheritance (currently they portal without
it) — an improvement, not a regression.

**Out of scope this pass:** the solo tab in `surface-body.tsx`. Its delicate
dock↔solo keep-alive depends on the exact `solo ? createPortal(container, body)
: container` toggle. The primitive's `active` prop is the designed clean
migration (`<ViewportOverlay active={solo} layer="max">{container}</ViewportOverlay>`)
but is deferred so this change touches no load-bearing surface code.

## Critical files

- New: `plugins/primitives/plugins/viewport-overlay/{package.json,CLAUDE.md,web/index.ts,web/internal/viewport-overlay.tsx,lint/index.ts,lint/no-adhoc-viewport-overlay.ts}`
- Templates to mirror: `plugins/primitives/plugins/card/web/{index.ts,internal/card.tsx}`,
  `plugins/primitives/plugins/surface/lint/{index.ts,no-adhoc-surface.ts}`,
  `plugins/primitives/plugins/spacing/lint/index.ts`
- Migrate: `lightbox.tsx`, `picker-button.tsx` + `picker-overlay.tsx`,
  `draw-on-app-button.tsx` + `live-draw-overlay.tsx`
- Resolve findings: `plugins/debug/plugins/queue/web/components/queue-view.tsx`
- Regenerated by build (do not hand-edit): `…/tooling/plugins/lint/core/lint.generated.ts`,
  `web.generated.ts`, `docs/plugins-*.md`

## Verification

1. `./equin build` — regenerates the lint/web registries and docs; runs
   `type-check`. Confirms the new rule is registered and the barrel compiles.
2. `./equin check` — the new rule runs repo-wide. Expect **only** the two
   queue-drawer findings (then fixed); the primitive, solo helper, and migrated
   sites must be clean. `plugins-registry-in-sync` / `plugins-doc-in-sync` /
   `class-token-walk-in-sync` must all pass.
3. Optional `bun test` RuleTester spec co-located at
   `lint/no-adhoc-viewport-overlay.test.ts`: `<div className="fixed inset-0">`
   flags; `<div className="absolute inset-0">`, `<div className="fixed top-2">`,
   and `<ViewportOverlay className="fixed inset-0">` (capitalized) do not.
4. Manual, the real proof — deploy and, inside a **docked** tab (which lives
   under the `transform-gpu` surface), trigger each migrated overlay and confirm
   it fills the **whole viewport** (covers the tab bar + app rail), not just the
   content area:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000 --click "<trigger>" --out /tmp/overlay
   ```
   Compare `-before.png` / `-after.png`. A correct overlay paints edge-to-edge.
