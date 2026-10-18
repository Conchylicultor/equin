import type { IconRef } from "@plugins/ui/plugins/icons/core";
import {
  createContext,
  createElement,
  useContext,
  type ComponentType,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";

/**
 * How a placement's per-tab container is POSITIONED — a role, not a recipe. The
 * host (`SurfaceBody`) owns the class each role maps to, so a mode states the
 * geometry it wants ONCE and cannot spell it two ways that disagree:
 *
 *  - `pane` — fills the surface area it is rendered in (docked's full-bleed tab).
 *  - `window` — a free box inside the surface, positioned by the mode's own
 *    `Chrome` via the keep-alive style channel, and clipped to its own corner.
 *  - `viewport` — positions against the VIEWPORT (`position: fixed`), so the
 *    surface must be neither its containing block nor its stacking context:
 *    while such a mode is active the surface backdrop drops its `transform`,
 *    which is what lets the container reach the full window AND lets its
 *    `z-overlay` out-rank the app rail's `z-nav` instead of being compared only
 *    against its siblings inside the surface. The tab never moves — moving it is
 *    what would remount it.
 */
export type PlacementFrame = "pane" | "window" | "viewport";

/**
 * Props handed to a placement's optional {@link PlacementDef.Chrome}. The Chrome
 * is a *sibling* overlay of the keep-alive `TabSurface` (never a parent), so it
 * may mount/unmount freely on placement change without remounting the tab.
 */
export interface PlacementChromeProps {
  tabId: string;
  appId: string;
  title: string | undefined;
  focused: boolean;
  /**
   * True while this tab has left the store but is retained by the host for its
   * exit tween (see {@link PlacementDef.exitDurationMs}). Placements without an
   * `exitDurationMs` never see `true` — their tabs unmount instantly on close.
   */
  exiting: boolean;
  onClose: () => void;
  /** Return the surface to the mode it was in before this one (solo's exit). */
  onExit: () => void;
}

/**
 * A surface-mode descriptor — the contribution to {@link Surface.Placement}.
 * Each mode (docked / floating / solo …) is a self-contained sub-plugin that
 * contributes exactly one of these. The surface is in EXACTLY ONE mode at a
 * time (per-surface, never per-tab), and renders every open tab under that one
 * descriptor — so two modes can never be visible at once (e.g. a solo app and a
 * floating window). Almost all of it is *data*: the host (`SurfaceBody`) keeps
 * one stable container per tab and only varies the descriptor's class / chrome,
 * so a mode switch re-positions the still-mounted tabs rather than remounting
 * them (keep-alive).
 *
 * What preserves the mount is narrow and worth stating: the container renders at
 * the same position in the React tree, as the same element type, under an
 * unchanged parent chain. Only its props differ. A descriptor may therefore
 * never ask the host to render a tab somewhere else — a branch that swaps a
 * plain element for a portal (or swaps a portal's container) is reconciled as a
 * different child, and React deletes the subtree and builds a new one.
 *
 * The optional {@link PlacementDef.Chrome} is the escape hatch for dynamic,
 * hook-derived presentation (floating's geometry box): it runs its own hooks and
 * pushes inline style up to the host-owned container via
 * {@link usePlacementStyle}, so the dynamic style lives in the mode plugin yet
 * styles the shared container — without the host calling a per-mode hook in a
 * loop (which would trip `react-hooks/rules-of-hooks`).
 */
export interface PlacementDef {
  /** Stable id; the value stored as the surface mode. */
  id: string;
  /** Control tooltip / label. */
  label: string;
  /** Icon for the mode control. */
  icon: IconRef;
  /** Control order + default resolution (lowest order acts as default fallback). */
  order: number;
  /** Exactly one mode should set this — the registry's default (boot) mode. */
  default?: boolean;

  /**
   * Defer a closed tab's teardown by N ms while this mode is active, so this
   * mode's {@link PlacementDef.Chrome} can play an exit tween before the host
   * truly unmounts it. Omitted ⇒ instant unmount (docked / solo keep the current
   * behavior — a closed tab vanishes immediately).
   */
  exitDurationMs?: number;

  /**
   * How the per-tab container is POSITIONED, as a role the host maps to
   * mechanics. A role cannot disagree with itself — which is the whole point:
   * the geometry and its consequences (the backdrop's dropped `transform`, the
   * runtime viewport-escape audit) are read off this ONE field, so a mode can no
   * longer say `fixed` in one place and forget to say what it means in another.
   */
  frame: PlacementFrame;
  /**
   * EXTRA FRAME CHROME ONLY — the border and radius a window frame needs, and
   * nothing else. Not the app's canvas: the container is a `<Theme
   * surface="canvas">`, so every mode's tab is painted with the app's own
   * background whether or not the mode remembered to say so. That is why this is
   * optional and why docked / solo now set nothing at all — a background here
   * would be a second, unthemed answer to a question the boundary already
   * answers. Geometry belongs to {@link PlacementDef.frame}. `ClassName` makes
   * that a checked contract rather than a comment: the value comes out of
   * `cn()`, so `no-adhoc-layout` reads its tokens and rejects any positioning /
   * clipping / flow class that tries to sneak back in.
   */
  frameClassName?: ClassName;
  /**
   * Paint EVERY tab in this mode, not just the focused one (windows mode). When
   * false (docked / solo) only the focused tab is painted; the rest stay mounted
   * (keep-alive) but hidden — so a non-focused tab can never overlap.
   */
  visibleWhenUnfocused?: boolean;

  /**
   * Optional sibling overlay. NEVER a parent of `TabSurface`. May push dynamic
   * inline container/inset style to the host via {@link usePlacementStyle} —
   * this is how floating's geometry box lives in the floating plugin, not the
   * shared host.
   */
  Chrome?: ComponentType<PlacementChromeProps>;
  /** Rendered once while this mode is active (e.g. desktop wallpaper). */
  Backdrop?: ComponentType;
  /**
   * Optional overlay rendered ONCE, ABOVE all tab containers, while this mode is
   * active. Symmetric with {@link PlacementDef.Backdrop} (which renders below).
   * Receives two id sets so it stays decoupled from the host:
   *  - `tabIds` — the LIVE tabs only (still in the store). Dock / cycle act on
   *    these, so a closing window's chip disappears immediately and it can't be
   *    cycled or docked while it plays its exit tween.
   *  - `retainedTabIds` — the LIVE + EXITING tabs (live plus those retained for
   *    an exit tween). Store-prune keys on this so a window is not pruned out from
   *    under its still-animating Chrome.
   */
  Foreground?: ComponentType<{ tabIds: string[]; retainedTabIds: string[] }>;

  // Capabilities consumed generically by apps-side chrome (no string compares):
  /** This mode's chrome wears the app theme (docked / solo). */
  themeScope?: "app";
  /** `+` reads as "new window" while the surface is in this mode (windows mode). */
  newTabFollows?: boolean;
  /**
   * This mode draws its own frame (solo, the desktop): the layout mounts no tab
   * bar and no app rail while it is active, and the global action bar floats as
   * its dot instead of docking into the absent tab bar.
   */
  ownsChrome?: boolean;
  /**
   * The surface may hold no tab at all while in this mode (the desktop: closing
   * the last window leaves a clear desktop). Every other mode keeps at least one
   * tab — closing the last one, or leaving an empty surface for such a mode,
   * seeds the composition's home app.
   */
  allowsEmpty?: boolean;
}

/**
 * The single placement registry. Each placement sub-plugin contributes one
 * {@link PlacementDef}; `SurfaceBody` dispatches every open tab through the
 * matching descriptor, and the placement control derives its options from the
 * sorted contributions. `apps` never names a specific placement — it reads the
 * derived capabilities back through the apps-owned placement-capability registry.
 */
export const Surface = {
  Placement: defineSlot<PlacementDef>(),
};

/**
 * The keep-alive style channel. The host (`TabContainer`) owns one stable
 * container per tab and provides this API; the *active* placement's {@link
 * PlacementDef.Chrome} consumes it to push dynamic inline style up to that
 * container — without remounting `TabSurface`.
 *
 * Intent: floating's `Chrome` calls {@link usePlacementStyle}, computes its
 * geometry box from its own hooks, and pushes it via `setContainerStyle` in a
 * `useLayoutEffect` (clearing it on cleanup so docked falls back to the host's
 * visibility gate). `setContentInsetStyle` pushes the titlebar inset; the
 * pointer-down-capture handler plumbs floating's raise-to-front.
 */
export interface PlacementStyleApi {
  /** Push (or clear, with `null`) the container's dynamic inline style. */
  setContainerStyle(style: CSSProperties | null): void;
  /** Push (or clear, with `null`) the content inset inside the container. */
  setContentInsetStyle(style: CSSProperties | null): void;
  /** Wire (or clear, with `null`) a pointer-down-capture on the container. */
  setContainerPointerDownCapture(
    handler: ((e: PointerEvent) => void) | null,
  ): void;
}

const PlacementStyleContext = createContext<PlacementStyleApi | null>(null);

/** Host wraps the active placement's `Chrome` with this to expose the channel. */
export function PlacementStyleProvider({
  value,
  children,
}: {
  value: PlacementStyleApi;
  children: ReactNode;
}): ReactNode {
  return createElement(PlacementStyleContext.Provider, { value }, children);
}

/**
 * Read the keep-alive style channel from inside a placement's `Chrome`. Throws
 * if used outside {@link PlacementStyleProvider} (a real bug — `Chrome` is only
 * ever rendered by the host inside the provider).
 */
export function usePlacementStyle(): PlacementStyleApi {
  const ctx = useContext(PlacementStyleContext);
  if (!ctx) {
    throw new Error(
      "usePlacementStyle() called outside <PlacementStyleProvider>.",
    );
  }
  return ctx;
}
