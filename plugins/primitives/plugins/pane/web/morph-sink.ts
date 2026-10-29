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
 * The Expand control's half of the morph: `attach` (a callback ref) goes on the
 * control, and
 * `morph(target)` is `target` with its plain activation run as a morph out of
 * the pane box that contains the control (found through the box's
 * `data-pane-id`, the attribute `PaneBox` stamps for DOM-walking readers) —
 * looked up at activation, never in render. The control's element is state,
 * not a `useRef`: it is captured by a closure built during render, which a ref
 * may not be. ⌘/middle-click still open
 * `href()` in a browser tab; with no box above the control, or no morph
 * installed, `open` runs as is.
 */
export function useMorphFromPane(): {
  attach: (control: HTMLButtonElement | null) => void;
  morph: (target: LinkTarget) => LinkTarget;
} {
  const [control, attach] = useState<HTMLButtonElement | null>(null);
  const morph = (target: LinkTarget): LinkTarget => ({
    href: target.href,
    open: () => {
      const from = control?.closest<HTMLElement>("[data-pane-id]");
      const run = paneMorphSink.peek();
      if (from == null || run === null) target.open();
      else run(from, target.open);
    },
  });
  return { attach, morph };
}
