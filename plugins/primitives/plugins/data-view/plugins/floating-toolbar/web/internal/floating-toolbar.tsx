import { type ReactNode, useMemo } from "react";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { spaceLength } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import type {
  ToolbarArrangement,
  ToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";

/** The gap between a card and the surface's edges (and the aside). */
const GUTTER = "md";

/**
 * Two floating cards over the view: [title + view tabs] top-left, past the
 * surface's aside, and [search | controls | actions | create] top-right. The
 * band between them is the host's click-through layer, so the view (a map)
 * stays reachable around the cards; each card opts back into pointer events.
 */
function FloatingToolbar({
  title,
  switcher,
  search,
  focusSearch,
  controls,
  actions,
  creators,
  asideInset,
}: ToolbarParts): ReactNode {
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

  const gutter = spaceLength(GUTTER);
  return (
    <Line
      className="gap-sm p-md"
      // The left card starts one gutter past the aside's floating card.
      style={{ paddingLeft: `calc(${asideInset} + ${gutter})` }}
    >
      {/* The tabs card hugs its chips and is the one cell that gives: past
          its room the strip scrolls sideways inside the card rather than
          pushing the tools card off the surface. */}
      <Overlay.Interactive className={yieldClass("x")}>
        <Surface level="overlay" className="p-2xs">
          <Scroll axis="x" hideScrollbar>
            <Line className="gap-xs">
              {title}
              {switcher.strip}
            </Line>
          </Scroll>
        </Surface>
      </Overlay.Interactive>
      <Fill />
      <Overlay.Interactive className={rigidClass()}>
        <Surface level="overlay" className="p-2xs">
          <Line className="gap-2xs">
            {search}
            {controls}
            {/* eslint-disable-next-line row-actions/no-raw-actions-slot -- surface-level toolbar actions, one per DataView, not a per-row cluster */}
            {actions}
            {creators}
          </Line>
        </Surface>
      </Overlay.Interactive>
    </Line>
  );
}

/** The floating arrangement — pass as `<DataView toolbar={floatingToolbar}>`. */
export const floatingToolbar: ToolbarArrangement = {
  id: "floating",
  forms: { search: "field", controls: "ghost", creators: "labelled" },
  component: FloatingToolbar,
  overlay: true,
};
