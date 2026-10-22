import { type ReactNode, useMemo } from "react";
import {
  cn,
  ControlSizeProvider,
  Separator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import type {
  ToolbarArrangement,
  ToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";

/**
 * Below this capsule width the divider and the row of control circles give way
 * to the folded controls (one circle), so filter and sort stay reachable in a
 * narrow pane. A container query on the capsule, not the viewport: the capsule
 * is as wide as its pane lets it be.
 */
const NARROW = "@max-[560px]/capsule:hidden";
const WIDE = "@min-[560px]/capsule:hidden";

/**
 * One centred pill: [view chip | search (the grow cell) | divider | control
 * circles | actions | round create]. The surface title is not drawn — a page
 * using the capsule states its own heading above it.
 */
function CapsuleToolbar({
  switcher,
  search,
  focusSearch,
  controls,
  foldedControls,
  actions,
  creators,
}: ToolbarParts): ReactNode {
  // Surface-scoped, so two capsules in two tabs never fight over `/`. A plain
  // key, so it yields to any focused text field (the `/` is typed there).
  const shortcuts = useMemo(
    () => [
      {
        id: "data-view.capsule-toolbar.focus-search",
        keys: "/",
        label: "Focus search",
        handler: focusSearch,
      },
    ],
    [focusSearch],
  );
  useSurfaceShortcuts(shortcuts);

  return (
    <Center axis="horizontal" className="py-sm rail-follow">
      {/* One padding on every side, and no fixed height: the pill is its
          controls plus that padding, so each round control (the chip, the
          circles, create) sits concentric in the pill — the same gap above,
          below and at the ends. A fixed height with a narrower inline pad
          left the chip's ends off-centre in the pill's round ends. */}
      <Surface
        level="raised"
        className="@container/capsule w-[min(620px,100%)] rounded-full p-sm shadow-none transition-colors focus-within:border-input"
      >
        <ControlSizeProvider size="md">
          <Line className="h-full gap-2xs">
            {switcher.chip}
            {/* The one grow cell: search takes whatever the rigid pieces leave. */}
            <Fill className="h-full">{search}</Fill>
            {/* A 20px box the line centres; the rule stretches to fill it.
                A fixed-height rule would itself be the flex item, where the
                vertical Separator's own `self-stretch` pins it to the top. */}
            <Center axis="horizontal" className={cn("h-5 px-xs", NARROW)}>
              <Separator orientation="vertical" className="bg-input" />
            </Center>
            <Line className={cn("gap-2xs", NARROW)}>{controls}</Line>
            <Line className={WIDE}>{foldedControls}</Line>
            {/* eslint-disable-next-line row-actions/no-raw-actions-slot -- surface-level toolbar actions, one per DataView, not a per-row cluster */}
            {actions}
            {creators}
          </Line>
        </ControlSizeProvider>
      </Surface>
    </Center>
  );
}

/** The capsule arrangement — pass as `<DataView toolbar={capsuleToolbar}>`. */
export const capsuleToolbar: ToolbarArrangement = {
  id: "capsule",
  forms: { search: "bare", controls: "round", creators: "round" },
  component: CapsuleToolbar,
  // The pill floats apart from what it filters. The mock puts its first tile's
  // top edge ~70px below the pill: this band's own 8px bottom (`py-sm`) + 50px
  // + the icons view's 12px tile padding. Above the spacing ramp's top step, so
  // a length rather than a step.
  spaceBelow: "50px",
};
