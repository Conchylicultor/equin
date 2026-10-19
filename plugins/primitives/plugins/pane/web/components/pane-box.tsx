import type { CSSProperties, Ref } from "react";
import { PortalForwardProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import type { PaneInternal } from "../pane";
import { PaneResolveGuard } from "./pane-resolve-guard";

/**
 * The theme scope a pane wears: its **home** app's, never the app that happens
 * to be hosting it.
 *
 * A pane is reusable chrome — the agent manager hosts the page detail beside a
 * conversation — and `Pane.define({ app })` already names the one app it belongs
 * to. Reading the scope off that declaration is what makes a page pane look like
 * Pages wherever it is opened, instead of taking on its host's palette.
 *
 * Note this only *tags* the subtree. Whether the tag changes anything is
 * theme-engine's business: an app that has forked its theme emits a matching
 * `[data-theme-scope="app:<id>"]` block (centrally, one per registered app), and
 * an app that has not emits nothing and inherits `:root` as before.
 */
export function paneThemeScope(pane: PaneInternal): string {
  return appThemeScope(pane.app.id);
}

interface PaneBoxProps {
  pane: PaneInternal;
  params: Record<string, string>;
  /** Sizing/role classes owned by the layout renderer that positions this box. */
  className?: string;
  style?: CSSProperties;
  /**
   * The box's element, for a layout renderer that measures it. Typed
   * `HTMLElement` rather than `HTMLDivElement` because the tag is `<Theme>`'s to
   * pick, not this box's to promise — a renderer reads geometry off it, never a
   * div-specific API.
   */
  ref?: Ref<HTMLElement>;
}

/**
 * The DOM box that **is** a pane — the single sanctioned way to paint one.
 *
 * A pane's box carries two ancestry-derived signals, and both have to be stamped
 * twice: once on the box for DOM-walking readers, and once as context for the
 * portaled content (popovers, menus, tooltips) that leaves the box behind:
 *
 *  - `data-pane-id` — which pane contains this element (render-loop attribution,
 *    overscroll-hint, the element picker, e2e).
 *  - `data-theme-scope` — whose theme this subtree wears ({@link paneThemeScope}).
 *
 * The theme half is exactly what `<Theme>` is: the attribute, the portal forward
 * that carries it, and the canvas it paints, as one thing that cannot be
 * half-assembled. The pane id has no such primitive — it is a second, unrelated
 * forwarded signal — so its two stampings stay written out here.
 *
 * `surface="canvas"` because the box PAINTS its canvas, it does not merely
 * resolve the token for it. Scoping `--background` here changes nothing on its
 * own: the element that fills the surface is the tab container, which sits ABOVE
 * this box and therefore resolves `--background` in the HOST app's scope. A
 * transparent pane then shows the host's canvas no matter whose theme its own
 * subtree carries. Same role the placement paints, so where scope and host agree
 * this is a no-op repaint.
 *
 * Layout renderers own where the box sits and how big it is (`className`,
 * `style`, `ref`); they do not own its identity. Bundling the stamping with the
 * render of the pane component itself is what keeps a new layout renderer from
 * silently shipping panes that report no pane id and inherit their host's theme
 * — there is no exported way to paint a pane without its box.
 */
export function PaneBox({ pane, params, className, style, ref }: PaneBoxProps) {
  return (
    <Theme
      ref={ref}
      name={paneThemeScope(pane)}
      surface="canvas"
      data-pane-id={pane.id}
      // `className` comes after the surface role inside `<Theme>`, so a pane's
      // own layout classes still win over the canvas bundle.
      className={className}
      style={style}
    >
      <PortalForwardProvider name="data-pane-id" value={pane.id}>
        <PaneResolveGuard pane={pane} params={params} />
      </PortalForwardProvider>
    </Theme>
  );
}
