import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type React from "react";
import type { ReactNode } from "react";

/** Which edge(s) of the band carry its hairline. */
export type BandRule = "top" | "bottom" | "both";

const RULE_CLASS: Record<BandRule, string> = {
  top: "border-t",
  bottom: "border-b",
  both: "border-y",
};

export interface BandProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The hairline edge(s). A band is a strip BETWEEN content — it always has one. */
  rule: BandRule;
  children: ReactNode;
  /** Forwarded to the rendered element. */
  ref?: React.Ref<HTMLDivElement>;
}

/**
 * A rule-bearing strip in the middle of a region — a toolbar between two
 * lists, a summary over a log, a "3 more" line under a list.
 *
 * It bleeds its hairline to the region's edge and puts its own content on the
 * region's TEXT rail (`rail-band`): the rail itself in a plain region, one row
 * pad further in for a region holding padded rows (`rail-rows`) — so a band's
 * label lines up with the rows' text above and below it, whichever host it was
 * dropped in, and moving it to another host moves nothing. The block step is
 * fixed (`py-sm`): the strip declares no inset of its own to pick.
 *
 * Not for a surface's FIRST or LAST strip: that is the surface's own `header` /
 * `footer` (an overlay panel's, a `Column`'s), which also bleeds through the
 * surface's block padding — a band cannot know it is first, so it would sit
 * under that padding twice. Not for a box of ROWS either: rows already sit on
 * the rail and pad themselves; a band would indent them a second time.
 */
export function Band({ rule, children, className, ref, ...rest }: BandProps) {
  return (
    <div
      ref={ref}
      className={cn("rail-band py-sm", RULE_CLASS[rule], className)}
      {...rest}
    >
      {/* Republishes the band's padding as the rail, so a child can bleed to
          the region edge out of it (`rail-band-region`). */}
      <div className="rail-band-region">{children}</div>
    </div>
  );
}
