import {
  cn,
  SURFACE_LEVELS,
  PortalThemeScopeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { qualifyThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import { IconScopeProvider } from "@plugins/ui/plugins/icons/web";
import type React from "react";
import { AppThemeScopeProvider } from "./app-theme-scope";

/**
 * What a boundary PAINTS. Custom properties cascade *down* but paint does not
 * travel *up*, so a boundary that paints nothing is visually inert — an
 * ancestor's fill shows through, in the ancestor's theme, while everything
 * inside reads the new theme's tokens. That is the half-themed state this
 * primitive exists to make unspellable, which is why the prop is required.
 */
export type ThemeSurface = "canvas" | "chrome" | "sunken" | "none";

/**
 * The canvas each role paints, as one frozen bundle per role — the same shape
 * and the same ordering as `SURFACE_LEVELS` (background first, then the two
 * helper vars the background implies), so the two maps read as one vocabulary.
 *
 * `canvas` / `sunken` ARE `SURFACE_LEVELS` entries, read from the map rather
 * than re-spelled, so a preset swap moves a boundary and a `<Surface>` of the
 * same role together. `chrome` cannot be: `--sidebar` is its own token group
 * (`plugins/ui/plugins/tokens/plugins/sidebar-palette/`, 8 tokens with its own
 * preset picker) that a preset retints independently of `--background`, so it
 * is authored here as the complete bundle in that same shape.
 *
 * The two helper vars are not decoration — a background without them is a
 * background that lies to everything painting on it:
 *   - `--chrome-mask` is "my background, for something painting OVER me" — a
 *     sticky bar inside the boundary masks scrolled content with this
 *     (`bg-chrome-mask`) instead of the page `--background`.
 *   - `--hover-fill` is "a visible step off my background, for something
 *     highlighting INSIDE me" — a ghost `Button` hovers to `bg-hover-fill`, so
 *     without it a control dropped on the sidebar tone hovers to the page
 *     canvas's `--muted` and reads as no hover at all.
 * See the comment on `SURFACE_LEVELS` in ui-kit for the full contract.
 *
 * **The role is the ONLY way to choose a background. Never layer a `bg-*` over
 * one through `className`.** The bundle is the unit precisely because its three
 * parts have to agree, and `cn()` will happily break that agreement:
 *
 *     cn("bg-background [--chrome-mask:var(--background)]", "bg-muted/40")
 *       → "[--chrome-mask:var(--background)] bg-muted/40"
 *
 * tailwind-merge resolves the conflicting `bg-*` and drops the loser, but the
 * two helper vars are arbitrary properties with nothing to conflict WITH, so
 * they survive pointing at the tone that just left. The result is a surface
 * whose `--chrome-mask` and `--hover-fill` describe a background it no longer
 * has: a sticky bar inside it masks scrolled content with the wrong colour, and
 * a ghost control hovers to a step off a background that is not there. Both
 * fail silently and only under some presets.
 *
 * If a site seems to need a background none of the four roles offer, that is a
 * question about the role set, not a call site to patch.
 */
const THEME_SURFACES: Record<ThemeSurface, string> = {
  // Pane / page / tab canvas — the ground plane of a themed region.
  canvas: SURFACE_LEVELS.base,
  // Recessed well — a collapsed rail, a band below the base plane.
  sunken: SURFACE_LEVELS.sunken,
  // Chrome frame — the tab strip and the sidebar tone. Its background is
  // `--sidebar`, so it publishes `--sidebar-accent` as the hover step (the tone
  // `SidebarMenuButton` already highlights with), exactly as the app shell's
  // sidebar subtree does.
  chrome:
    "bg-sidebar [--chrome-mask:var(--sidebar)] [--hover-fill:var(--sidebar-accent)]",
  // Paints nothing — as a DECLARATION, not an omission. The honest case is a
  // portal host (the toaster) whose children are overlay-level cards that paint
  // themselves; painting a canvas there would be a full-viewport opaque box.
  none: "",
};

export interface ThemeProps extends Passthrough {
  /**
   * Scope token, from `appThemeScope(id)` / `paneThemeScope(pane)`,
   * `subThemeScope(subTheme)` for a sub-theme, or `fixedThemeScope(fixedTheme)`
   * for a fixed theme (the app chrome's). `undefined` = inherit the enclosing
   * theme. Both halves agree on it by construction: no attribute is stamped,
   * and `PortalForwardProvider` already treats an undefined value as a no-op.
   */
  name: string | undefined;
  /**
   * REQUIRED — what this boundary paints. Omission is not a decision: the whole
   * bug class this primitive removes is a boundary that re-themes its subtree
   * and then paints none of it. See {@link ThemeSurface}.
   */
  surface: ThemeSurface;
  /**
   * Element or component to render. Default `"div"`; `Stack`, `"button"`, … as
   * the site already is. Purely a choice of what renders — unlike `<Surface>`,
   * this primitive does NOT own `display` (see below).
   */
  as?: React.ElementType;
  className?: string;
  children?: React.ReactNode;
}

/**
 * A theme boundary: the one element that says "everything below here wears
 * theme X", complete.
 *
 * A boundary is three coordinated things, and every site used to hand-assemble
 * them — so they disagreed, silently:
 *
 *  1. `data-theme-scope` on the element — the selector `theme-engine`'s emitted
 *     CSS blocks target, which is what overrides the design tokens for the
 *     subtree (boundaries nest correctly by plain CSS cascade);
 *  2. a `PortalThemeScopeProvider` carrying the same token, so a popover or menu
 *     that portals OUT of the subtree re-stamps the attribute and keeps the
 *     theme it was opened from;
 *  3. a painted canvas, because custom properties cascade down while paint does
 *     not travel up.
 *
 * It also tells the icons inside which scope they are in (`IconScopeProvider`):
 * an icon's style is which sprite symbol it draws, which CSS cannot choose, so
 * `<Icon>` reads its scope from React context — the same token, crossing
 * portals the way the theme does. An APP boundary likewise publishes its app
 * scope (`useEnclosingAppThemeScope`), so an app's per-app settings read in JS
 * (variants) follow the same region its tokens do.
 *
 * Miss (3) and you get the failure this was found by: `PaneBox` shipped with the
 * attribute and the portal forward but no paint, so a Pages pane hosted in the
 * agent manager read Pages' `--background` and painted none of it — the user saw
 * the host's canvas under Pages' text. Miss (2) and a menu opened from the app
 * rail comes back wearing the desktop theme. Every gap is invisible until a
 * screenshot.
 *
 * Deliberately NOT built on `<Surface>`, though it reads the same frozen
 * bundles: `<Surface>` bakes in `tabIndex={-1}` and a Ctrl+A select-scope, which
 * are right for a contained card and wrong for every pane, rail and tab strip.
 * Same stance ui-kit's own `OverlayPanel` takes.
 *
 * A **sub-theme** boundary (`subThemeScope(…)`) forwards its token as
 * region-only. A sub-theme restyles one region — the website's page type scale —
 * and a popover opened from that region is app UI, not more of the region, so a
 * popup wears the theme around the sub-theme. Content that is portaled but still
 * part of the region (an adaptive bar's items) keeps it.
 */
export function Theme({
  name,
  surface,
  as: Comp = "div",
  className,
  children,
  ref,
  ...rest
}: ThemeProps) {
  // The attribute is qualified by the plugin scope it is stamped in, so only
  // that scope's theme hosts paint it (`qualifyThemeScope`); the React
  // contexts below keep the bare token (config reads, icon scopes).
  const pluginScope = usePluginScopeId();
  const stamped =
    name === undefined ? undefined : qualifyThemeScope(pluginScope, name);
  return (
    <Comp
      ref={ref}
      {...rest}
      // Both after the passthrough: they ARE the primitive. A spread
      // `data-theme-scope` would silently retarget the boundary to a theme its
      // paint and its portal forward do not agree with — the exact split this
      // exists to close — and the `no-adhoc-theme-scope` rule bans writing one
      // at a call site anyway.
      // (No inline disable needed: `no-adhoc-theme-scope` exempts this
      // plugin's own files by path — it is the one sanctioned home for the raw
      // attribute, and `reportUnusedDisableDirectives` is an error.)
      data-theme-scope={stamped}
      // NO display class here, unlike `<Surface>`, and the difference is the
      // point. A surface is a contained BOX, so it owns `block` and `as` is
      // purely a tag choice. A theme boundary is a REGION of layout that already
      // exists — the sites are a flex `Stack` tab strip, a rail, a pane box —
      // and a forced `block` would win over the component's own `flex` (a
      // `className` handed to `<Stack>` is merged after Stack's own classes, so
      // tailwind-merge resolves in OUR favour) and break the flex chain. The
      // boundary paints and scopes; it does not decide what kind of box it is.
      // A site that renders an inline-by-default tag passes its own `block`.
      className={cn(THEME_SURFACES[surface], className)}
    >
      <PortalThemeScopeProvider scope={name}>
        <IconScopeProvider scope={name}>
          <AppThemeScopeProvider scope={name}>{children}</AppThemeScopeProvider>
        </IconScopeProvider>
      </PortalThemeScopeProvider>
    </Comp>
  );
}
