import { type ReactNode, useMemo } from "react";
import { spaceLength } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { useReservesFloatingBar } from "@plugins/primitives/plugins/pane/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type {
  ToolbarArrangement,
  ToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { PillsToolbar } from "@plugins/primitives/plugins/data-view/web";

/** The gap between a pill and the surface's edges (and the aside). */
const GUTTER = "md";

/**
 * The DataView's own two-pill toolbar (`PillsToolbar`), floated over the view:
 * [title + views] top-left, past the surface's aside, and [search · controls
 * · actions | create] top-right. The band between them is the host's
 * click-through layer, so the view (a map) stays reachable around the pills;
 * each pill opts back into pointer events.
 */
function FloatingToolbar(parts: ToolbarParts): ReactNode {
  const { focusSearch, asideInset } = parts;
  // Surface-scoped, so two surfaces in two tabs never fight over `/`. A plain
  // key, so it yields to any focused text field (the `/` is typed there).
  const shortcuts = useMemo(
    () => [
      {
        id: "data-view.floating-toolbar.focus-search",
        keys: "/",
        label: "Focus search",
        handler: focusSearch,
      },
    ],
    [focusSearch],
  );
  useSurfaceShortcuts(shortcuts);

  // At the surface's top-right corner the band stands in for the pane header
  // the global floating bar would otherwise sit in: it reserves the bar's safe
  // area on the right and is the bar's anchor, so the bar is centred on this
  // band's line, level with the pills — the pane header's own rule.
  const reservesFloatingBar = useReservesFloatingBar();
  const gutter = spaceLength(GUTTER);
  return (
    <PillsToolbar
      {...parts}
      overlay
      className={cn(
        "py-md",
        reservesFloatingBar
          ? "pr-floating-bar-pane anchor-floating-bar-band"
          : "pr-md",
      )}
      // The left pill starts one gutter past the aside's floating card.
      style={{ paddingLeft: `calc(${asideInset} + ${gutter})` }}
    />
  );
}

/** The floating arrangement — pass as `<DataView toolbar={floatingToolbar}>`. */
export const floatingToolbar: ToolbarArrangement = {
  id: "floating",
  forms: { search: "filled", controls: "ghost", creators: "labelled" },
  component: FloatingToolbar,
  overlay: true,
};
