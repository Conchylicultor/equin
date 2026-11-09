import { useLayoutEffect, useRef } from "react";
import {
  paneThemeScope,
  usePaneTitle,
  type MatchEntry,
} from "@plugins/primitives/plugins/pane/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { BAR_FADE_MS } from "../layout";

const chevronRightIcon = symbol("chevron-right");

interface CollapsedBarProps {
  entry: MatchEntry;
  onExpand: () => void;
  /** The column just collapsed into this bar: fade it in as its box narrows. */
  fadeIn: boolean;
}

export function CollapsedBar({ entry, onExpand, fadeIn }: CollapsedBarProps) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!fadeIn) return;
    ref.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: BAR_FADE_MS,
      easing: "ease-out",
    });
  }, [fadeIn]);
  // The pane's own title (`Pane.define({ title })`), the same string its tab
  // shows. A column's entry is fixed for its life (keyed by instance), so the
  // pane's `title.text` hook order is stable.
  const title =
    usePaneTitle(entry.pane, entry.fullParams, entry.hint, entry.options) ??
    entry.pane.id;
  return (
    // A collapsed column is still this pane, so it wears the pane's own theme
    // (its home app's) exactly like the expanded body does — otherwise
    // collapsing a guest pane would snap its rail back to the host's palette.
    //
    // `sunken` is the recessed-well role this rail already meant. It paints an
    // OPAQUE `bg-muted`, where the rail used to paint `bg-muted/40`: a
    // translucent tint inside a theme boundary composites over whatever is
    // behind it, which is the HOST's canvas, so a collapsed guest pane's rail
    // blended its own muted over the host's background and landed on neither
    // theme. Going opaque is the deliberate visual change that fixes it.
    <Theme
      ref={ref}
      as="button"
      name={paneThemeScope(entry.pane)}
      surface="sunken"
      type="button"
      onClick={onExpand}
      aria-label={`Expand ${title}`}
      // The bar fills its column box — the same box the pane fills when
      // expanded, which narrows to 32px around it (or grows from it), so a
      // collapse or a zoom animates the box, never a second element. Its
      // content stays in a 32px strip at the box's start.
      //
      // `hover:bg-hover-fill` rather than the old `hover:bg-muted`, which is now
      // the base tone itself and would read as a dead control. `--hover-fill` is
      // the step off the background that the `sunken` bundle publishes for
      // exactly this — a small foreground tint over `--muted`, so it darkens
      // under light and lightens under dark at any preset, and it follows the
      // pane's own theme rather than being re-picked here.
      // eslint-disable-next-line layout/no-adhoc-layout -- fills miller's JS-sized column box
      className="h-full w-full min-w-0 shrink-0 border-r py-sm text-muted-foreground hover:bg-hover-fill hover:text-foreground"
    >
      {/* The bar's fixed 32px strip at its box's start. */}
      <Stack align="center" gap="sm" className="w-8">
        <Icon icon={chevronRightIcon} className="size-4" />
        {title && (
          <span
            style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
            className="truncate text-2xs font-medium"
          >
            {title}
          </span>
        )}
      </Stack>
    </Theme>
  );
}
