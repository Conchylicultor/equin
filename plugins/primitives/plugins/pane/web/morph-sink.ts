import { useState } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";

/**
 * How a cross-app navigation out of a pane is animated: `open` (the navigation
 * itself) run as a morph out of `from`, the box of the pane it leaves.
 *
 * The pane layer knows which box the user expanded; only a higher layer knows
 * the app being swapped in and the tab it lands in. Hence a sink, like
 * `appNavSink`: `apps-core/pane-morph` installs the implementation, and a pane
 * without one (a test surface, a composition without it) simply navigates.
 * An implementation must ALWAYS run `open` — exactly once, synchronously or
 * from inside its transition — whether or not it animates.
 */
export interface PaneMorph {
  (from: HTMLElement, open: () => void): void;
}

export const paneMorphSink = defineInstallSink<PaneMorph>({
  name: "pane.morph",
  what: "the pane → app morph (installed by apps-core/pane-morph at Core.Root mount)",
});

/**
 * The control's half of a morph: `attach` (a callback ref) goes on the control,
 * and `morph(target)` is `target` with its plain activation run as a morph out
 * of the element `originOf(control)` names — looked up at activation, never in
 * render. The control's element is state, not a `useRef`: it is captured by a
 * closure built during render, which a ref may not be. ⌘/middle-click still
 * open `href()` in a browser tab; with no origin, or no morph installed,
 * `open` runs as is.
 */
function useMorphFrom(
  originOf: (control: HTMLButtonElement) => HTMLElement | null,
): {
  attach: (control: HTMLButtonElement | null) => void;
  morph: (target: LinkTarget) => LinkTarget;
} {
  const [control, attach] = useState<HTMLButtonElement | null>(null);
  const morph = (target: LinkTarget): LinkTarget => ({
    href: target.href,
    open: (gesture) => {
      const from = control === null ? null : originOf(control);
      const run = paneMorphSink.peek();
      if (from === null || run === null) target.open(gesture);
      else run(from, () => target.open(gesture));
    },
  });
  return { attach, morph };
}

const paneBoxOf = (control: HTMLElement): HTMLElement | null =>
  control.closest<HTMLElement>("[data-pane-id]");
/** Stamped on a box that should grow into the app a control inside it opens, instead of the (small) control itself. */
export const morphOriginProps = { "data-morph-origin": "" } as const;
const originBoxOrControl = (control: HTMLElement): HTMLElement =>
  control.closest<HTMLElement>("[data-morph-origin]") ?? control;

/**
 * The Expand control's half of the morph: the pane box that contains the
 * control (the `data-pane-id` element `PaneBox` stamps for DOM-walking
 * readers) is what grows into the new app.
 */
export function useMorphFromPane(): ReturnType<typeof useMorphFrom> {
  return useMorphFrom(paneBoxOf);
}

/**
 * An "Open in <App>" button's half of the morph: the BUTTON ITSELF is the
 * origin — or the nearest ancestor stamped with `morphOriginProps` (a map
 * block's box) — so the app it opens grows out of it to fill the surface. `attach` goes on the button; run the navigation as
 * `morph({ href, open }).open()`. The navigation may be reached late (after an
 * async step): the button, still mounted, is the origin when it runs.
 */
export function useMorphFromElement(): ReturnType<typeof useMorphFrom> {
  return useMorphFrom(originBoxOrControl);
}
